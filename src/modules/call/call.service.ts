import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import {
  isVoiceCallEngine,
  type IVoiceCallEngine,
  type VoiceCall,
  type VoiceCallEvent,
} from '../../engine/interfaces/voice-call-engine.interface';
import { EventsGateway } from '../events/events.gateway';
import { SessionService } from '../session/session.service';
import { WebhookService } from '../webhook/webhook.service';

interface EngineSubscription {
  engine: IVoiceCallEngine;
  unsubscribe: () => void;
}

export interface CallAudioFrame {
  sessionId: string;
  callId: string;
  pcm: Float32Array;
}

export type CallAudioListener = (frame: CallAudioFrame) => void;
export type CallEndedListener = (event: { sessionId: string; call: VoiceCall }) => void;

@Injectable()
export class CallService implements OnModuleDestroy {
  private readonly logger = new Logger(CallService.name);
  private readonly subscriptions = new Map<string, EngineSubscription>();
  private readonly snapshots = new Map<string, Map<string, VoiceCall>>();
  private readonly mediaOwners = new Map<string, Map<string, IVoiceCallEngine>>();
  private readonly endedNotified = new Map<string, Set<string>>();
  private readonly audioListeners = new Set<CallAudioListener>();
  private readonly endedListeners = new Set<CallEndedListener>();
  private readonly unregisterEngineListener: () => void;

  constructor(
    private readonly sessionService: SessionService,
    private readonly eventsGateway: EventsGateway,
    private readonly webhookService: WebhookService,
  ) {
    this.unregisterEngineListener = sessionService.onEngineChanged(sessionId => this.handleEngineChanged(sessionId));
  }

  onModuleDestroy(): void {
    this.unregisterEngineListener();
    for (const [sessionId, subscription] of this.subscriptions) {
      this.closeSessionMedia(sessionId, subscription.engine);
      this.unsubscribe(subscription);
    }
    this.subscriptions.clear();
    this.snapshots.clear();
    this.mediaOwners.clear();
    this.endedNotified.clear();
    this.audioListeners.clear();
    this.endedListeners.clear();
  }

