import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { VoiceCallEvent } from '../interfaces/voice-call-engine.interface';
import { ZapoAdapter, ZapoLibraries } from './zapo.adapter';

jest.mock('qrcode', () => ({
  toDataURL: jest.fn((raw: string) => Promise.resolve(`data:image/png;base64,${raw}`)),
}));

type EventListener = (payload: unknown) => void;

class FakeZapoClient {
  private readonly listeners = new Map<string, EventListener[]>();
  credentials: {
    meJid?: string;
    meDisplayName?: string;
    pushName?: string;
  } | null = null;

  readonly connect = jest.fn(() => Promise.resolve());
  readonly disconnect = jest.fn(() => Promise.resolve());
  readonly logout = jest.fn(() => Promise.resolve());
  readonly auth = {
    requestPairingCode: jest.fn(() => Promise.resolve('ABCD-EFGH')),
  };
  readonly message = {
    send: jest.fn(() => Promise.resolve({ id: 'message-1', ack: { t: '1710000000' } })),
    sendReceipt: jest.fn(() => Promise.resolve()),
  };
  readonly profile = {
    getLidsByPhoneNumbers: jest.fn(() =>
      Promise.resolve([{ phoneJid: '15551234567@s.whatsapp.net', lidJid: '42@lid', exists: true }]),
    ),
  };
  readonly chat = {
    setChatRead: jest.fn(() => Promise.resolve()),
    deleteChat: jest.fn(() => Promise.resolve()),
  };
  readonly presence = {
    sendChatstate: jest.fn(() => Promise.resolve()),
  };
  readonly voip = {
    startCall: jest.fn(() => Promise.resolve('call-1')),
    acceptCall: jest.fn(() => Promise.resolve()),
    rejectCall: jest.fn(() => Promise.resolve()),
    endCall: jest.fn(() => Promise.resolve()),
    setMute: jest.fn(),
    setExternalAudioMode: jest.fn(),
    feedLiveAudio: jest.fn(() => 320),
    getFeedWatermarksMs: jest.fn(() => ({ pauseMs: 120, resumeMs: 60 })),
    getCall: jest.fn((): unknown => null),
    getCalls: jest.fn((): readonly unknown[] => []),
  };

  on(event: string, listener: EventListener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }

  getCredentials(): FakeZapoClient['credentials'] {
    return this.credentials;
  }
}

type FakeWaClientConstructorArgs = [
  options: { proxy?: { ws?: { dispatch(...args: readonly unknown[]): unknown } } },
  plugins: readonly unknown[],
];

