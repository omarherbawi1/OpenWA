import * as fs from 'node:fs';
import * as path from 'node:path';
import * as qrcode from 'qrcode';
import type { CallInfo, EndCallReason } from '@zapo-js/voip';
import { ProxyAgent as UndiciProxyAgent } from 'undici';
import type { WaConnectionEvent, WaIncomingMessageEvent, WaStore, WaStoredMessageRecord } from 'zapo-js';
import type { WaProxyTransport } from 'zapo-js/transport';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { createLogger } from '../../common/services/logger.service';
import { parseWaId, toNeutralJid, userPart } from '../identity/wa-id';
import {
  Catalog,
  Channel,
  ChannelMessage,
  ChatState,
  ChatSummary,
  Contact,
  ContactCard,
  EngineEventCallbacks,
  EngineStatus,
  Group,
  GroupInfo,
  IncomingMessage,
  Label,
  LocationInput,
  MediaInput,
  MessageReaction,
  MessageResult,
  PaginatedProducts,
  PollInput,
  Product,
  ProductQueryOptions,
  Status,
  StatusPostOptions,
  StatusResult,
} from '../interfaces/whatsapp-engine.interface';
import {
  IVoiceCallEngine,
  VoiceCall,
  VoiceCallEvent,
  VoiceCallEventListener,
  VoiceCallState,
} from '../interfaces/voice-call-engine.interface';

type ZapoModule = typeof import('zapo-js');
type ZapoSqliteModule = typeof import('@zapo-js/store-sqlite');
type ZapoVoipModule = typeof import('@zapo-js/voip');

export interface ZapoLibraries {
  zapo: ZapoModule;
  sqlite: ZapoSqliteModule;
  voip: ZapoVoipModule;
}

export type ZapoLibraryLoader = () => Promise<ZapoLibraries>;

const loadZapoLibraries: ZapoLibraryLoader = async () => {
  const [zapo, sqlite, voip] = await Promise.all([
    import('zapo-js'),
    import('@zapo-js/store-sqlite'),
    import('@zapo-js/voip'),
  ]);
  return { zapo, sqlite, voip };
};

export interface ZapoAdapterConfig {
  sessionId: string;
  authDir: string;
  proxyUrl?: string;
  proxyType?: 'http' | 'https' | 'socks4' | 'socks5';
}

type ManagedProxyTransport = WaProxyTransport & {
  close?: () => Promise<void>;
  destroy?: () => void;
};

async function createProxyTransport(config: ZapoAdapterConfig): Promise<ManagedProxyTransport | undefined> {
  if (!config.proxyUrl) return undefined;
  if (config.proxyType === 'socks4' || config.proxyType === 'socks5') {
    // socks-proxy-agent is ESM-only. A native dynamic import keeps the
    // CommonJS Jest runtime and HTTP-only deployments from loading it eagerly.
    const { SocksProxyAgent } = await import('socks-proxy-agent');
    return new SocksProxyAgent(config.proxyUrl);
  }
  return new UndiciProxyAgent(config.proxyUrl);
}

function createZapoClient(
  libraries: ZapoLibraries,
  store: WaStore,
  sessionId: string,
  proxyTransport?: WaProxyTransport,
) {
  const plugins = [libraries.voip.voipPlugin({ maxConcurrentCalls: 1, logLevel: 'warn' })] as const;
  return new libraries.zapo.WaClient(
    {
      store,
      sessionId,
      plugins,
      ...(proxyTransport ? { proxy: { ws: proxyTransport } } : {}),
      deviceBrowser: 'chrome',
      // Shown as the linked-device name in WhatsApp. Override with ZAPO_DEVICE_OS_DISPLAY_NAME.
      deviceOsDisplayName:
        process.env.ZAPO_DEVICE_OS_DISPLAY_NAME?.trim() || 'Chrome',
      requireFullSync: false,
      recoverFromClientTooOld: true,
      history: { enabled: true, requireFullSync: false },
      logoutStoreClear: {
        auth: true,
        signal: true,
        preKey: true,
        session: true,
        identity: true,
        senderKey: true,
        appState: true,
        retry: true,
        groupMetadata: true,
        deviceList: true,
        messages: true,
        messageSecret: true,
        threads: true,
        contacts: true,
        privacyToken: true,
      },
    },
    libraries.zapo.createNoopLogger('warn'),
  );
}

type ZapoClient = ReturnType<typeof createZapoClient>;

/**
 * Zapo linked-device engine.
 *
 * The first slice deliberately exposes only the operations needed for a viable
 * OpenWA session plus the complete real-time voice-call contract. Every other
 * IWhatsAppEngine method fails explicitly with EngineNotSupportedError.
 */
export class ZapoAdapter implements IVoiceCallEngine {
  private readonly logger = createLogger('ZapoAdapter');
  private readonly authPath: string;
  private readonly statePath: string;
  private proxyTransport?: ManagedProxyTransport;
  private readonly voiceListeners = new Set<VoiceCallEventListener>();
  private readonly voicePeerIds = new Map<string, string>();
  private readonly voicePeerResolutions = new Map<string, Promise<string | undefined>>();
  private voiceEventQueue: Promise<void> = Promise.resolve();

  private libraries: ZapoLibraries | null = null;
  private store: WaStore | null = null;
  private client: ZapoClient | null = null;
  private clientPromise: Promise<void> | null = null;
  private connectPromise: Promise<void> | null = null;
  private loggedOutCleanupPromise: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private qrGeneration = 0;
  private intentionalClose = false;
  private pairingReady = false;
  private readyNotified = false;
  private proxyClosed = false;

