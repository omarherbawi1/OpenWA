interface ClearableQueue {
  clear(): void;
}

interface PlaybackResources<TSource> {
  scheduledSources: Set<TSource>;
  playbackQueue: ClearableQueue;
  playbackStarted: boolean;
  playbackCursor: number;
}

type ScheduledSource = Pick<AudioBufferSourceNode, 'disconnect' | 'onended' | 'stop'>;

export function resetCallPlayback<TSource extends ScheduledSource>(resources: PlaybackResources<TSource>): void {
  for (const source of resources.scheduledSources) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      // A source that already ended cannot be stopped again.
    }
    source.disconnect();
  }
  resources.scheduledSources.clear();
  resources.playbackQueue.clear();
  resources.playbackStarted = false;
  resources.playbackCursor = 0;
}

export function callBackpressureDelayMs(retryAfterMs?: number): number {
  return Number.isFinite(retryAfterMs) && retryAfterMs !== undefined ? Math.max(50, retryAfterMs) : 250;
}
