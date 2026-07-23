import type { IWhatsAppEngine } from './whatsapp-engine.interface';

export const VOICE_CALL_SAMPLE_RATE = 16_000;

export type VoiceCallDirection = 'incoming' | 'outgoing';
export type VoiceCallState =
  'initiating' | 'ringing' | 'incoming_ringing' | 'connecting' | 'active' | 'on_hold' | 'ended';

export interface VoiceCall {
  id: string;
  peerId: string;
  direction: VoiceCallDirection;
  state: VoiceCallState;
  media: 'audio';
  muted: boolean;
  createdAt: string;
  connectedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  endReason?: string;
  canAccept: boolean;
  canReject: boolean;
}

export type VoiceCallEvent =
  | { type: 'incoming'; call: VoiceCall }
  | { type: 'state'; call: VoiceCall }
  | { type: 'ended'; call: VoiceCall }
  | { type: 'audio'; call: VoiceCall; pcm: Float32Array }
  | { type: 'error'; error: Error; callId?: string };

export type VoiceCallEventListener = (event: VoiceCallEvent) => void;

/**
 * Optional engine capability for real-time, one-to-one voice calls.
 *
 * Audio crossing this boundary is mono Float32 PCM at 16 kHz. Signaling-only
 * adapters must not implement this interface: the type guard is deliberately
 * structural so REST callers receive a clear 501 for engines without media.
 */
export interface IVoiceCallEngine extends IWhatsAppEngine {
  startVoiceCall(peerId: string): Promise<VoiceCall>;
  acceptVoiceCall(callId: string): Promise<void>;
  rejectVoiceCall(callId: string, reason?: string): Promise<void>;
  endVoiceCall(callId: string, reason?: string): Promise<void>;
  setVoiceCallMuted(callId: string, muted: boolean): void;
  setVoiceCallExternalAudio(callId: string, enabled: boolean): void;
  feedVoiceCallAudio(callId: string, pcm: Float32Array): number;
  getVoiceCallAudioWatermarks(): { pauseMs: number; resumeMs: number };
  getVoiceCall(callId: string): VoiceCall | null;
  getVoiceCalls(): readonly VoiceCall[];
  onVoiceCallEvent(listener: VoiceCallEventListener): () => void;
}

export function isVoiceCallEngine(engine: IWhatsAppEngine | undefined): engine is IVoiceCallEngine {
  return (
    !!engine &&
    typeof (engine as Partial<IVoiceCallEngine>).startVoiceCall === 'function' &&
    typeof (engine as Partial<IVoiceCallEngine>).feedVoiceCallAudio === 'function' &&
    typeof (engine as Partial<IVoiceCallEngine>).onVoiceCallEvent === 'function'
  );
}