  private status = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private callbacks: EngineEventCallbacks = {};

  constructor(
    private readonly config: ZapoAdapterConfig,
    private readonly libraryLoader: ZapoLibraryLoader = loadZapoLibraries,
  ) {
    this.authPath = path.join(config.authDir, config.sessionId);
    this.statePath = path.join(this.authPath, 'state.sqlite');
  }

  // --------------------------------------------------------------------------
  // Lifecycle and identity
  // --------------------------------------------------------------------------

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.intentionalClose = false;
    this.setStatus(EngineStatus.INITIALIZING);

    try {
      await this.ensureClient();
      // WaClient.connect() deliberately stays pending throughout first-time
      // pairing. Do not make SessionService.start() wait for a QR scan (and
      // eventually hit its initialization timeout); events drive the engine
      // through QR_READY/AUTHENTICATING/READY while the connection continues.
      this.beginConnect();
    } catch (error) {
      if (this.intentionalClose) {
        return;
      }
      this.setStatus(EngineStatus.FAILED);
      const message = this.errorMessage(error);
      this.callbacks.onError?.(message);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.lifecycleGeneration += 1;
    const pendingCleanup = this.loggedOutCleanupPromise;
    if (pendingCleanup) await pendingCleanup;
    const client = this.client;
    try {
      await client?.disconnect();
    } finally {
      client?.removeAllListeners();
      this.client = null;
      this.clientPromise = null;
      this.connectPromise = null;
      await this.closeStore();
      this.libraries = null;
      await this.closeProxyTransport();
      this.resetRuntimeState();
    }
  }

  async logout(): Promise<void> {
    this.intentionalClose = true;
    this.lifecycleGeneration += 1;

    const client = this.client;
    if (client?.getCredentials()?.meJid) {
      try {
        await client.logout();
      } catch (error) {
        this.logger.warn('Zapo server logout failed; clearing local session state', {
          action: 'zapo_logout_failed',
          sessionId: this.config.sessionId,
          error: this.errorMessage(error),
        });
      }
    }

    if (client) {
      try {
        await client.disconnect();
      } catch (error) {
        this.logger.warn('Zapo disconnect after logout failed', {
          action: 'zapo_logout_disconnect_failed',
          sessionId: this.config.sessionId,
          error: this.errorMessage(error),
        });
      }
    }

    await this.clearLoggedOutRuntime();
    await this.closeProxyTransport();
  }

  async destroy(): Promise<void> {
    try {
      await this.disconnect();
    } finally {
      await this.closeStore();
      this.client = null;
      this.libraries = null;
      this.voiceListeners.clear();
      await this.closeProxyTransport();
    }
  }

