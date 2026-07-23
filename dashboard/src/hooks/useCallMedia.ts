import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { io, type Socket } from 'socket.io-client';
import callCaptureWorkletUrl from '../worklets/callCapture.worklet.ts?worker&url';
import {
  BoundedPcmQueue,
  CALL_FRAME_SAMPLES,
  CALL_SAMPLE_RATE,
  StreamingPcmResampler,
  decodeFloat32Pcm,
} from '../utils/callAudio';
import { callBackpressureDelayMs, resetCallPlayback } from '../utils/callMediaLifecycle';
import { warnIfInsecureHttpUrl } from '../utils/urlSecurity';

const PLAYBACK_START_SAMPLES = Math.round(CALL_SAMPLE_RATE * 0.06);
const PLAYBACK_MAX_SAMPLES = Math.round(CALL_SAMPLE_RATE * 0.5);
const PLAYBACK_SCHEDULE_AHEAD_SECONDS = 0.18;
const UPLINK_MAX_SAMPLES = CALL_SAMPLE_RATE;

export type CallMediaStatus = 'idle' | 'requesting' | 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'error';

type BinaryFrame = ArrayBuffer | ArrayBufferView | Blob;

interface CallGatewayResponse {
  ok: boolean;
  code?: string;
  message?: string;
  accepted?: boolean;
  queuedMs?: number;
  paused?: boolean;
  retryAfterMs?: number;
}

type BackpressurePayload = boolean | { active?: boolean; paused?: boolean; queuedMs?: number; retryAfterMs?: number };

interface CallsServerEvents {
  joined: (payload?: CallGatewayResponse & { sessionId?: string; callId?: string }) => void;
  backpressure: (payload?: BackpressurePayload) => void;
  'call:downlink': (frame: BinaryFrame) => void;
  'call-ended': (payload?: unknown) => void;
  error: (payload?: string | CallGatewayResponse) => void;
  'call:error': (payload?: string | CallGatewayResponse) => void;
}

interface CallsClientEvents {
  'join-call': (payload: { sessionId: string; callId: string }, ack: (response: CallGatewayResponse) => void) => void;
  'leave-call': (payload: { sessionId: string; callId: string }) => void;
  'call:uplink': (frame: ArrayBuffer, ack: (response: CallGatewayResponse) => void) => void;
}

type CallsSocket = Socket<CallsServerEvents, CallsClientEvents>;

interface MediaResources {
  sessionId: string;
  callId: string;
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  captureNode?: AudioNode;
  silentGain?: GainNode;
  socket?: CallsSocket;
  resampler?: StreamingPcmResampler;
  uplinkQueue: BoundedPcmQueue;
  playbackQueue: BoundedPcmQueue;
  playbackStarted: boolean;
  playbackCursor: number;
  playbackPump?: number;
  backpressureTimer?: number;
  uplinkInFlight: boolean;
  scheduledSources: Set<AudioBufferSourceNode>;
  released: boolean;
  releaseCapture?: () => void;
  onReconnectAttempt?: () => void;
  isActive: () => boolean;
  onBackpressure: (active: boolean) => void;
  onGatewayError: (payload: unknown) => void;
}

interface UseCallMediaOptions {
  onCallEnded?: (payload?: unknown) => void;
}