  onAudio(listener: CallAudioListener): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }

  onEnded(listener: CallEndedListener): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  async list(sessionId: string): Promise<VoiceCall[]> {
    const engine = await this.resolveEngine(sessionId);
    const currentCalls = engine.getVoiceCalls();
    const currentIds = new Set(currentCalls.map(call => call.id));
    const snapshots = this.getSessionSnapshots(sessionId);
    for (const call of currentCalls) {
      this.storeSnapshot(sessionId, call);
    }
    for (const callId of snapshots.keys()) {
      if (!currentIds.has(callId)) snapshots.delete(callId);
    }
    return [...snapshots.values()].map(call => ({ ...call }));
  }

  async get(sessionId: string, callId: string): Promise<VoiceCall> {
    const engine = await this.resolveEngine(sessionId);
    return this.requireOwnedCall(sessionId, callId, engine);
  }

  async start(sessionId: string, peerId: string): Promise<VoiceCall> {
    const normalizedPeerId = peerId.trim();
    if (!normalizedPeerId) {
      throw new BadRequestException('peerId is required');
    }

    const engine = await this.resolveEngine(sessionId);
    const call = await engine.startVoiceCall(normalizedPeerId);
    return this.storeSnapshot(sessionId, call);
  }

  async accept(sessionId: string, callId: string): Promise<void> {
    const engine = await this.resolveEngine(sessionId);
    const call = this.requireOwnedCall(sessionId, callId, engine);
    if (!call.canAccept) {
      throw new BadRequestException(`Call '${callId}' cannot be accepted in state '${call.state}'`);
    }
    await engine.acceptVoiceCall(callId);
    this.refreshSnapshot(sessionId, callId, engine);
  }

  async reject(sessionId: string, callId: string, reason?: string): Promise<void> {
    const engine = await this.resolveEngine(sessionId);
    const call = this.requireOwnedCall(sessionId, callId, engine);
    if (!call.canReject) {
      throw new BadRequestException(`Call '${callId}' cannot be rejected in state '${call.state}'`);
    }
    await engine.rejectVoiceCall(callId, reason);
    this.refreshSnapshot(sessionId, callId, engine);
  }

  async end(sessionId: string, callId: string, reason?: string): Promise<void> {
    const engine = await this.resolveEngine(sessionId);
    const call = this.requireOwnedCall(sessionId, callId, engine);
    if (call.state === 'ended') {
      throw new BadRequestException(`Call '${callId}' has already ended`);
    }
    await engine.endVoiceCall(callId, reason);
    this.refreshSnapshot(sessionId, callId, engine);
  }

  async mute(sessionId: string, callId: string, muted: boolean): Promise<void> {
    const engine = await this.resolveEngine(sessionId);
    const call = this.requireOwnedCall(sessionId, callId, engine);
    if (call.state === 'ended') {
      throw new BadRequestException(`Call '${callId}' has already ended`);
    }
    engine.setVoiceCallMuted(callId, muted);
    this.refreshSnapshot(sessionId, callId, engine);
  }

  async openMedia(
    sessionId: string,
    callId: string,
  ): Promise<{ call: VoiceCall; watermarks: { pauseMs: number; resumeMs: number } }> {
    const engine = await this.resolveEngine(sessionId);
    const call = this.requireOwnedCall(sessionId, callId, engine);
    if (call.state === 'ended') {
      throw new BadRequestException(`Call '${callId}' has already ended`);
    }

    const watermarks = engine.getVoiceCallAudioWatermarks();
    if (
      !Number.isFinite(watermarks.pauseMs) ||
      !Number.isFinite(watermarks.resumeMs) ||
      watermarks.pauseMs <= 0 ||
      watermarks.resumeMs < 0 ||
      watermarks.resumeMs >= watermarks.pauseMs
    ) {
      throw new BadRequestException('Voice-call engine returned invalid audio watermarks');
    }

    engine.setVoiceCallExternalAudio(callId, true);
    this.trackMediaOwner(sessionId, callId, engine);
    return { call, watermarks: { ...watermarks } };
  }

  closeMedia(sessionId: string, callId: string): void {
    const sessionOwners = this.mediaOwners.get(sessionId);
    if (!sessionOwners) return;
    const engine = sessionOwners.get(callId);
    if (!engine) return;
    sessionOwners.delete(callId);
    if (sessionOwners.size === 0) this.mediaOwners.delete(sessionId);
    try {
      engine.setVoiceCallExternalAudio(callId, false);
    } catch (error) {
      this.logger.warn(`Failed to disable external audio for call ${callId}`, {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  feedAudio(sessionId: string, callId: string, pcm: Float32Array): number {
    const engine = this.resolveLiveEngine(sessionId);
    const call = this.requireOwnedCall(sessionId, callId, engine);
    if (call.state === 'ended') {
      throw new BadRequestException(`Call '${callId}' has already ended`);
    }
    return engine.feedVoiceCallAudio(callId, pcm);
  }

  private async resolveEngine(sessionId: string): Promise<IVoiceCallEngine> {
    await this.sessionService.findOne(sessionId);
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      this.detachSession(sessionId);
      throw new BadRequestException(`Session '${sessionId}' is not started`);
    }
    if (!isVoiceCallEngine(engine)) {
      this.detachSession(sessionId);
      throw new EngineNotSupportedError('voice calls');
    }
    this.ensureSubscription(sessionId, engine);
    return engine;
  }

  private handleEngineChanged(sessionId: string): void {
    const engine = this.sessionService.getEngine(sessionId);
    if (!isVoiceCallEngine(engine)) {
      this.detachSession(sessionId);
      return;
    }
    this.ensureSubscription(sessionId, engine);
  }

  private ensureSubscription(sessionId: string, engine: IVoiceCallEngine): void {
    const existing = this.subscriptions.get(sessionId);
    if (existing?.engine === engine) return;
    if (existing) this.detachSession(sessionId, 'session_engine_replaced');

    const sessionSnapshots = new Map<string, VoiceCall>();
    this.snapshots.set(sessionId, sessionSnapshots);
    this.endedNotified.set(sessionId, new Set());

    // Install the generation marker before registering the callback. An adapter is
    // allowed to synchronously replay its current state during registration.
    const subscription: EngineSubscription = { engine, unsubscribe: () => undefined };
    this.subscriptions.set(sessionId, subscription);
    try {
      subscription.unsubscribe = engine.onVoiceCallEvent(event => this.handleEngineEvent(sessionId, engine, event));
    } catch (error) {
      this.subscriptions.delete(sessionId);
      this.snapshots.delete(sessionId);
      throw error;
    }
    try {
      for (const call of engine.getVoiceCalls()) {
        sessionSnapshots.set(call.id, { ...call });
      }
    } catch {
      // A newly registered engine may not expose its initial call list until
      // initialization completes. The listener is already attached, and the
      // first REST/media operation refreshes the snapshots.
    }
  }

  private handleEngineEvent(sessionId: string, engine: IVoiceCallEngine, event: VoiceCallEvent): void {
    const current = this.subscriptions.get(sessionId);
    if (current?.engine !== engine || this.sessionService.getEngine(sessionId) !== engine) return;

    switch (event.type) {
      case 'incoming': {
        const call = this.storeSnapshot(sessionId, event.call);
        this.eventsGateway.emitCallIncoming(sessionId, call);
        void this.webhookService.dispatch(sessionId, 'call.incoming', { ...call });
        break;
      }
      case 'state': {
        const call = this.storeSnapshot(sessionId, event.call);
        this.eventsGateway.emitCallState(sessionId, call);
        void this.webhookService.dispatch(sessionId, 'call.state', { ...call });
        if (call.state === 'ended') this.notifyCallEnded(sessionId, call);
        break;
      }
      case 'ended': {
        const call = this.storeSnapshot(sessionId, event.call);
        this.notifyCallEnded(sessionId, call);
        break;
      }
      case 'error': {
        const payload = {
          ...(event.callId ? { callId: event.callId } : {}),
          error: event.error.message || 'Unknown voice call error',
        };
        this.eventsGateway.emitCallError(sessionId, payload);
        void this.webhookService.dispatch(sessionId, 'call.error', payload);
        break;
      }
      case 'audio': {
        this.storeSnapshot(sessionId, event.call);
        const frame: CallAudioFrame = { sessionId, callId: event.call.id, pcm: event.pcm };
        for (const listener of this.audioListeners) {
          try {
            listener(frame);
          } catch (error) {
            this.logger.warn(`Voice-call audio listener failed for call ${event.call.id}`, {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        break;
      }
    }
  }

  private requireOwnedCall(sessionId: string, callId: string, engine: IVoiceCallEngine): VoiceCall {
    const current = engine.getVoiceCall(callId);
    if (current) return this.storeSnapshot(sessionId, current);

    this.snapshots.get(sessionId)?.delete(callId);
    throw new NotFoundException(`Call '${callId}' was not found in session '${sessionId}'`);
  }

  private refreshSnapshot(sessionId: string, callId: string, engine: IVoiceCallEngine): void {
    const call = engine.getVoiceCall(callId);
    if (call) {
      this.storeSnapshot(sessionId, call);
    } else {
      this.snapshots.get(sessionId)?.delete(callId);
    }
  }

  private storeSnapshot(sessionId: string, call: VoiceCall): VoiceCall {
    const snapshot = { ...call };
    this.getSessionSnapshots(sessionId).set(call.id, snapshot);
    return { ...snapshot };
  }

  private getSessionSnapshots(sessionId: string): Map<string, VoiceCall> {
    let sessionSnapshots = this.snapshots.get(sessionId);
    if (!sessionSnapshots) {
      sessionSnapshots = new Map();
      this.snapshots.set(sessionId, sessionSnapshots);
    }
    return sessionSnapshots;
  }

  private detachSession(sessionId: string, reason = 'session_engine_unavailable'): void {
    const existing = this.subscriptions.get(sessionId);
    if (existing) this.unsubscribe(existing);
    this.subscriptions.delete(sessionId);
    this.endDetachedCalls(sessionId, reason);
    this.closeSessionMedia(sessionId, existing?.engine);
    this.snapshots.delete(sessionId);
    this.endedNotified.delete(sessionId);
  }

  private endDetachedCalls(sessionId: string, reason: string): void {
    const endedAt = new Date();
    for (const call of this.snapshots.get(sessionId)?.values() ?? []) {
      if (call.state === 'ended') continue;
      const connectedAt = call.connectedAt ? Date.parse(call.connectedAt) : Number.NaN;
      const durationSeconds = Number.isFinite(connectedAt)
        ? Math.max(0, Math.floor((endedAt.getTime() - connectedAt) / 1_000))
        : call.durationSeconds;
      const ended: VoiceCall = {
        ...call,
        state: 'ended',
        endedAt: endedAt.toISOString(),
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
        endReason: reason,
        canAccept: false,
        canReject: false,
      };
      this.storeSnapshot(sessionId, ended);
      this.notifyCallEnded(sessionId, ended);
    }
  }

  private notifyCallEnded(sessionId: string, call: VoiceCall): void {
    let notified = this.endedNotified.get(sessionId);
    if (!notified) {
      notified = new Set();
      this.endedNotified.set(sessionId, notified);
    }
    if (notified.has(call.id)) return;
    notified.add(call.id);

    this.eventsGateway.emitCallEnded(sessionId, call);
    void this.webhookService.dispatch(sessionId, 'call.ended', { ...call });
    for (const listener of this.endedListeners) {
      try {
        listener({ sessionId, call });
      } catch (error) {
        this.logger.warn(`Voice-call ended listener failed for call ${call.id}`, {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private unsubscribe(subscription: EngineSubscription): void {
    try {
      subscription.unsubscribe();
    } catch {
      // Adapter teardown is best-effort; all local references are dropped.
    }
  }

  private resolveLiveEngine(sessionId: string): IVoiceCallEngine {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      this.detachSession(sessionId);
      throw new BadRequestException(`Session '${sessionId}' is not started`);
    }
    if (!isVoiceCallEngine(engine)) {
      this.detachSession(sessionId);
      throw new EngineNotSupportedError('voice calls');
    }
    this.ensureSubscription(sessionId, engine);
    return engine;
  }

  private trackMediaOwner(sessionId: string, callId: string, engine: IVoiceCallEngine): void {
    let sessionOwners = this.mediaOwners.get(sessionId);
    if (!sessionOwners) {
      sessionOwners = new Map();
      this.mediaOwners.set(sessionId, sessionOwners);
    }
    sessionOwners.set(callId, engine);
  }

  private closeSessionMedia(sessionId: string, expectedEngine?: IVoiceCallEngine): void {
    const sessionOwners = this.mediaOwners.get(sessionId);
    if (!sessionOwners) return;
    for (const [callId, engine] of [...sessionOwners]) {
      if (expectedEngine && engine !== expectedEngine) continue;
      this.closeMedia(sessionId, callId);
    }
  }
}
