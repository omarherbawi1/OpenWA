import assert from 'node:assert/strict';
import test from 'node:test';
import { callBackpressureDelayMs, resetCallPlayback } from './callMediaLifecycle.ts';

test('resetCallPlayback stops sources and clears buffered playback state', () => {
  const stopped: string[] = [];
  const disconnected: string[] = [];
  const first = {
    onended: () => undefined,
    stop: () => stopped.push('first'),
    disconnect: () => disconnected.push('first'),
  };
  const ended = {
    onended: () => undefined,
    stop: () => {
      throw new Error('already ended');
    },
    disconnect: () => disconnected.push('ended'),
  };
  const resources = {
    scheduledSources: new Set([first, ended]),
    playbackQueue: { clear: () => stopped.push('queue') },
    playbackStarted: true,
    playbackCursor: 42,
  };

  resetCallPlayback(resources);

  assert.deepEqual(stopped, ['first', 'queue']);
  assert.deepEqual(disconnected, ['first', 'ended']);
  assert.equal(first.onended, null);
  assert.equal(ended.onended, null);
  assert.equal(resources.scheduledSources.size, 0);
  assert.equal(resources.playbackStarted, false);
  assert.equal(resources.playbackCursor, 0);
});

test('callBackpressureDelayMs uses a safe bounded fallback', () => {
  assert.equal(callBackpressureDelayMs(undefined), 250);
  assert.equal(callBackpressureDelayMs(Number.NaN), 250);
  assert.equal(callBackpressureDelayMs(10), 50);
  assert.equal(callBackpressureDelayMs(320), 320);
});