describe('ZapoAdapter', () => {
  let tmpRoot: string;
  let client: FakeZapoClient;
  let createSqliteStore: jest.Mock;
  let createStore: jest.Mock;
  let contactByJid: jest.Mock;
  let listMessages: jest.Mock;
  let listThreads: jest.Mock;
  let destroyStore: jest.Mock;
  let waClientConstructor: jest.Mock<FakeZapoClient, FakeWaClientConstructorArgs>;
  let libraries: ZapoLibraries;
  let adapter: ZapoAdapter;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zapo-adapter-'));
    client = new FakeZapoClient();
    createSqliteStore = jest.fn(() => ({ stores: {}, caches: {} }));
    contactByJid = jest.fn().mockResolvedValue(null);
    listMessages = jest.fn(() =>
      Promise.resolve([
        {
          id: 'incoming-latest',
          threadJid: '15551234567@s.whatsapp.net',
          senderJid: '15551234567@s.whatsapp.net',
          fromMe: false,
          timestampMs: 1_710_000_001_000,
          messageBytes: new Uint8Array([1]),
        },
      ]),
    );
    listThreads = jest.fn(() =>
      Promise.resolve([
        {
          jid: '15551234567@s.whatsapp.net',
          name: 'Bob',
          unreadCount: 2,
        },
      ]),
    );
    destroyStore = jest.fn(() => Promise.resolve());
    const store = {
      session: jest.fn(() => ({
        contacts: { getByJid: contactByJid },
        messages: { listByThread: listMessages },
        threads: { list: listThreads },
      })),
      destroy: destroyStore,
    };
    createStore = jest.fn(() => store);
    waClientConstructor = jest.fn<FakeZapoClient, FakeWaClientConstructorArgs>(() => client);
    libraries = {
      zapo: {
        WaClient: waClientConstructor,
        createStore,
        createNoopLogger: jest.fn(() => ({})),
        proto: { Message: { decode: jest.fn(() => ({ conversation: 'stored hello' })) } },
        unwrapMessage: jest.fn((message: unknown) => message),
      },
      sqlite: { createSqliteStore },
      voip: {
        voipPlugin: jest.fn(() => ({ exposeAs: 'voip', setup: jest.fn() })),
        EndCallReason: {
          UserEnded: 'user_ended',
          Declined: 'declined',
          Timeout: 'timeout',
          Busy: 'busy',
          Cancelled: 'cancelled',
          Failed: 'failed',
          DoNotDisturb: 'do_not_disturb',
          Unknown: 'unknown',
        },
      },
    } as unknown as ZapoLibraries;

    adapter = new ZapoAdapter({ sessionId: 'alice', authDir: tmpRoot }, () => Promise.resolve(libraries));
  });

  afterEach(async () => {
    jest.useRealTimers();
    await adapter.destroy();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function flushAsyncEvents(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
  }

  async function makeReady(callbacks: Parameters<ZapoAdapter['initialize']>[0] = {}): Promise<void> {
    await adapter.initialize(callbacks);
    client.credentials = {
      meJid: '15550001111:7@s.whatsapp.net',
      pushName: 'Alice',
    };
    client.emit('connection', {
      status: 'open',
      reason: 'connected',
      code: null,
      isLogout: false,
      isNewLogin: false,
    });
  }

  it('builds the complete per-session SQLite store and publishes QR data without blocking on pairing', async () => {
    client.connect.mockImplementation(() => new Promise<void>(() => undefined));
    const onQRCode = jest.fn();

    await expect(adapter.initialize({ onQRCode })).resolves.toBeUndefined();
    client.emit('auth_qr', { qr: 'raw-zapo-qr', ttlMs: 30_000 });
    await flushAsyncEvents();

    expect(createSqliteStore).toHaveBeenCalledWith({
      path: path.join(tmpRoot, 'alice', 'state.sqlite'),
      pragmas: { journal_mode: 'WAL', synchronous: 'NORMAL' },
    });
    expect(createStore).toHaveBeenCalledWith({
      backends: { sqlite: { stores: {}, caches: {} } },
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
    expect(adapter.getStatus()).toBe(EngineStatus.QR_READY);
    expect(adapter.getQRCode()).toBe('data:image/png;base64,raw-zapo-qr');
    expect(onQRCode).toHaveBeenCalledWith('data:image/png;base64,raw-zapo-qr');
    await expect(adapter.requestPairingCode('+1 (555) 000-1111')).resolves.toBe('ABCD-EFGH');
    expect(client.auth.requestPairingCode).toHaveBeenCalledWith('15550001111');
  });

  it('gates pairing-code requests and surfaces unsupported passkey approval', async () => {
    const onError = jest.fn();
    await adapter.initialize({ onError });

    await expect(adapter.requestPairingCode('15550001111')).rejects.toThrow('not ready for pairing');
    client.emit('auth_passkey_required', { hasSigner: false });

    expect(adapter.getStatus()).toBe(EngineStatus.FAILED);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('requires passkey approval'));
  });

  it('passes a configured proxy transport to the Zapo WebSocket connection', async () => {
    adapter = new ZapoAdapter(
      { sessionId: 'alice', authDir: tmpRoot, proxyUrl: 'http://proxy.example:8080', proxyType: 'http' },
      () => Promise.resolve(libraries),
    );

    await adapter.initialize({});

    const options = waClientConstructor.mock.calls[0]?.[0];
    expect(options?.proxy?.ws).toBeDefined();
    expect(typeof options?.proxy?.ws?.dispatch).toBe('function');
  });

  it('cancels client creation when disconnect wins an in-flight initialization', async () => {
    let resolveLibraries!: (value: ZapoLibraries) => void;
    const pendingLibraries = new Promise<ZapoLibraries>(resolve => {
      resolveLibraries = resolve;
    });
    const delayedLoader = jest.fn(() => pendingLibraries);
    adapter = new ZapoAdapter({ sessionId: 'alice', authDir: tmpRoot }, delayedLoader);

    const initialize = adapter.initialize({});
    while (delayedLoader.mock.calls.length === 0) await flushAsyncEvents();
    const disconnect = adapter.disconnect();
    resolveLibraries(libraries);
    await Promise.all([initialize, disconnect]);

    expect(waClientConstructor).not.toHaveBeenCalled();
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('tracks ready identity and implements text, number, and chat-state operations with neutral JIDs', async () => {
    const onReady = jest.fn();
    const onMessageCreate = jest.fn();
    const onMessage = jest.fn();
    await makeReady({ onReady, onMessageCreate, onMessage });

    expect(onReady).toHaveBeenCalledWith('15550001111', 'Alice');
    expect(adapter.getPhoneNumber()).toBe('15550001111');
    expect(adapter.getPushName()).toBe('Alice');

    await expect(adapter.sendTextMessage('15551234567@c.us', 'hello', ['15557654321@c.us'])).resolves.toEqual({
      id: 'message-1',
      timestamp: 1710000000,
    });
    expect(client.message.send).toHaveBeenCalledWith(
      '15551234567@s.whatsapp.net',
      { type: 'text', text: 'hello' },
      { mentions: ['15557654321@s.whatsapp.net'] },
    );
    expect(onMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '15550001111@c.us',
        to: '15551234567@c.us',
        chatId: '15551234567@c.us',
        mentionedIds: ['15557654321@c.us'],
      }),
    );
    client.emit('message', {
      key: {
        id: 'incoming-1',
        remoteJid: '15551234567@s.whatsapp.net',
        fromMe: false,
        isGroup: false,
      },
      message: { conversation: 'inbound hello' },
      timestampSeconds: 1710000001,
      pushName: 'Bob',
    });
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'incoming-1',
        from: '15551234567@c.us',
        to: '15550001111@c.us',
        chatId: '15551234567@c.us',
        body: 'inbound hello',
      }),
    );

    await expect(adapter.checkNumberExists('+1 (555) 123-4567')).resolves.toBe(true);
    await expect(adapter.getNumberId('15551234567')).resolves.toBe('15551234567@c.us');
    contactByJid.mockResolvedValue({ phoneNumber: '15559876543@s.whatsapp.net' });
    await expect(adapter.resolveContactPhone('42@lid')).resolves.toBe('15559876543');

    await expect(adapter.sendSeen('15551234567@c.us')).resolves.toBe(true);
    await expect(adapter.markUnread('15551234567@c.us')).resolves.toBe(true);
    await expect(adapter.deleteChat('15551234567@c.us')).resolves.toBe(true);
    await expect(adapter.getChats()).resolves.toEqual([
      {
        id: '15551234567@c.us',
        name: 'Bob',
        isGroup: false,
        unreadCount: 2,
        timestamp: 1710000001,
        lastMessage: 'stored hello',
      },
    ]);
    await expect(adapter.getChatHistory('15551234567@c.us')).resolves.toEqual([
      expect.objectContaining({
        id: 'incoming-latest',
        chatId: '15551234567@c.us',
        body: 'stored hello',
        type: 'text',
        timestamp: 1710000001,
      }),
    ]);
    await adapter.sendChatState('15551234567@c.us', 'recording');
    expect(client.chat.setChatRead).toHaveBeenNthCalledWith(1, '15551234567@s.whatsapp.net', true);
    expect(client.chat.setChatRead).toHaveBeenNthCalledWith(2, '15551234567@s.whatsapp.net', false);
    expect(client.chat.deleteChat).toHaveBeenCalledWith('15551234567@s.whatsapp.net');
    expect(client.message.sendReceipt).toHaveBeenCalledWith('15551234567@s.whatsapp.net', 'incoming-latest', {
      type: 'read',
    });
    expect(client.presence.sendChatstate).toHaveBeenCalledWith('15551234567@s.whatsapp.net', {
      state: 'composing',
      media: 'audio',
    });
  });

  it('maps every voice operation and re-emits neutral incoming/state/ended/audio/error events', async () => {
    await makeReady();
    const outgoingCall = {
      callId: 'call-1',
      peerJid: '42@lid',
      callerPn: undefined,
      direction: 'outgoing',
      mediaType: 'audio',
      stateData: {
        state: 'initiating',
        audioMuted: false,
        videoOff: true,
      },
      createdAt: new Date('2026-07-13T12:00:00.000Z'),
      isOffline: false,
      canAccept: false,
      canReject: false,
    };
    client.voip.getCall.mockReturnValue(outgoingCall);
    client.voip.getCalls.mockReturnValue([outgoingCall]);

    await expect(adapter.startVoiceCall('15551234567@c.us')).resolves.toEqual(
      expect.objectContaining({
        id: 'call-1',
        peerId: '15551234567@c.us',
        direction: 'outgoing',
        state: 'initiating',
        media: 'audio',
      }),
    );
    expect(client.voip.startCall).toHaveBeenCalledWith({
      peerJid: '15551234567@s.whatsapp.net',
      isVideo: false,
    });
    await adapter.acceptVoiceCall('call-1');
    await adapter.rejectVoiceCall('call-1', 'busy');
    await adapter.endVoiceCall('call-1', 'timeout');
    adapter.setVoiceCallMuted('call-1', true);
    adapter.setVoiceCallExternalAudio('call-1', true);
    expect(adapter.feedVoiceCallAudio('call-1', new Float32Array([0.25]))).toBe(320);
    expect(adapter.getVoiceCallAudioWatermarks()).toEqual({ pauseMs: 120, resumeMs: 60 });
    expect(adapter.getVoiceCall('call-1')?.peerId).toBe('15551234567@c.us');
    expect(adapter.getVoiceCalls()).toHaveLength(1);
    expect(client.voip.rejectCall).toHaveBeenCalledWith('call-1', 'busy');
    expect(client.voip.endCall).toHaveBeenCalledWith('call-1', 'timeout');

    const events: VoiceCallEvent[] = [];
    const listener = jest.fn((event: VoiceCallEvent) => {
      events.push(event);
    });
    const unsubscribe = adapter.onVoiceCallEvent(listener);
    const pcm = new Float32Array([0.1, -0.1]);
    const error = new Error('relay failed');
    const incomingCall = {
      ...outgoingCall,
      callerPn: '15551234567:9@s.whatsapp.net',
      direction: 'incoming',
      stateData: { ...outgoingCall.stateData, state: 'incoming_ringing' },
      canAccept: true,
      canReject: true,
    };
    client.emit('voip_call_incoming', incomingCall);
    client.emit('voip_call_state', incomingCall);
    client.emit('voip_call_ended', incomingCall);
    client.emit('voip_call_inbound_audio', { call: incomingCall, pcm });
    client.emit('voip_call_error', error);
    await flushAsyncEvents();

    expect(events.map(event => event.type)).toEqual(['incoming', 'state', 'ended', 'audio', 'error']);
    const audioEvent = events[3];
    expect(audioEvent?.type).toBe('audio');
    if (audioEvent?.type === 'audio') {
      expect(audioEvent.call.peerId).toBe('15551234567@c.us');
      expect(audioEvent.pcm).toBe(pcm);
    }
    expect(events[4]).toEqual({ type: 'error', error });
    unsubscribe();
    client.emit('voip_call_state', incomingCall);
    expect(listener).toHaveBeenCalledTimes(5);
  });

  it('resolves an incoming LID-only caller through the persisted contact store', async () => {
    await makeReady();
    contactByJid.mockResolvedValue({ phoneNumber: '15551234567@s.whatsapp.net' });
    const listener: jest.MockedFunction<(event: VoiceCallEvent) => void> = jest.fn();
    adapter.onVoiceCallEvent(listener);

    const incoming = {
      callId: 'incoming-lid',
      peerJid: '42@lid',
      callerPn: undefined,
      direction: 'incoming',
      mediaType: 'audio',
      stateData: { state: 'incoming_ringing', audioMuted: false, videoOff: true },
      createdAt: new Date('2026-07-13T12:00:00.000Z'),
      isOffline: false,
      canAccept: true,
      canReject: true,
    };
    client.emit('voip_call_state', incoming);
    client.emit('voip_call_incoming', incoming);
    await flushAsyncEvents();

    expect(contactByJid).toHaveBeenCalledWith('42@lid');
    const stateEvent = listener.mock.calls[0]?.[0];
    const incomingEvent = listener.mock.calls[1]?.[0];
    expect(stateEvent?.type).toBe('state');
    expect(incomingEvent?.type).toBe('incoming');
    if (stateEvent?.type !== 'state' || incomingEvent?.type !== 'incoming') {
      throw new Error('Expected serialized state and incoming voice events');
    }
    expect(stateEvent.call).toMatchObject({ id: 'incoming-lid', peerId: '15551234567@c.us' });
    expect(incomingEvent.call).toMatchObject({ id: 'incoming-lid', peerId: '15551234567@c.us' });
  });

  it('delegates recoverable reconnects to SessionService and clears persisted state on logout', async () => {
    const onDisconnected = jest.fn();
    const onError = jest.fn();
    await makeReady({ onDisconnected, onError });
    await Promise.resolve();
    await Promise.resolve();

    client.emit('connection', {
      status: 'close',
      reason: 'failure_service_unavailable',
      code: 503,
      isLogout: false,
      isNewLogin: false,
    });
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(onDisconnected).toHaveBeenCalledWith('failure_service_unavailable');
    expect(client.connect).toHaveBeenCalledTimes(1);

    client.emit('connection', {
      status: 'close',
      reason: 'stream_error_force_login',
      code: 515,
      isLogout: false,
      isNewLogin: false,
    });
    expect(adapter.getStatus()).toBe(EngineStatus.INITIALIZING);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);

    client.emit('connection', {
      status: 'close',
      reason: 'failure_client_too_old',
      code: 405,
      isLogout: false,
      isNewLogin: false,
    });
    expect(adapter.getStatus()).toBe(EngineStatus.INITIALIZING);
    expect(onError).not.toHaveBeenCalled();
    expect(onDisconnected).toHaveBeenCalledTimes(1);

    client.emit('connection', {
      status: 'close',
      reason: 'failure_banned',
      code: 406,
      isLogout: false,
      isNewLogin: false,
    });
    expect(adapter.getStatus()).toBe(EngineStatus.FAILED);
    expect(onError).toHaveBeenCalledWith('Zapo connection closed: failure_banned');

    fs.writeFileSync(path.join(tmpRoot, 'alice', 'marker'), 'state');
    await adapter.logout();
    expect(destroyStore).toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpRoot, 'alice'))).toBe(false);
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('closes the SQLite store on disconnect without deleting reusable auth state', async () => {
    await makeReady();
    const marker = path.join(tmpRoot, 'alice', 'marker');
    fs.writeFileSync(marker, 'state');

    await adapter.disconnect();

    expect(destroyStore).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(marker)).toBe(true);
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('emits ready only on transition and clears local auth after a remote unlink', async () => {
    const onReady = jest.fn();
    const onDisconnected = jest.fn();
    await makeReady({ onReady, onDisconnected });
    client.emit('connection', {
      status: 'open',
      reason: 'connected',
      code: null,
      isLogout: false,
      isNewLogin: false,
    });
    expect(onReady).toHaveBeenCalledTimes(1);

    client.emit('connection', {
      status: 'close',
      reason: 'failure_client_too_old',
      code: 405,
      isLogout: false,
      isNewLogin: false,
    });
    client.emit('connection', {
      status: 'open',
      reason: 'connected',
      code: null,
      isLogout: false,
      isNewLogin: false,
    });
    expect(onReady).toHaveBeenCalledTimes(1);

    const voiceListener = jest.fn();
    adapter.onVoiceCallEvent(voiceListener);
    fs.writeFileSync(path.join(tmpRoot, 'alice', 'marker'), 'state');
    client.emit('connection', {
      status: 'close',
      reason: 'stream_error_device_removed',
      code: 401,
      isLogout: true,
      isNewLogin: false,
    });
    await adapter.disconnect();

    expect(onDisconnected).toHaveBeenCalledWith('stream_error_device_removed');
    expect(destroyStore).toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpRoot, 'alice'))).toBe(false);
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);

    client.emit('voip_call_state', {
      callId: 'late-call',
      peerJid: '42@lid',
      callerPn: undefined,
      direction: 'incoming',
      mediaType: 'audio',
      stateData: { state: 'active', audioMuted: false, videoOff: true },
      createdAt: new Date('2026-07-13T12:00:00.000Z'),
      isOffline: false,
      canAccept: false,
      canReject: false,
    });
    await flushAsyncEvents();
    expect(voiceListener).not.toHaveBeenCalled();
  });

  it('rejects non-slice methods consistently with EngineNotSupportedError', async () => {
    await expect(
      adapter.sendImageMessage('15551234567@c.us', { mimetype: 'image/png', data: '' }),
    ).rejects.toBeInstanceOf(EngineNotSupportedError);
  });
});