  forceDestroy(): Promise<void> {
    // Zapo owns no child browser process. Closing its socket/store is the
    // strongest process-local teardown available.
    return this.destroy();
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    await this.ensureClient();
    if (!this.client || this.status === EngineStatus.DISCONNECTED || this.status === EngineStatus.FAILED) {
      throw new EngineNotReadyError('Cannot request a pairing code before the Zapo engine is connecting.');
    }
    if (!this.pairingReady) {
      throw new EngineNotReadyError('Zapo is not ready for pairing yet. Wait for a QR code and try again.');
    }
    return this.client.auth.requestPairingCode(phoneNumber.replace(/\D/g, ''));
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  // --------------------------------------------------------------------------
  // Viable messaging/contact/chat slice
  // --------------------------------------------------------------------------

  async sendTextMessage(chatId: string, text: string, mentions?: string[]): Promise<MessageResult> {
    const client = this.readyClient();
    const nativeChatId = this.toNativeJid(chatId);
    const result = await client.message.send(
      nativeChatId,
      { type: 'text', text },
      mentions?.length ? { mentions: mentions.map(jid => this.toNativeJid(jid)) } : undefined,
    );
    const timestamp = this.resultTimestamp(result.ack.t);

    this.callbacks.onMessageCreate?.({
      id: result.id,
      from: this.selfNeutralJid(),
      to: toNeutralJid(nativeChatId),
      chatId: toNeutralJid(nativeChatId),
      body: text,
      type: 'text',
      timestamp,
      fromMe: true,
      isGroup: nativeChatId.endsWith('@g.us'),
      ...(mentions?.length ? { mentionedIds: mentions.map(jid => toNeutralJid(jid)) } : {}),
    });

    return { id: result.id, timestamp };
  }

  async checkNumberExists(number: string): Promise<boolean> {
    return (await this.lookupNumber(number))?.exists === true;
  }

  async getNumberId(number: string): Promise<string | null> {
    const result = await this.lookupNumber(number);
    return result?.exists ? toNeutralJid(result.phoneJid) : null;
  }

  async resolveContactPhone(contactId: string): Promise<string | null> {
    const parsed = parseWaId(contactId);
    if (parsed.kind === 'user') {
      return parsed.userPart;
    }
    if (parsed.kind !== 'lid' || !this.store) {
      return null;
    }

    const contact = await this.store.session(this.config.sessionId).contacts.getByJid(this.toNativeJid(contactId));
    return contact?.phoneNumber ? userPart(contact.phoneNumber) : null;
  }

  async sendSeen(chatId: string): Promise<boolean> {
    const client = this.readyClient();
    const nativeChatId = this.toNativeJid(chatId);
    const messages = await this.store?.session(this.config.sessionId).messages.listByThread(nativeChatId, 50);
    const latestIncoming = messages?.find(message => !message.fromMe);
    if (!latestIncoming) {
      return false;
    }

    await client.message.sendReceipt(nativeChatId, latestIncoming.id, {
      type: 'read',
      ...(nativeChatId.endsWith('@g.us') && (latestIncoming.participantJid || latestIncoming.senderJid)
        ? { participant: latestIncoming.participantJid ?? latestIncoming.senderJid }
        : {}),
    });
    await client.chat.setChatRead(nativeChatId, true);
    return true;
  }

  async markUnread(chatId: string): Promise<boolean> {
    await this.readyClient().chat.setChatRead(this.toNativeJid(chatId), false);
    return true;
  }

  async deleteChat(chatId: string): Promise<boolean> {
    await this.readyClient().chat.deleteChat(this.toNativeJid(chatId));
    return true;
  }

  async sendChatState(chatId: string, state: ChatState): Promise<void> {
    const client = this.readyClient();
    try {
      await client.presence.sendChatstate(
        this.toNativeJid(chatId),
        state === 'paused'
          ? { state: 'paused' }
          : state === 'recording'
            ? { state: 'composing', media: 'audio' }
            : { state: 'composing' },
      );
    } catch (error) {
      // Presence is advisory. Match the other adapters by keeping a failed
      // typing indicator off the message/API failure path.
      this.logger.warn(`Could not set Zapo chat state '${state}' (best-effort)`, {
        action: 'zapo_chat_state_failed',
        chatId,
        error: this.errorMessage(error),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Real-time voice calls
  // --------------------------------------------------------------------------

  async startVoiceCall(peerId: string): Promise<VoiceCall> {
    const voip = this.readyVoip();
    const nativePeerId = this.toNativeJid(peerId);
    const callId = await voip.startCall({ peerJid: nativePeerId, isVideo: false });
    this.voicePeerIds.set(callId, toNeutralJid(nativePeerId));
    const call = voip.getCall(callId);
    if (!call) {
      this.voicePeerIds.delete(callId);
      throw new Error(`Zapo did not retain newly-created call ${callId}`);
    }
    return this.mapVoiceCall(call);
  }

  async acceptVoiceCall(callId: string): Promise<void> {
    await this.readyVoip().acceptCall(callId);
  }

  async rejectVoiceCall(callId: string, reason?: string): Promise<void> {
    const libraries = this.requireLibraries();
    await this.readyVoip().rejectCall(callId, this.toEndCallReason(reason, libraries.voip.EndCallReason.Declined));
  }

  async endVoiceCall(callId: string, reason?: string): Promise<void> {
    const libraries = this.requireLibraries();
    await this.readyVoip().endCall(callId, this.toEndCallReason(reason, libraries.voip.EndCallReason.UserEnded));
  }

  setVoiceCallMuted(callId: string, muted: boolean): void {
    this.readyVoip().setMute(callId, muted);
  }

  setVoiceCallExternalAudio(callId: string, enabled: boolean): void {
    this.readyVoip().setExternalAudioMode(callId, enabled);
  }

  feedVoiceCallAudio(callId: string, pcm: Float32Array): number {
    return this.readyVoip().feedLiveAudio(callId, pcm);
  }

  getVoiceCallAudioWatermarks(): { pauseMs: number; resumeMs: number } {
    return this.readyVoip().getFeedWatermarksMs();
  }

  getVoiceCall(callId: string): VoiceCall | null {
    if (this.status !== EngineStatus.READY || !this.client) {
      return null;
    }
    const call = this.client.voip.getCall(callId);
    return call ? this.mapVoiceCall(call) : null;
  }

  getVoiceCalls(): readonly VoiceCall[] {
    if (this.status !== EngineStatus.READY || !this.client) {
      return [];
    }
    return this.client.voip.getCalls().map(call => this.mapVoiceCall(call));
  }

  onVoiceCallEvent(listener: VoiceCallEventListener): () => void {
    this.voiceListeners.add(listener);
    return () => {
      this.voiceListeners.delete(listener);
    };
  }

  // --------------------------------------------------------------------------
  // Explicitly unsupported IWhatsAppEngine operations
  // --------------------------------------------------------------------------

  /* eslint-disable @typescript-eslint/no-unused-vars */
  sendImageMessage(_chatId: string, _media: MediaInput): Promise<MessageResult> {
    return this.unsupported('sendImageMessage');
  }

  sendVideoMessage(_chatId: string, _media: MediaInput): Promise<MessageResult> {
    return this.unsupported('sendVideoMessage');
  }

  sendAudioMessage(_chatId: string, _media: MediaInput): Promise<MessageResult> {
    return this.unsupported('sendAudioMessage');
  }

  sendDocumentMessage(_chatId: string, _media: MediaInput): Promise<MessageResult> {
    return this.unsupported('sendDocumentMessage');
  }

  sendLocationMessage(_chatId: string, _location: LocationInput): Promise<MessageResult> {
    return this.unsupported('sendLocationMessage');
  }

  sendContactMessage(_chatId: string, _contact: ContactCard): Promise<MessageResult> {
    return this.unsupported('sendContactMessage');
  }

  sendStickerMessage(_chatId: string, _media: MediaInput): Promise<MessageResult> {
    return this.unsupported('sendStickerMessage');
  }

  sendPollMessage(_chatId: string, _poll: PollInput): Promise<MessageResult> {
    return this.unsupported('sendPollMessage');
  }

  replyToMessage(_chatId: string, _quotedMsgId: string, _text: string): Promise<MessageResult> {
    return this.unsupported('replyToMessage');
  }

  forwardMessage(_fromChatId: string, _toChatId: string, _messageId: string): Promise<MessageResult> {
    return this.unsupported('forwardMessage');
  }

  reactToMessage(_chatId: string, _messageId: string, _emoji: string): Promise<void> {
    return this.unsupported('reactToMessage');
  }

  getMessageReactions(_chatId: string, _messageId: string): Promise<MessageReaction[]> {
    return this.unsupported('getMessageReactions');
  }

  getContacts(): Promise<Contact[]> {
    return this.unsupported('getContacts');
  }

  getContactById(_contactId: string): Promise<Contact | null> {
    return this.unsupported('getContactById');
  }

  getGroups(): Promise<Group[]> {
    return this.unsupported('getGroups');
  }

  getGroupInfo(_groupId: string): Promise<GroupInfo | null> {
    return this.unsupported('getGroupInfo');
  }

  createGroup(_name: string, _participants: string[]): Promise<Group> {
    return this.unsupported('createGroup');
  }

  addParticipants(_groupId: string, _participants: string[]): Promise<void> {
    return this.unsupported('addParticipants');
  }

  removeParticipants(_groupId: string, _participants: string[]): Promise<void> {
    return this.unsupported('removeParticipants');
  }

  promoteParticipants(_groupId: string, _participants: string[]): Promise<void> {
    return this.unsupported('promoteParticipants');
  }

  demoteParticipants(_groupId: string, _participants: string[]): Promise<void> {
    return this.unsupported('demoteParticipants');
  }

  leaveGroup(_groupId: string): Promise<void> {
    return this.unsupported('leaveGroup');
  }

  setGroupSubject(_groupId: string, _subject: string): Promise<void> {
    return this.unsupported('setGroupSubject');
  }

  setGroupDescription(_groupId: string, _description: string): Promise<void> {
    return this.unsupported('setGroupDescription');
  }

  getGroupInviteCode(_groupId: string): Promise<string> {
    return this.unsupported('getGroupInviteCode');
  }

  revokeGroupInviteCode(_groupId: string): Promise<string> {
    return this.unsupported('revokeGroupInviteCode');
  }

  deleteMessage(_chatId: string, _messageId: string, _forEveryone?: boolean): Promise<void> {
    return this.unsupported('deleteMessage');
  }

  async getChatHistory(chatId: string, limit = 50, _includeMedia = false): Promise<IncomingMessage[]> {
    this.readyClient();
    const sessionStore = this.store?.session(this.config.sessionId);
    if (!sessionStore) return [];
    const records = await sessionStore.messages.listByThread(this.toNativeJid(chatId), limit);
    return records
      .map(record => this.mapStoredMessage(record))
      .filter((message): message is IncomingMessage => message !== null)
      .sort((left, right) => left.timestamp - right.timestamp);
  }

  getProfilePicture(_contactId: string): Promise<string | null> {
    return this.unsupported('getProfilePicture');
  }

  blockContact(_contactId: string): Promise<void> {
    return this.unsupported('blockContact');
  }

  unblockContact(_contactId: string): Promise<void> {
    return this.unsupported('unblockContact');
  }

  getLabels(): Promise<Label[]> {
    return this.unsupported('getLabels');
  }

  getLabelById(_labelId: string): Promise<Label | null> {
    return this.unsupported('getLabelById');
  }

  getChatLabels(_chatId: string): Promise<Label[]> {
    return this.unsupported('getChatLabels');
  }

  addLabelToChat(_chatId: string, _labelId: string): Promise<void> {
    return this.unsupported('addLabelToChat');
  }

  removeLabelFromChat(_chatId: string, _labelId: string): Promise<void> {
    return this.unsupported('removeLabelFromChat');
  }

  getSubscribedChannels(): Promise<Channel[]> {
    return this.unsupported('getSubscribedChannels');
  }

  getChannelById(_channelId: string): Promise<Channel | null> {
    return this.unsupported('getChannelById');
  }

  subscribeToChannel(_inviteCode: string): Promise<Channel> {
    return this.unsupported('subscribeToChannel');
  }

  unsubscribeFromChannel(_channelId: string): Promise<void> {
    return this.unsupported('unsubscribeFromChannel');
  }

  getChannelMessages(_channelId: string, _limit?: number): Promise<ChannelMessage[]> {
    return this.unsupported('getChannelMessages');
  }

  getContactStatuses(): Promise<Status[]> {
    return this.unsupported('getContactStatuses');
  }

  getContactStatus(_contactId: string): Promise<Status[]> {
    return this.unsupported('getContactStatus');
  }

  postTextStatus(_text: string, _options: StatusPostOptions): Promise<StatusResult> {
    return this.unsupported('postTextStatus');
  }

  postImageStatus(_media: MediaInput, _options: StatusPostOptions): Promise<StatusResult> {
    return this.unsupported('postImageStatus');
  }

  postVideoStatus(_media: MediaInput, _options: StatusPostOptions): Promise<StatusResult> {
    return this.unsupported('postVideoStatus');
  }

  deleteStatus(_statusId: string): Promise<void> {
    return this.unsupported('deleteStatus');
  }

  getCatalog(): Promise<Catalog | null> {
    return this.unsupported('getCatalog');
  }

  getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {
    return this.unsupported('getProducts');
  }

  getProduct(_productId: string): Promise<Product | null> {
    return this.unsupported('getProduct');
  }

  sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {
    return this.unsupported('sendProduct');
  }

  sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    return this.unsupported('sendCatalog');
  }

  async getChats(): Promise<ChatSummary[]> {
    this.readyClient();
    const sessionStore = this.store?.session(this.config.sessionId);
    if (!sessionStore) return [];
    const threads = await sessionStore.threads.list();
    const summaries = await Promise.all(
      threads
        .filter(thread => thread.jid !== 'status@broadcast' && !thread.jid.endsWith('@newsletter'))
        .map(async thread => {
          const [latest] = await sessionStore.messages.listByThread(thread.jid, 1);
          const latestMessage = latest ? this.mapStoredMessage(latest) : null;
          const contact = await sessionStore.contacts.getByJid(thread.jid).catch(() => null);
          const id = toNeutralJid(thread.jid);
          return {
            id,
            name: thread.name ?? contact?.displayName ?? contact?.pushName ?? id,
            isGroup: thread.jid.endsWith('@g.us'),
            unreadCount: thread.unreadCount ?? 0,
            timestamp: latestMessage?.timestamp ?? 0,
            ...(latestMessage?.body ? { lastMessage: latestMessage.body } : {}),
          };
        }),
    );
    return summaries;
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private async ensureClient(): Promise<void> {
    if (this.client) {
      return;
    }
    if (this.clientPromise) {
      return this.clientPromise;
    }

    const pending = this.createClient();
    const tracked = pending.finally(() => {
      if (this.clientPromise === tracked) this.clientPromise = null;
    });
    this.clientPromise = tracked;
    return tracked;
  }

  private async createClient(): Promise<void> {
    const generation = this.lifecycleGeneration;
    await fs.promises.mkdir(this.authPath, { recursive: true });
    const libraries = await this.libraryLoader();
    if (!this.isLifecycleCurrent(generation)) return;

    const backend = libraries.sqlite.createSqliteStore({
      path: this.statePath,
      pragmas: { journal_mode: 'WAL', synchronous: 'NORMAL' },
    });
    const store = libraries.zapo.createStore({
      backends: { sqlite: backend },
      providers: {
        auth: 'sqlite',
        signal: 'sqlite',
        preKey: 'sqlite',
        session: 'sqlite',
        identity: 'sqlite',
        senderKey: 'sqlite',
        appState: 'sqlite',
        privacyToken: 'sqlite',
        messages: 'sqlite',
        threads: 'sqlite',
        contacts: 'sqlite',
      },
      cacheProviders: {
        retry: 'sqlite',
        groupMetadata: 'sqlite',
        deviceList: 'sqlite',
        messageSecret: 'sqlite',
      },
    });

    try {
      if (!this.isLifecycleCurrent(generation)) {
        await store.destroy().catch(() => undefined);
        return;
      }
      const proxyTransport = await createProxyTransport(this.config);
      if (!this.isLifecycleCurrent(generation)) {
        this.proxyTransport = proxyTransport;
        this.proxyClosed = false;
        await this.closeProxyTransport();
        await store.destroy().catch(() => undefined);
        return;
      }
      this.proxyTransport = proxyTransport;
      this.proxyClosed = false;
      const client = createZapoClient(libraries, store, this.config.sessionId, proxyTransport);
      if (!this.isLifecycleCurrent(generation)) {
        client.removeAllListeners();
        await client.disconnect().catch(() => undefined);
        await store.destroy().catch(() => undefined);
        return;
      }
      this.libraries = libraries;
      this.store = store;
      this.client = client;
      this.bindClientEvents(client);
    } catch (error) {
      await store.destroy().catch(() => undefined);
      throw error;
    }
  }

  private bindClientEvents(client: ZapoClient): void {
    client.on('auth_qr', ({ qr }) => {
      if (this.client !== client) return;
      this.pairingReady = true;
      void this.publishQr(qr);
    });

    client.on('auth_pairing_required', () => {
      if (this.client !== client) return;
      this.pairingReady = true;
    });

    client.on('auth_passkey_required', ({ hasSigner }) => {
      if (this.client !== client) return;
      if (hasSigner) return;
      const message =
        'This WhatsApp account requires passkey approval, which is unavailable in the headless Zapo engine.';
      this.setStatus(EngineStatus.FAILED);
      this.callbacks.onError?.(message);
    });

    client.on('auth_paired', ({ credentials }) => {
      if (this.client !== client) return;
      this.pairingReady = false;
      this.qrGeneration += 1;
      this.qrCode = null;
      this.updateIdentity(credentials);
      this.setStatus(EngineStatus.AUTHENTICATING);
    });

    client.on('connection', event => {
      if (this.client !== client) return;
      this.handleConnection(event);
    });

    client.on('message', event => {
      if (this.client !== client) return;
      this.handlePlainTextMessage(event);
    });

    client.on('debug_client_error', ({ error }) => {
      if (this.client !== client) return;
      this.logger.warn('Zapo client error', {
        action: 'zapo_client_error',
        sessionId: this.config.sessionId,
        error: error.message,
      });
    });

    client.on('voip_call_incoming', call => {
      this.emitMappedVoiceCallEvent(client, 'incoming', call);
    });
    client.on('voip_call_state', call => {
      this.emitMappedVoiceCallEvent(client, 'state', call);
    });
    client.on('voip_call_ended', call => {
      this.emitMappedVoiceCallEvent(client, 'ended', call);
    });
    client.on('voip_call_inbound_audio', ({ call, pcm }) => {
      this.emitMappedVoiceCallEvent(client, 'audio', call, pcm);
    });
    client.on('voip_call_error', error => {
      this.enqueueVoiceEvent(client, () => {
        this.emitVoiceEvent({ type: 'error', error });
      });
    });
  }

  private async connectClient(): Promise<void> {
    if (!this.client) {
      throw new EngineNotReadyError('Zapo client has not been created.');
    }
    if (!this.connectPromise) {
      this.connectPromise = this.client.connect().finally(() => {
        this.connectPromise = null;
      });
    }
    return this.connectPromise;
  }

  private beginConnect(): void {
    void this.connectClient().catch(error => {
      // A close event normally owns the reconnect/terminal transition. This
      // fallback covers setup failures that reject without emitting one.
      if (this.intentionalClose || this.status === EngineStatus.FAILED || this.status === EngineStatus.DISCONNECTED) {
        return;
      }
      this.setStatus(EngineStatus.FAILED);
      this.callbacks.onError?.(this.errorMessage(error));
    });
  }

  private handleConnection(event: WaConnectionEvent): void {
    if (event.status === 'open') {
      this.pairingReady = false;
      this.qrGeneration += 1;
      this.qrCode = null;
      this.updateIdentity(this.client?.getCredentials() ?? null);
      this.setStatus(EngineStatus.READY);
      if (!this.readyNotified) {
        this.readyNotified = true;
        this.callbacks.onReady?.(this.phoneNumber ?? '', this.pushName ?? '');
      }
      return;
    }

    this.qrGeneration += 1;
    this.qrCode = null;
    this.pairingReady = false;
    if (event.isLogout) {
      this.setStatus(EngineStatus.DISCONNECTED);
      this.callbacks.onDisconnected?.(event.reason);
      if (!this.intentionalClose) {
        this.intentionalClose = true;
        void this.clearLoggedOutRuntime();
      }
      return;
    }
    if (this.intentionalClose) {
      this.setStatus(EngineStatus.DISCONNECTED);
      return;
    }
    // Zapo owns the forced-login stream-control reconnect internally. Starting
    // another connect here would race its `restartBackendAfterStreamControl`.
    if (event.reason === 'stream_error_force_login' || event.reason === 'failure_client_too_old') {
      this.setStatus(EngineStatus.INITIALIZING);
      return;
    }

    // Let SessionService own application-level reconnect/backoff. This avoids
    // competing WaClient, transport, adapter, and SessionService retry loops.
    if (event.reason === 'failure_service_unavailable' || event.reason === 'comms_stopped') {
      this.setStatus(EngineStatus.DISCONNECTED);
      this.callbacks.onDisconnected?.(event.reason);
      return;
    }

    this.setStatus(EngineStatus.FAILED);
    this.callbacks.onError?.(`Zapo connection closed: ${event.reason}`);
  }

  private async publishQr(rawQr: string): Promise<void> {
    const generation = ++this.qrGeneration;
    try {
      const rendered = await qrcode.toDataURL(rawQr);
      if (generation !== this.qrGeneration || this.intentionalClose) {
        return;
      }
      this.qrCode = rendered;
      this.setStatus(EngineStatus.QR_READY);
      this.callbacks.onQRCode?.(rendered);
    } catch (error) {
      this.logger.warn('Could not render Zapo pairing QR', {
        action: 'zapo_qr_render_failed',
        sessionId: this.config.sessionId,
        error: this.errorMessage(error),
      });
    }
  }

  private updateIdentity(credentials: ReturnType<ZapoClient['getCredentials']>): void {
    if (!credentials) {
      return;
    }
    this.phoneNumber = credentials.meJid ? userPart(credentials.meJid) : null;
    this.pushName = credentials.pushName ?? credentials.meDisplayName ?? null;
  }

  private handlePlainTextMessage(event: WaIncomingMessageEvent): void {
    const body = event.message?.conversation ?? event.message?.extendedTextMessage?.text;
    if (typeof body !== 'string') {
      return;
    }

    const rawChatId = event.key.remoteJid;
    const chatId = toNeutralJid(rawChatId);
    const self = this.selfNeutralJid();
    const message: IncomingMessage = {
      id: event.key.id,
      from: event.key.fromMe ? self : chatId,
      to: event.key.fromMe ? chatId : self,
      chatId,
      body,
      type: 'text',
      timestamp: event.timestampSeconds ?? Math.floor(Date.now() / 1_000),
      fromMe: event.key.fromMe,
      isGroup: event.key.isGroup,
      isStatusBroadcast: rawChatId === 'status@broadcast',
      ...(event.key.isGroup && event.key.participant
        ? { author: toNeutralJid(event.key.participantAlt ?? event.key.participant) }
        : {}),
      ...(event.expirationSeconds ? { ephemeralDuration: event.expirationSeconds } : {}),
      ...(event.pushName ? { contact: { pushName: event.pushName } } : {}),
      ...(event.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length
        ? {
            mentionedIds: event.message.extendedTextMessage.contextInfo.mentionedJid.map(jid => toNeutralJid(jid)),
          }
        : {}),
    };

    if (event.key.fromMe) {
      this.callbacks.onMessageCreate?.(message);
    } else {
      this.callbacks.onMessage?.(message);
    }
  }

  private mapStoredMessage(record: WaStoredMessageRecord): IncomingMessage | null {
    const libraries = this.requireLibraries();
    let message: ReturnType<typeof libraries.zapo.proto.Message.decode> | undefined;
    if (record.messageBytes) {
      try {
        message = libraries.zapo.unwrapMessage(libraries.zapo.proto.Message.decode(record.messageBytes));
      } catch (error) {
        this.logger.warn('Could not decode a stored Zapo message', {
          action: 'zapo_stored_message_decode_failed',
          sessionId: this.config.sessionId,
          messageId: record.id,
          error: this.errorMessage(error),
        });
      }
    }

    const body =
      message?.conversation ??
      message?.extendedTextMessage?.text ??
      message?.imageMessage?.caption ??
      message?.videoMessage?.caption ??
      message?.documentMessage?.caption ??
      message?.contactMessage?.displayName ??
      '';
    let type: IncomingMessage['type'] = 'unknown';
    if (message?.conversation !== undefined || message?.extendedTextMessage) type = 'text';
    else if (message?.imageMessage) type = 'image';
    else if (message?.videoMessage) type = 'video';
    else if (message?.audioMessage) type = message.audioMessage.ptt ? 'voice' : 'audio';
    else if (message?.documentMessage) type = 'document';
    else if (message?.stickerMessage) type = 'sticker';
    else if (message?.locationMessage || message?.liveLocationMessage) type = 'location';
    else if (message?.contactMessage || message?.contactsArrayMessage) type = 'contact';
    else if (
      message?.pollCreationMessage ||
      message?.pollCreationMessageV2 ||
      message?.pollCreationMessageV3 ||
      message?.pollCreationMessageV5
    )
      type = 'poll';

    const chatId = toNeutralJid(record.threadJid);
    const self = this.selfNeutralJid();
    const isGroup = record.threadJid.endsWith('@g.us');
    const participant = record.participantJid ?? record.senderJid;
    return {
      id: record.id,
      from: record.fromMe ? self : chatId,
      to: record.fromMe ? chatId : self,
      chatId,
      body,
      type,
      timestamp: record.timestampMs ? Math.floor(record.timestampMs / 1_000) : 0,
      fromMe: record.fromMe,
      isGroup,
      ...(isGroup && !record.fromMe && participant ? { author: toNeutralJid(participant) } : {}),
    };
  }

  private async lookupNumber(
    number: string,
  ): Promise<{ readonly phoneJid: string; readonly lidJid: string | null; readonly exists: boolean } | null> {
    const client = this.readyClient();
    const [result] = await client.profile.getLidsByPhoneNumbers([number]);
    return result ?? null;
  }

  private readyClient(): ZapoClient {
    if (this.status !== EngineStatus.READY || !this.client) {
      throw new EngineNotReadyError();
    }
    return this.client;
  }

  private readyVoip(): ZapoClient['voip'] {
    const client = this.readyClient();
    if (!client.voip) {
      throw new EngineNotReadyError('Zapo VOIP plugin is not available while the client is disconnected.');
    }
    return client.voip;
  }

  private requireLibraries(): ZapoLibraries {
    if (!this.libraries) {
      throw new EngineNotReadyError('Zapo libraries have not been loaded.');
    }
    return this.libraries;
  }

  private toNativeJid(jid: string): string {
    const parsed = parseWaId(jid);
    switch (parsed.kind) {
      case 'user':
        return `${parsed.userPart}@s.whatsapp.net`;
      case 'group':
        return `${parsed.userPart}@g.us`;
      case 'lid':
        return `${parsed.userPart}@lid`;
      case 'status':
        return 'status@broadcast';
      case 'newsletter':
        return `${parsed.userPart}@newsletter`;
      case 'broadcast':
        return `${parsed.userPart}@broadcast`;
      default:
        return jid;
    }
  }

  private selfNeutralJid(): string {
    const jid = this.client?.getCredentials()?.meJid;
    return jid ? toNeutralJid(jid) : this.phoneNumber ? `${this.phoneNumber}@c.us` : '';
  }

  private resultTimestamp(raw?: string): number {
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Math.floor(Date.now() / 1_000);
  }

  private mapVoiceCall(call: CallInfo): VoiceCall {
    const connectedAt = call.stateData.connectedAt;
    const endedAt = call.stateData.endedAt;
    const direction = String(call.direction) === 'incoming' ? 'incoming' : 'outgoing';
    const callerPeerId = direction === 'incoming' && call.callerPn ? toNeutralJid(call.callerPn) : undefined;
    if (callerPeerId) this.voicePeerIds.set(call.callId, callerPeerId);
    return {
      id: call.callId,
      peerId: this.voicePeerIds.get(call.callId) ?? toNeutralJid(call.peerJid),
      direction,
      state: this.mapVoiceCallState(call.stateData.state),
      media: 'audio',
      muted: call.stateData.audioMuted,
      createdAt: call.createdAt.toISOString(),
      ...(connectedAt ? { connectedAt: connectedAt.toISOString() } : {}),
      ...(endedAt ? { endedAt: endedAt.toISOString() } : {}),
      ...(call.stateData.durationSecs !== undefined ? { durationSeconds: call.stateData.durationSecs } : {}),
      ...(call.stateData.endReason ? { endReason: call.stateData.endReason } : {}),
      canAccept: call.canAccept,
      canReject: call.canReject,
    };
  }

  private mapVoiceCallState(state: CallInfo['stateData']['state']): VoiceCallState {
    // String conversion keeps the adapter boundary independent from Zapo's
    // runtime enum object while preserving its documented wire values.
    switch (String(state)) {
      case 'initiating':
        return 'initiating';
      case 'ringing':
        return 'ringing';
      case 'incoming_ringing':
        return 'incoming_ringing';
      case 'connecting':
        return 'connecting';
      case 'active':
        return 'active';
      case 'on_hold':
        return 'on_hold';
      case 'ended':
        return 'ended';
      default:
        // CallState is currently exhaustive. Treat a future unknown terminal
        // token conservatively rather than leaking an engine-specific value.
        return 'ended';
    }
  }

  private toEndCallReason(reason: string | undefined, fallback: EndCallReason): EndCallReason {
    if (!reason) {
      return fallback;
    }
    const values = Object.values(this.requireLibraries().voip.EndCallReason) as string[];
    return values.includes(reason) ? (reason as EndCallReason) : this.requireLibraries().voip.EndCallReason.Unknown;
  }

  private emitVoiceEvent(event: VoiceCallEvent): void {
    for (const listener of this.voiceListeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn('Zapo voice-call listener failed', {
          action: 'zapo_voice_listener_failed',
          error: this.errorMessage(error),
        });
      }
    }
  }

  private async mapVoiceCallWithResolvedPeer(call: CallInfo): Promise<VoiceCall> {
    let mapped = this.mapVoiceCall(call);
    if (!mapped.peerId.endsWith('@lid')) return mapped;

    let resolution = this.voicePeerResolutions.get(call.callId);
    if (!resolution) {
      resolution = this.resolveContactPhone(mapped.peerId)
        .then(phone => (phone ? `${phone}@c.us` : undefined))
        .catch(error => {
          this.logger.warn('Could not resolve incoming Zapo call peer', {
            action: 'zapo_call_peer_resolve_failed',
            sessionId: this.config.sessionId,
            callId: call.callId,
            error: this.errorMessage(error),
          });
          return undefined;
        });
      this.voicePeerResolutions.set(call.callId, resolution);
    }

    const peerId = await resolution;
    if (peerId) {
      this.voicePeerIds.set(call.callId, peerId);
      mapped = { ...mapped, peerId };
    }
    return mapped;
  }

  private emitMappedVoiceCallEvent(
    client: ZapoClient,
    type: 'incoming' | 'state' | 'ended' | 'audio',
    call: CallInfo,
    pcm?: Float32Array,
  ): void {
    this.enqueueVoiceEvent(client, async () => {
      const mapped = await this.mapVoiceCallWithResolvedPeer(call);
      if (type === 'audio' && pcm) {
        this.emitVoiceEvent({ type, call: mapped, pcm });
      } else if (type !== 'audio') {
        this.emitVoiceEvent({ type, call: mapped });
      }
      if (type === 'ended') {
        this.voicePeerIds.delete(call.callId);
        this.voicePeerResolutions.delete(call.callId);
      }
    });
  }

  private enqueueVoiceEvent(client: ZapoClient, task: () => void | Promise<void>): void {
    this.voiceEventQueue = this.voiceEventQueue
      .then(async () => {
        if (this.client !== client) return;
        await task();
      })
      .catch(error => {
        this.logger.warn('Could not map or emit Zapo voice-call event', {
          action: 'zapo_voice_event_failed',
          sessionId: this.config.sessionId,
          error: this.errorMessage(error),
        });
      });
  }

  private setStatus(status: EngineStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.callbacks.onStateChanged?.(status);
  }

  private async closeStore(): Promise<void> {
    const store = this.store;
    this.store = null;
    if (store) {
      await store.destroy().catch(error => {
        this.logger.warn('Could not close Zapo SQLite store', {
          action: 'zapo_store_close_failed',
          sessionId: this.config.sessionId,
          error: this.errorMessage(error),
        });
      });
    }
  }

  private async clearLoggedOutRuntime(): Promise<void> {
    if (this.loggedOutCleanupPromise) return this.loggedOutCleanupPromise;
    const pending = this.performLoggedOutRuntimeCleanup();
    const tracked = pending.finally(() => {
      if (this.loggedOutCleanupPromise === tracked) this.loggedOutCleanupPromise = null;
    });
    this.loggedOutCleanupPromise = tracked;
    return tracked;
  }

  private async performLoggedOutRuntimeCleanup(): Promise<void> {
    this.lifecycleGeneration += 1;
    const client = this.client;
    this.client = null;
    this.clientPromise = null;
    this.connectPromise = null;
    client?.removeAllListeners();
    await this.closeStore();
    this.libraries = null;
    await this.clearAuthState();
    await this.closeProxyTransport();
    this.resetRuntimeState();
  }

  private async closeProxyTransport(): Promise<void> {
    const proxy = this.proxyTransport;
    if (!proxy || this.proxyClosed) return;
    this.proxyClosed = true;
    this.proxyTransport = undefined;
    if (typeof proxy.close === 'function') {
      try {
        await proxy.close();
      } catch (error) {
        this.logger.warn('Could not close Zapo proxy transport', {
          action: 'zapo_proxy_close_failed',
          sessionId: this.config.sessionId,
          error: this.errorMessage(error),
        });
        if (typeof proxy.destroy === 'function') proxy.destroy();
      }
    } else if (typeof proxy.destroy === 'function') {
      proxy.destroy();
    }
  }

  private async clearAuthState(): Promise<void> {
    try {
      await fs.promises.rm(this.authPath, { recursive: true, force: true });
      this.logger.log('Cleared Zapo session state', {
        action: 'zapo_auth_cleared',
        sessionId: this.config.sessionId,
        authPath: this.authPath,
      });
    } catch (error) {
      this.logger.warn('Could not clear Zapo session state', {
        action: 'zapo_auth_clear_failed',
        sessionId: this.config.sessionId,
        authPath: this.authPath,
        error: this.errorMessage(error),
      });
    }
  }

  private resetRuntimeState(): void {
    this.qrGeneration += 1;
    this.qrCode = null;
    this.pairingReady = false;
    this.phoneNumber = null;
    this.pushName = null;
    this.readyNotified = false;
    this.voicePeerIds.clear();
    this.voicePeerResolutions.clear();
    this.voiceEventQueue = Promise.resolve();
    this.setStatus(EngineStatus.DISCONNECTED);
  }

  private isLifecycleCurrent(generation: number): boolean {
    return generation === this.lifecycleGeneration && !this.intentionalClose;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private unsupported<T>(method: string): Promise<T> {
    return Promise.reject(new EngineNotSupportedError(method));
  }
}
