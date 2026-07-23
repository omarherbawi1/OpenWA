import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Headphones,
  Loader2,
  Mic,
  MicOff,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneOff,
  X,
} from 'lucide-react';
import { callApi, type CallState, type VoiceCall } from '../services/api';
import { useCallMedia } from '../hooks/useCallMedia';
import { pickSelectedOngoingCallId } from '../utils/callSelection';
import './CallPanel.css';

interface CallPanelProps {
  sessionId: string;
  suggestedPeerId?: string;
  canCall: boolean;
  refreshToken?: number;
}

type CallAction = 'dial' | 'accept' | 'reject' | 'join' | 'mute' | 'end' | null;

const TERMINAL_STATES = new Set<CallState>(['ended']);
const ANSWERING_STATES = new Set<CallState>(['initiating', 'ringing', 'incoming_ringing']);

function isOngoing(call: VoiceCall): boolean {
  return !TERMINAL_STATES.has(call.state);
}

function isIncomingRinging(call: VoiceCall): boolean {
  return call.direction === 'incoming' && (call.canAccept || call.canReject || ANSWERING_STATES.has(call.state));
}

function sortNewestFirst(calls: VoiceCall[]): VoiceCall[] {
  return [...calls].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function actionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CallPanel({ sessionId, suggestedPeerId = '', canCall, refreshToken = 0 }: CallPanelProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [calls, setCalls] = useState<VoiceCall[]>([]);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [peerId, setPeerId] = useState(suggestedPeerId);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<CallAction>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const refreshRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const seenIncomingRef = useRef(new Set<string>());

  const refreshCalls = useCallback(
    async (showLoading = false) => {
      if (!sessionId) return;
      const requestId = refreshRequestRef.current + 1;
      refreshRequestRef.current = requestId;
      if (showLoading && mountedRef.current) setLoading(true);

      try {
        const data = sortNewestFirst(await callApi.list(sessionId));
        if (!mountedRef.current || refreshRequestRef.current !== requestId) return;
        setCalls(data);
        setPanelError(null);

        const ongoing = data.filter(isOngoing);
        const incoming = ongoing.find(isIncomingRinging);
        setSelectedCallId(previous =>
          pickSelectedOngoingCallId(previous, data, seenIncomingRef.current, isOngoing, isIncomingRinging),
        );

        if (incoming && !seenIncomingRef.current.has(incoming.id)) {
          seenIncomingRef.current.add(incoming.id);
          setOpen(true);
        }

        const liveIncomingIds = new Set(data.filter(isIncomingRinging).map(call => call.id));
        for (const seenId of seenIncomingRef.current) {
          if (!liveIncomingIds.has(seenId)) seenIncomingRef.current.delete(seenId);
        }
      } catch (error) {
        if (mountedRef.current && refreshRequestRef.current === requestId) {
          setPanelError(t('calls.errors.load', { message: actionErrorMessage(error) }));
        }
      } finally {
        if (mountedRef.current && refreshRequestRef.current === requestId) setLoading(false);
      }
    },
    [sessionId, t],
  );

  const handleCallEnded = useCallback(() => {
    void refreshCalls();
  }, [refreshCalls]);
  const media = useCallMedia({ onCallEnded: handleCallEnded });
  const stopMedia = media.stop;
  const mediaActiveCallId = media.activeCallId;
  const mediaMuted = media.muted;
  const setMediaMuted = media.setMuted;

  const ongoingCalls = useMemo(() => calls.filter(isOngoing), [calls]);
  const incomingCount = useMemo(() => ongoingCalls.filter(isIncomingRinging).length, [ongoingCalls]);
  const currentCall = useMemo(
    () => calls.find(call => call.id === selectedCallId) ?? ongoingCalls[0] ?? null,
    [calls, ongoingCalls, selectedCallId],
  );

  const updateCall = useCallback((updated: VoiceCall | undefined) => {
    if (!updated) return;
    setCalls(previous => sortNewestFirst([updated, ...previous.filter(call => call.id !== updated.id)]));
    setSelectedCallId(updated.id);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    refreshRequestRef.current += 1;
    stopMedia();
    setCalls([]);
    setSelectedCallId(null);
    setPanelError(null);
    seenIncomingRef.current.clear();
  }, [sessionId, stopMedia]);

  useEffect(() => {
    void refreshCalls(true);
    const pollMs = open ? 3_000 : 15_000;
    const poll = window.setInterval(() => {
      void refreshCalls();
    }, pollMs);
    return () => window.clearInterval(poll);
  }, [open, refreshCalls]);

  useEffect(() => {
    if (refreshToken > 0) void refreshCalls();
  }, [refreshCalls, refreshToken]);

  useEffect(() => {
    if (!open && !currentCall) setPeerId(suggestedPeerId);
  }, [currentCall, open, suggestedPeerId]);

  useEffect(() => {
    if (
      mediaActiveCallId &&
      (!currentCall || currentCall.id !== mediaActiveCallId || TERMINAL_STATES.has(currentCall.state))
    ) {
      stopMedia();
    }
  }, [currentCall, mediaActiveCallId, stopMedia]);

  useEffect(() => {
    if (currentCall && mediaActiveCallId === currentCall.id && currentCall.muted !== mediaMuted && action !== 'mute') {
      setMediaMuted(currentCall.muted);
    }
  }, [action, currentCall, mediaActiveCallId, mediaMuted, setMediaMuted]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [open]);

  const openPanel = () => {
    if (!currentCall && suggestedPeerId) setPeerId(suggestedPeerId);
    setOpen(true);
  };

  const handleDial = async (event: FormEvent) => {
    event.preventDefault();
    const target = peerId.trim();
    if (!target) {
      setPanelError(t('calls.errors.peerRequired'));
      return;
    }

    setAction('dial');
    setPanelError(null);
    try {
      updateCall(await callApi.create(sessionId, { peerId: target }));
      await refreshCalls();
    } catch (error) {
      setPanelError(t('calls.errors.action', { message: actionErrorMessage(error) }));
    } finally {
      setAction(null);
    }
  };

  const handleAccept = async () => {
    if (!currentCall) return;
    setAction('accept');
    setPanelError(null);
    try {
      await callApi.accept(sessionId, currentCall.id);
      await refreshCalls();
    } catch (error) {
      setPanelError(t('calls.errors.action', { message: actionErrorMessage(error) }));
    } finally {
      setAction(null);
    }
  };

  const handleReject = async () => {
    if (!currentCall) return;
    setAction('reject');
    setPanelError(null);
    try {
      await callApi.reject(sessionId, currentCall.id);
      if (media.activeCallId === currentCall.id) media.stop();
      await refreshCalls();
    } catch (error) {
      setPanelError(t('calls.errors.action', { message: actionErrorMessage(error) }));
    } finally {
      setAction(null);
    }
  };

  const handleJoin = async () => {
    if (!currentCall) return;
    setAction('join');
    setPanelError(null);
    try {
      await media.start(sessionId, currentCall.id, currentCall.muted);
    } finally {
      setAction(null);
    }
  };

  const handleMute = async () => {
    if (!currentCall) return;
    const nextMuted = !media.muted;
    setAction('mute');
    setPanelError(null);
    media.setMuted(nextMuted);
    try {
      await callApi.mute(sessionId, currentCall.id, nextMuted);
      await refreshCalls();
    } catch (error) {
      media.setMuted(!nextMuted);
      setPanelError(t('calls.errors.action', { message: actionErrorMessage(error) }));
    } finally {
      setAction(null);
    }
  };

  const handleEnd = async () => {
    if (!currentCall) return;
    setAction('end');
    setPanelError(null);
    try {
      await callApi.end(sessionId, currentCall.id);
      if (media.activeCallId === currentCall.id) media.stop();
      await refreshCalls();
    } catch (error) {
      setPanelError(t('calls.errors.action', { message: actionErrorMessage(error) }));
    } finally {
      setAction(null);
    }
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    // Prevent an Enter key on the dialog shell from accidentally re-submitting
    // the dial form after focus moves to another call control.
    if (event.key === 'Enter' && event.target === event.currentTarget) event.preventDefault();
  };

  const audioJoined = Boolean(
    currentCall &&
    media.activeCallId === currentCall.id &&
    media.status !== 'idle' &&
    media.status !== 'ended' &&
    media.status !== 'error',
  );
  const currentIsTerminal = currentCall ? !isOngoing(currentCall) : false;
  const incomingRinging = currentCall ? isIncomingRinging(currentCall) : false;
  const controlsDisabled = action !== null || !canCall;

  return (
    <>
      <button
        type="button"
        className={`call-panel-trigger ${ongoingCalls.length > 0 ? 'is-active' : ''}`}
        onClick={openPanel}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {incomingCount > 0 ? <PhoneIncoming size={18} aria-hidden="true" /> : <Phone size={18} aria-hidden="true" />}
        <span>{t('calls.open')}</span>
        {incomingCount > 0 && (
          <span className="call-panel-trigger__badge" aria-label={t('calls.incomingCount', { count: incomingCount })}>
            {incomingCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="call-panel-backdrop"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            ref={dialogRef}
            className="call-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="call-panel-title"
            aria-describedby="call-panel-description"
            onKeyDown={handleDialogKeyDown}
          >
            <header className="call-panel__header">
              <div>
                <h2 id="call-panel-title">{incomingRinging ? t('calls.incomingTitle') : t('calls.title')}</h2>
                <p id="call-panel-description">{t('calls.audioOnly')}</p>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                className="call-panel__close"
                onClick={() => setOpen(false)}
                aria-label={t('calls.close')}
              >
                <X size={20} aria-hidden="true" />
              </button>
            </header>

            <div className="call-panel__body">
              {loading && calls.length === 0 ? (
                <div className="call-panel__loading" role="status">
                  <Loader2 className="animate-spin" size={24} aria-hidden="true" />
                  <span>{t('calls.loading')}</span>
                </div>
              ) : currentCall ? (
                <div className="call-panel__current">
                  <div className={`call-panel__avatar ${incomingRinging ? 'is-ringing' : ''}`}>
                    {incomingRinging ? (
                      <PhoneIncoming size={30} aria-hidden="true" />
                    ) : (
                      <PhoneCall size={30} aria-hidden="true" />
                    )}
                  </div>
                  <div className="call-panel__identity">
                    <span className="call-panel__direction">{t(`calls.direction.${currentCall.direction}`)}</span>
                    <strong dir="ltr">{currentCall.peerId}</strong>
                    <span className={`call-panel__status status-${currentCall.state}`} role="status" aria-live="polite">
                      {t(`calls.status.${currentCall.state}`, { defaultValue: t('calls.status.unknown') })}
                    </span>
                  </div>

                  {(audioJoined || media.status === 'error') && (
                    <div className="call-panel__connection" role="status" aria-live="polite">
                      <Headphones size={16} aria-hidden="true" />
                      <span>{t(`calls.connection.${media.status}`)}</span>
                    </div>
                  )}

                  {media.backpressured && (
                    <div className="call-panel__notice" role="status">
                      <AlertCircle size={16} aria-hidden="true" />
                      <span>{t('calls.backpressure')}</span>
                    </div>
                  )}

                  {incomingRinging ? (
                    <div className="call-panel__actions">
                      <button
                        type="button"
                        className="call-panel__button call-panel__button--accept"
                        onClick={() => void handleAccept()}
                        disabled={controlsDisabled || !currentCall.canAccept}
                      >
                        {action === 'accept' ? <Loader2 className="animate-spin" size={18} /> : <PhoneCall size={18} />}
                        {t('calls.accept')}
                      </button>
                      <button
                        type="button"
                        className="call-panel__button call-panel__button--danger"
                        onClick={() => void handleReject()}
                        disabled={controlsDisabled || !currentCall.canReject}
                      >
                        {action === 'reject' ? <Loader2 className="animate-spin" size={18} /> : <PhoneOff size={18} />}
                        {t('calls.reject')}
                      </button>
                    </div>
                  ) : currentIsTerminal ? (
                    <button
                      type="button"
                      className="call-panel__button call-panel__button--primary call-panel__button--wide"
                      onClick={() => {
                        setSelectedCallId(null);
                        setPeerId(suggestedPeerId);
                      }}
                    >
                      <Phone size={18} aria-hidden="true" />
                      {t('calls.newCall')}
                    </button>
                  ) : (
                    <div className="call-panel__actions">
                      {audioJoined ? (
                        <button
                          type="button"
                          className={`call-panel__button ${media.muted ? 'call-panel__button--muted' : ''}`}
                          onClick={() => void handleMute()}
                          disabled={controlsDisabled}
                          aria-pressed={media.muted}
                        >
                          {action === 'mute' ? (
                            <Loader2 className="animate-spin" size={18} />
                          ) : media.muted ? (
                            <MicOff size={18} />
                          ) : (
                            <Mic size={18} />
                          )}
                          {media.muted ? t('calls.unmute') : t('calls.mute')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="call-panel__button call-panel__button--primary"
                          onClick={() => void handleJoin()}
                          disabled={controlsDisabled}
                        >
                          {action === 'join' || media.status === 'requesting' ? (
                            <Loader2 className="animate-spin" size={18} />
                          ) : (
                            <Headphones size={18} />
                          )}
                          {action === 'join' ? t('calls.joiningAudio') : t('calls.joinAudio')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="call-panel__button call-panel__button--danger"
                        onClick={() => void handleEnd()}
                        disabled={controlsDisabled}
                      >
                        {action === 'end' ? <Loader2 className="animate-spin" size={18} /> : <PhoneOff size={18} />}
                        {t('calls.hangUp')}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <form className="call-panel__dial" onSubmit={event => void handleDial(event)}>
                  <label htmlFor="voice-call-peer">{t('calls.peerLabel')}</label>
                  <input
                    id="voice-call-peer"
                    type="text"
                    value={peerId}
                    onChange={event => setPeerId(event.target.value)}
                    placeholder={t('calls.peerPlaceholder')}
                    autoComplete="off"
                    dir="ltr"
                    disabled={!canCall || action !== null}
                  />
                  <p>{canCall ? t('calls.peerHint') : t('calls.noPermission')}</p>
                  <button
                    type="submit"
                    className="call-panel__button call-panel__button--primary call-panel__button--wide"
                    disabled={!canCall || action !== null || !peerId.trim()}
                  >
                    {action === 'dial' ? <Loader2 className="animate-spin" size={18} /> : <PhoneCall size={18} />}
                    {action === 'dial' ? t('calls.dialing') : t('calls.dial')}
                  </button>
                </form>
              )}

              {(panelError || media.error) && (
                <div className="call-panel__error" role="alert">
                  <AlertCircle size={17} aria-hidden="true" />
                  <span>{panelError || media.error}</span>
                </div>
              )}

              {ongoingCalls.length > 1 && (
                <div className="call-panel__switcher">
                  <label htmlFor="active-voice-call">{t('calls.activeCallLabel')}</label>
                  <select
                    id="active-voice-call"
                    value={currentCall?.id ?? ''}
                    onChange={event => {
                      const nextCallId = event.target.value;
                      if (media.activeCallId && media.activeCallId !== nextCallId) media.stop();
                      setSelectedCallId(nextCallId);
                    }}
                  >
                    {ongoingCalls.map(call => (
                      <option key={call.id} value={call.id}>
                        {call.peerId} — {t(`calls.status.${call.state}`, { defaultValue: t('calls.status.unknown') })}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