interface UseCallMediaResult {
  status: CallMediaStatus;
  error: string | null;
  activeCallId: string | null;
  muted: boolean;
  backpressured: boolean;
  start: (sessionId: string, callId: string, initiallyMuted?: boolean) => Promise<void>;
  stop: () => void;
  setMuted: (muted: boolean) => void;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string' && payload.trim()) return payload;
  if (payload && typeof payload === 'object' && 'message' in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

function gatewayErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || !('code' in payload)) return undefined;
  const code = (payload as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

const FATAL_GATEWAY_CODES = new Set([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INVALID_JOIN',
  'CALL_NOT_FOUND',
  'ENGINE_NOT_SUPPORTED',
  'INVALID_CALL',
  'NOT_JOINED',
  'INVALID_AUDIO',
  'MEDIA_UNAVAILABLE',
  'UPLINK_NOT_OWNER',
]);

function clearBackpressure(resources: MediaResources): void {
  if (resources.backpressureTimer !== undefined) {
    window.clearTimeout(resources.backpressureTimer);
    resources.backpressureTimer = undefined;
  }
  resources.onBackpressure(false);
}

function pauseUplink(resources: MediaResources, retryAfterMs?: number): void {
  if (resources.backpressureTimer !== undefined) window.clearTimeout(resources.backpressureTimer);
  resources.uplinkQueue.clear();
  resources.onBackpressure(true);
  resources.backpressureTimer = window.setTimeout(() => {
    resources.backpressureTimer = undefined;
  }, callBackpressureDelayMs(retryAfterMs));
}

function flushUplink(resources: MediaResources): void {
  const socket = resources.socket;
  if (
    !resources.isActive() ||
    resources.uplinkInFlight ||
    resources.backpressureTimer !== undefined ||
    !socket?.connected ||
    resources.uplinkQueue.bufferedSamples < CALL_FRAME_SAMPLES
  )
    return;

  const frame = resources.uplinkQueue.dequeue(CALL_FRAME_SAMPLES);
  const buffer = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer;
  resources.uplinkInFlight = true;
  socket.emit('call:uplink', buffer, response => {
    resources.uplinkInFlight = false;
    if (!resources.isActive()) return;
    if (!response?.ok) {
      if (response?.code === 'UPLINK_RATE_EXCEEDED') pauseUplink(resources, 100);
      resources.onGatewayError(response);
      return;
    }
    if (response.accepted === false || response.paused) {
      pauseUplink(resources, response.retryAfterMs);
      return;
    }
    clearBackpressure(resources);
    flushUplink(resources);
  });
}

function emitPcmFrames(resources: MediaResources, input: Float32Array, muted: boolean): void {
  const resampled = resources.resampler?.process(input);
  if (!resampled || resampled.length === 0) return;
  if (muted || resources.backpressureTimer !== undefined || !resources.socket?.connected) {
    resources.uplinkQueue.clear();
    return;
  }
  resources.uplinkQueue.enqueue(resampled);
  flushUplink(resources);
}

function pumpPlayback(resources: MediaResources): void {
  const context = resources.context;
  if (!context || context.state === 'closed') return;

  const now = context.currentTime;
  if (!resources.playbackStarted) {
    if (resources.playbackQueue.bufferedSamples < PLAYBACK_START_SAMPLES) return;
    resources.playbackStarted = true;
    resources.playbackCursor = now + 0.025;
  } else if (resources.playbackCursor <= now && resources.playbackQueue.bufferedSamples === 0) {
    resources.playbackStarted = false;
    resources.playbackCursor = 0;
    return;
  } else if (resources.playbackCursor < now) {
    resources.playbackCursor = now + 0.025;
  }

  const scheduleUntil = now + PLAYBACK_SCHEDULE_AHEAD_SECONDS;
  while (resources.playbackQueue.bufferedSamples > 0 && resources.playbackCursor < scheduleUntil) {
    const availableWindow = Math.max(1, Math.floor((scheduleUntil - resources.playbackCursor) * CALL_SAMPLE_RATE));
    const pcm = resources.playbackQueue.dequeue(availableWindow);
    if (pcm.length === 0) break;

    const audioBuffer = context.createBuffer(1, pcm.length, CALL_SAMPLE_RATE);
    audioBuffer.getChannelData(0).set(pcm);
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    source.onended = () => {
      resources.scheduledSources.delete(source);
      source.disconnect();
    };
    resources.scheduledSources.add(source);
    source.start(resources.playbackCursor);
    resources.playbackCursor += pcm.length / CALL_SAMPLE_RATE;
  }
}

async function decodeSocketFrame(frame: BinaryFrame): Promise<Float32Array> {
  if (frame instanceof Blob) {
    return decodeFloat32Pcm(await frame.arrayBuffer());
  }
  return decodeFloat32Pcm(frame);
}

function disposeMediaResources(resources: MediaResources, notifyServer: boolean): void {
  if (resources.released) return;
  resources.released = true;

  if (resources.playbackPump !== undefined) window.clearInterval(resources.playbackPump);
  if (resources.backpressureTimer !== undefined) window.clearTimeout(resources.backpressureTimer);
  resources.uplinkInFlight = false;

  resources.releaseCapture?.();
  resources.captureNode?.disconnect();
  resources.source?.disconnect();
  resources.silentGain?.disconnect();
  resetCallPlayback(resources);
  resources.uplinkQueue.clear();
  resources.resampler?.reset();

  for (const track of resources.stream?.getTracks() ?? []) track.stop();

  if (resources.socket) {
    if (resources.onReconnectAttempt) {
      resources.socket.io.off('reconnect_attempt', resources.onReconnectAttempt);
    }
    if (notifyServer && resources.socket.connected) {
      resources.socket.emit('leave-call', {
        sessionId: resources.sessionId,
        callId: resources.callId,
      });
    }
    resources.socket.removeAllListeners();
    resources.socket.disconnect();
  }

  if (resources.context && resources.context.state !== 'closed') {
    void resources.context.close().catch(() => undefined);
  }
}

/**
 * Owns the browser audio graph and the authenticated `/calls` Socket.IO
 * connection. Nothing is created until `start` is called from an explicit user
 * action, preserving browser autoplay and microphone-permission expectations.
 */
export function useCallMedia(options: UseCallMediaOptions = {}): UseCallMediaResult {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CallMediaStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [muted, setMutedState] = useState(false);
  const [backpressured, setBackpressured] = useState(false);
  const resourcesRef = useRef<MediaResources | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const mutedRef = useRef(false);
  const onCallEndedRef = useRef(options.onCallEnded);

  useEffect(() => {
    onCallEndedRef.current = options.onCallEnded;
  }, [options.onCallEnded]);

  const release = useCallback((notifyServer: boolean) => {
    const resources = resourcesRef.current;
    resourcesRef.current = null;
    if (!resources) return;
    disposeMediaResources(resources, notifyServer);
  }, []);

  const stop = useCallback(() => {
    generationRef.current += 1;
    release(true);
    mutedRef.current = false;
    if (mountedRef.current) {
      setStatus('idle');
      setError(null);
      setActiveCallId(null);
      setMutedState(false);
      setBackpressured(false);
    }
  }, [release]);

  const setMuted = useCallback((nextMuted: boolean) => {
    mutedRef.current = nextMuted;
    const resources = resourcesRef.current;
    for (const track of resources?.stream?.getAudioTracks() ?? []) {
      track.enabled = !nextMuted;
    }
    if (nextMuted) resources?.uplinkQueue.clear();
    if (mountedRef.current) setMutedState(nextMuted);
  }, []);

  const start = useCallback(
    async (sessionId: string, callId: string, initiallyMuted = false) => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      release(true);

      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('error');
        setError(t('calls.errors.microphoneUnsupported'));
        setActiveCallId(null);
        return;
      }

      const apiKey = sessionStorage.getItem('openwa_api_key');
      if (!apiKey) {
        setStatus('error');
        setError(t('calls.errors.authRequired'));
        setActiveCallId(null);
        return;
      }

      const resources: MediaResources = {
        sessionId,
        callId,
        uplinkQueue: new BoundedPcmQueue(UPLINK_MAX_SAMPLES),
        playbackQueue: new BoundedPcmQueue(PLAYBACK_MAX_SAMPLES),
        playbackStarted: false,
        playbackCursor: 0,
        uplinkInFlight: false,
        scheduledSources: new Set(),
        released: false,
        isActive: () => resourcesRef.current === resources,
        onBackpressure: active => {
          if (resourcesRef.current === resources) setBackpressured(active);
        },
        onGatewayError: payload => {
          if (resourcesRef.current !== resources) return;
          const code = gatewayErrorCode(payload);
          if (code === 'UPLINK_RATE_EXCEEDED') return;
          const message = errorMessage(payload, t('calls.errors.connection'));
          setError(message);
          if (!code || !FATAL_GATEWAY_CODES.has(code)) return;

          if (resources.socket) resources.socket.io.opts.reconnection = false;
          generationRef.current += 1;
          release(false);
          setStatus('error');
          setActiveCallId(null);
          setBackpressured(false);
        },
      };
      resourcesRef.current = resources;
      mutedRef.current = initiallyMuted;
      setMutedState(initiallyMuted);
      setBackpressured(false);
      setError(null);
      setActiveCallId(callId);
      setStatus('requesting');

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: { ideal: 1 },
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        for (const track of stream.getAudioTracks()) track.enabled = !initiallyMuted;

        if (generationRef.current !== generation || resourcesRef.current !== resources) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        resources.stream = stream;

        const context = new AudioContext({ latencyHint: 'interactive' });
        resources.context = context;
        await context.resume();
        if (generationRef.current !== generation || resourcesRef.current !== resources) {
          disposeMediaResources(resources, false);
          return;
        }

        const source = context.createMediaStreamSource(stream);
        const silentGain = context.createGain();
        silentGain.gain.value = 0;
        resources.source = source;
        resources.silentGain = silentGain;
        resources.resampler = new StreamingPcmResampler(context.sampleRate, CALL_SAMPLE_RATE);

        const handleCapture = (input: Float32Array) => {
          if (resourcesRef.current !== resources) return;
          emitPcmFrames(resources, input, mutedRef.current);
        };

        // AudioWorklet keeps capture off the main thread. CSP restrictions or
        // older browsers can reject addModule; ScriptProcessor is retained as a
        // functional fallback rather than failing the call after mic permission.
        if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
          try {
            await context.audioWorklet.addModule(callCaptureWorkletUrl);
            if (generationRef.current !== generation || resourcesRef.current !== resources) {
              disposeMediaResources(resources, false);
              return;
            }
            const worklet = new AudioWorkletNode(context, 'openwa-call-capture', {
              numberOfInputs: 1,
              numberOfOutputs: 1,
              outputChannelCount: [1],
              channelCount: 1,
              channelCountMode: 'explicit',
            });
            worklet.port.onmessage = event => {
              if (event.data instanceof ArrayBuffer) handleCapture(new Float32Array(event.data));
            };
            resources.captureNode = worklet;
            resources.releaseCapture = () => {
              worklet.port.onmessage = null;
              worklet.port.close();
            };
            source.connect(worklet);
            worklet.connect(silentGain);
          } catch {
            if (generationRef.current !== generation || resourcesRef.current !== resources) {
              disposeMediaResources(resources, false);
              return;
            }
            const processor = context.createScriptProcessor(1024, 1, 1);
            processor.onaudioprocess = event => {
              event.outputBuffer.getChannelData(0).fill(0);
              handleCapture(event.inputBuffer.getChannelData(0));
            };
            resources.captureNode = processor;
            resources.releaseCapture = () => {
              processor.onaudioprocess = null;
            };
            source.connect(processor);
            processor.connect(silentGain);
          }
        } else {
          const processor = context.createScriptProcessor(1024, 1, 1);
          processor.onaudioprocess = event => {
            event.outputBuffer.getChannelData(0).fill(0);
            handleCapture(event.inputBuffer.getChannelData(0));
          };
          resources.captureNode = processor;
          resources.releaseCapture = () => {
            processor.onaudioprocess = null;
          };
          source.connect(processor);
          processor.connect(silentGain);
        }
        silentGain.connect(context.destination);

        resources.playbackPump = window.setInterval(() => pumpPlayback(resources), 20);

        const socketOrigin = import.meta.env.VITE_WS_URL || window.location.origin;
        warnIfInsecureHttpUrl(socketOrigin, 'VITE_WS_URL');
        const socket: CallsSocket = io(`${socketOrigin.replace(/\/+$/, '')}/calls`, {
          autoConnect: false,
          reconnection: true,
          reconnectionAttempts: Infinity,
          reconnectionDelay: 500,
          reconnectionDelayMax: 5_000,
          auth: { apiKey },
        });
        resources.socket = socket;

        socket.on('connect', () => {
          if (resourcesRef.current !== resources) return;
          setStatus('connecting');
          setError(null);
          socket.emit('join-call', { sessionId, callId }, response => {
            if (resourcesRef.current !== resources) return;
            if (!response?.ok) {
              resources.onGatewayError(response);
              return;
            }
            setStatus('connected');
            setError(null);
          });
        });
        socket.on('joined', payload => {
          if (resourcesRef.current !== resources) return;
          if (payload?.ok === false) {
            resources.onGatewayError(payload);
            return;
          }
          setStatus('connected');
          setError(null);
        });
        socket.on('disconnect', () => {
          if (resourcesRef.current !== resources) return;
          resources.uplinkInFlight = false;
          resources.uplinkQueue.clear();
          resetCallPlayback(resources);
          clearBackpressure(resources);
          setStatus('reconnecting');
        });
        resources.onReconnectAttempt = () => {
          if (resourcesRef.current === resources) setStatus('reconnecting');
        };
        socket.io.on('reconnect_attempt', resources.onReconnectAttempt);
        socket.on('connect_error', event => {
          if (resourcesRef.current !== resources) return;
          setStatus('reconnecting');
          setError(event.message);
        });
        socket.on('backpressure', payload => {
          if (resourcesRef.current !== resources) return;
          const active = typeof payload === 'boolean' ? payload : (payload?.active ?? payload?.paused ?? true);
          if (active) {
            pauseUplink(resources, typeof payload === 'object' ? payload.retryAfterMs : undefined);
          } else {
            clearBackpressure(resources);
            flushUplink(resources);
          }
        });
        socket.on('call:downlink', frame => {
          void decodeSocketFrame(frame)
            .then(pcm => {
              if (resourcesRef.current !== resources) return;
              resources.playbackQueue.enqueue(pcm);
              pumpPlayback(resources);
            })
            .catch(frameError => {
              if (resourcesRef.current === resources) {
                setError(errorMessage(frameError, t('calls.errors.invalidAudio')));
              }
            });
        });
        socket.on('call-ended', payload => {
          if (resourcesRef.current !== resources) return;
          generationRef.current += 1;
          release(false);
          setStatus('ended');
          setActiveCallId(null);
          setBackpressured(false);
          onCallEndedRef.current?.(payload);
        });
        socket.on('error', payload => {
          resources.onGatewayError(payload);
        });
        socket.on('call:error', payload => resources.onGatewayError(payload));

        setStatus('connecting');
        socket.connect();
      } catch (startError) {
        if (generationRef.current !== generation) return;
        release(false);
        setStatus('error');
        setError(errorMessage(startError, t('calls.errors.audioStart')));
        setActiveCallId(null);
      }
    },
    [release, t],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      release(true);
    };
  }, [release]);

  return { status, error, activeCallId, muted, backpressured, start, stop, setMuted };
}
