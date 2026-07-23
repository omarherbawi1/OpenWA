import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import type {
  IVoiceCallEngine,
  VoiceCall,
  VoiceCallEventListener,
} from '../../engine/interfaces/voice-call-engine.interface';
import { EventsGateway } from '../events/events.gateway';
import { SessionService } from '../session/session.service';
import { WebhookService } from '../webhook/webhook.service';
import { CallService, type CallAudioFrame, type CallEndedListener } from './call.service';

const makeCall = (overrides: Partial<VoiceCall> = {}): VoiceCall => ({
  id: 'call-1',
  peerId: '628123@c.us',
  direction: 'incoming',
  state: 'incoming_ringing',
  media: 'audio',
  muted: false,
  createdAt: '2026-07-13T00:00:00.000Z',
  canAccept: true,
  canReject: true,
  ...overrides,
});

describe('CallService', () => {
  let service: CallService;
  let sessionService: { findOne: jest.Mock; getEngine: jest.Mock; onEngineChanged: jest.Mock };
  let eventsGateway: {
    emitCallIncoming: jest.Mock;
    emitCallState: jest.Mock;
    emitCallEnded: jest.Mock;
    emitCallError: jest.Mock;
  };
  let webhookService: { dispatch: jest.Mock };
  let listener: VoiceCallEventListener;
  let engineChangedListener: (sessionId: string) => void;
  let calls: Map<string, VoiceCall>;
  let unsubscribe: jest.Mock;
  let engine: IVoiceCallEngine & {
    startVoiceCall: jest.Mock;
    acceptVoiceCall: jest.Mock;
    rejectVoiceCall: jest.Mock;
    endVoiceCall: jest.Mock;
    setVoiceCallMuted: jest.Mock;
    setVoiceCallExternalAudio: jest.Mock;
    feedVoiceCallAudio: jest.Mock;
    getVoiceCallAudioWatermarks: jest.Mock;
    getVoiceCall: jest.Mock;
    getVoiceCalls: jest.Mock;
    onVoiceCallEvent: jest.Mock;
  };

  beforeEach(() => {
    calls = new Map([['call-1', makeCall()]]);
    unsubscribe = jest.fn();
    engine = {
      startVoiceCall: jest.fn((peerId: string): Promise<VoiceCall> => {
        const call = makeCall({ id: 'out-1', peerId, direction: 'outgoing', state: 'initiating' });
        calls.set(call.id, call);
        return Promise.resolve(call);
      }),
      acceptVoiceCall: jest.fn().mockResolvedValue(undefined),
      rejectVoiceCall: jest.fn().mockResolvedValue(undefined),
      endVoiceCall: jest.fn().mockResolvedValue(undefined),
      setVoiceCallMuted: jest.fn(),
      setVoiceCallExternalAudio: jest.fn(),
      feedVoiceCallAudio: jest.fn().mockReturnValue(120),
      getVoiceCallAudioWatermarks: jest.fn().mockReturnValue({ pauseMs: 500, resumeMs: 200 }),
      getVoiceCall: jest.fn((id: string) => calls.get(id) ?? null),
      getVoiceCalls: jest.fn(() => [...calls.values()]),
      onVoiceCallEvent: jest.fn((next: VoiceCallEventListener) => {
        listener = next;
        return unsubscribe;
      }),
    } as unknown as typeof engine;
    sessionService = {
      findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }),
      getEngine: jest.fn().mockReturnValue(engine),
      onEngineChanged: jest.fn((next: (sessionId: string) => void) => {
        engineChangedListener = next;
        return jest.fn();
      }),
    };
    eventsGateway = {
      emitCallIncoming: jest.fn(),
      emitCallState: jest.fn(),
      emitCallEnded: jest.fn(),
      emitCallError: jest.fn(),
    };
    webhookService = { dispatch: jest.fn().mockResolvedValue(undefined) };
    service = new CallService(
      sessionService as unknown as SessionService,
      eventsGateway as unknown as EventsGateway,
      webhookService as unknown as WebhookService,
    );
  });

  afterEach(() => service.onModuleDestroy());

  it('uses SessionService.getEngine and rejects a non-voice engine with EngineNotSupportedError', async () => {
    sessionService.getEngine.mockReturnValue({ getVoiceCalls: jest.fn() });

    await expect(service.list('sess-1')).rejects.toBeInstanceOf(EngineNotSupportedError);
    expect(sessionService.findOne).toHaveBeenCalledWith('sess-1');
    expect(sessionService.getEngine).toHaveBeenCalledWith('sess-1');
  });

  it('returns a clear BadRequest when an existing session is not started', async () => {
    sessionService.getEngine.mockReturnValue(undefined);

    await expect(service.list('sess-1')).rejects.toEqual(
      expect.objectContaining<Partial<BadRequestException>>({ message: "Session 'sess-1' is not started" }),
    );
  });

  it('preserves SessionService NotFound errors', async () => {
    sessionService.findOne.mockRejectedValue(new NotFoundException("Session with id 'missing' not found"));

    await expect(service.list('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(sessionService.getEngine).not.toHaveBeenCalled();
  });

  it('subscribes once per engine/session and maintains defensive call snapshots', async () => {
    const first = await service.list('sess-1');
    first[0].state = 'ended';
    const second = await service.get('sess-1', 'call-1');

    expect(engine.onVoiceCallEvent).toHaveBeenCalledTimes(1);
    expect(second.state).toBe('incoming_ringing');
  });

  it('prunes snapshots for calls the engine no longer owns', async () => {
    await expect(service.list('sess-1')).resolves.toHaveLength(1);
    calls.clear();

    await expect(service.list('sess-1')).resolves.toEqual([]);
    await expect(service.get('sess-1', 'call-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('subscribes as soon as SessionService registers a voice engine so incoming calls are not missed', () => {
    engineChangedListener('sess-1');
    listener({ type: 'incoming', call: makeCall() });

    expect(engine.onVoiceCallEvent).toHaveBeenCalledTimes(1);
    expect(eventsGateway.emitCallIncoming).toHaveBeenCalledWith('sess-1', expect.objectContaining({ id: 'call-1' }));
  });

  it('ends active calls, disables external audio, and unsubscribes when SessionService removes the engine', async () => {
    const endedSink: jest.MockedFunction<CallEndedListener> = jest.fn();
    service.onEnded(endedSink);
    await service.openMedia('sess-1', 'call-1');
    sessionService.getEngine.mockReturnValue(undefined);

    engineChangedListener('sess-1');

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(engine.setVoiceCallExternalAudio.mock.calls).toEqual([
      ['call-1', true],
      ['call-1', false],
    ]);
    expect(eventsGateway.emitCallEnded).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({
        id: 'call-1',
        state: 'ended',
        endReason: 'session_engine_unavailable',
        canAccept: false,
        canReject: false,
      }),
    );
    expect(endedSink).toHaveBeenCalledTimes(1);
    const [endedEvent] = endedSink.mock.calls[0];
    expect(endedEvent.sessionId).toBe('sess-1');
    expect(endedEvent.call).toEqual(expect.objectContaining({ id: 'call-1', state: 'ended' }));
    expect(webhookService.dispatch).toHaveBeenCalledWith(
      'sess-1',
      'call.ended',
      expect.objectContaining({ id: 'call-1', state: 'ended' }),
    );
  });

  it('delegates outgoing and call-control operations to the voice engine', async () => {
    const started = await service.start('sess-1', ' 628999@c.us ');
    await service.accept('sess-1', 'call-1');
    await service.reject('sess-1', 'call-1', 'busy');
    await service.end('sess-1', 'call-1', 'done');
    await service.mute('sess-1', 'call-1', true);

    expect(started.peerId).toBe('628999@c.us');
    expect(engine.startVoiceCall).toHaveBeenCalledWith('628999@c.us');
    expect(engine.acceptVoiceCall).toHaveBeenCalledWith('call-1');
    expect(engine.rejectVoiceCall).toHaveBeenCalledWith('call-1', 'busy');
    expect(engine.endVoiceCall).toHaveBeenCalledWith('call-1', 'done');
    expect(engine.setVoiceCallMuted).toHaveBeenCalledWith('call-1', true);
  });

  it('rejects invalid lifecycle actions before invoking the engine', async () => {
    calls.set('call-1', makeCall({ canAccept: false, state: 'active' }));

    await expect(service.accept('sess-1', 'call-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(engine.acceptVoiceCall).not.toHaveBeenCalled();
  });

  it('rejects mutations and media for a stale non-ended snapshot the engine dropped', async () => {
    await service.list('sess-1');
    calls.clear();

    await expect(service.accept('sess-1', 'call-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.reject('sess-1', 'call-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.end('sess-1', 'call-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.mute('sess-1', 'call-1', true)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.openMedia('sess-1', 'call-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(() => service.feedAudio('sess-1', 'call-1', new Float32Array([0]))).toThrow(NotFoundException);

    expect(engine.acceptVoiceCall).not.toHaveBeenCalled();
    expect(engine.rejectVoiceCall).not.toHaveBeenCalled();
    expect(engine.endVoiceCall).not.toHaveBeenCalled();
    expect(engine.setVoiceCallMuted).not.toHaveBeenCalled();
    expect(engine.setVoiceCallExternalAudio).not.toHaveBeenCalled();
    expect(engine.feedVoiceCallAudio).not.toHaveBeenCalled();
  });

  it('dispatches lifecycle snapshots but keeps raw audio off the control plane', async () => {
    await service.list('sess-1');
    let capturedAudio: CallAudioFrame | undefined;
    const audioSink = jest.fn((frame: CallAudioFrame) => {
      capturedAudio = frame;
    });
    service.onAudio(audioSink);
    const active = makeCall({ state: 'active', canAccept: false, canReject: false });
    const ended = makeCall({ state: 'ended', canAccept: false, canReject: false });

    listener({ type: 'incoming', call: makeCall() });
    listener({ type: 'state', call: active });
    listener({ type: 'ended', call: ended });
    listener({ type: 'error', callId: 'call-1', error: new Error('media failed') });
    listener({ type: 'audio', call: active, pcm: new Float32Array([0.25]) });

    expect(eventsGateway.emitCallIncoming).toHaveBeenCalledWith('sess-1', expect.objectContaining({ id: 'call-1' }));
    expect(eventsGateway.emitCallState).toHaveBeenCalledWith('sess-1', expect.objectContaining({ state: 'active' }));
    expect(eventsGateway.emitCallEnded).toHaveBeenCalledWith('sess-1', expect.objectContaining({ state: 'ended' }));
    expect(eventsGateway.emitCallError).toHaveBeenCalledWith('sess-1', {
      callId: 'call-1',
      error: 'media failed',
    });
    expect(webhookService.dispatch.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      'call.incoming',
      'call.state',
      'call.ended',
      'call.error',
    ]);
    expect(audioSink).toHaveBeenCalledTimes(1);
    expect(capturedAudio?.sessionId).toBe('sess-1');
    expect(capturedAudio?.callId).toBe('call-1');
    expect(capturedAudio?.pcm).toBeInstanceOf(Float32Array);
    const dispatchedPayloads = webhookService.dispatch.mock.calls.map((call: unknown[]) => call[2]);
    expect(
      dispatchedPayloads.every(payload => typeof payload === 'object' && payload !== null && !('pcm' in payload)),
    ).toBe(true);
  });

  it('unsubscribes the previous listener when the engine instance changes', async () => {
    await service.openMedia('sess-1', 'call-1');
    const replacementUnsubscribe = jest.fn();
    const replacementOnVoiceCallEvent = jest.fn().mockReturnValue(replacementUnsubscribe);
    const replacement = {
      ...engine,
      getVoiceCalls: jest.fn().mockReturnValue([]),
      onVoiceCallEvent: replacementOnVoiceCallEvent,
    } as unknown as IVoiceCallEngine;
    sessionService.getEngine.mockReturnValue(replacement);

    await service.list('sess-1');

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(engine.setVoiceCallExternalAudio).toHaveBeenLastCalledWith('call-1', false);
    expect(replacementOnVoiceCallEvent).toHaveBeenCalledTimes(1);
  });

  it('turns a state-only terminal transition into one idempotent ended notification', async () => {
    await service.list('sess-1');
    const endedSink: jest.MockedFunction<CallEndedListener> = jest.fn();
    service.onEnded(endedSink);
    const ended = makeCall({ state: 'ended', canAccept: false, canReject: false });

    listener({ type: 'state', call: ended });
    listener({ type: 'ended', call: ended });
    listener({ type: 'ended', call: ended });

    expect(eventsGateway.emitCallState).toHaveBeenCalledTimes(1);
    expect(eventsGateway.emitCallEnded).toHaveBeenCalledTimes(1);
    expect(endedSink).toHaveBeenCalledTimes(1);
    expect(webhookService.dispatch.mock.calls.filter((call: unknown[]) => call[1] === 'call.ended')).toHaveLength(1);
  });

  it('opens external audio only for an owned, non-ended call and exposes engine watermarks', async () => {
    const result = await service.openMedia('sess-1', 'call-1');

    expect(result.watermarks).toEqual({ pauseMs: 500, resumeMs: 200 });
    expect(engine.setVoiceCallExternalAudio).toHaveBeenCalledWith('call-1', true);
    expect(() => service.feedAudio('sess-1', 'foreign', new Float32Array([0]))).toThrow(NotFoundException);
  });
});
