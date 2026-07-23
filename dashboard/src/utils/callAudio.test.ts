import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoundedPcmQueue, StreamingPcmResampler, decodeFloat32Pcm } from './callAudio.ts';

function concat(chunks: Float32Array[]): Float32Array {
  const output = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

test('StreamingPcmResampler downsamples 48 kHz PCM to 16 kHz', () => {
  const resampler = new StreamingPcmResampler(48_000, 16_000);
  const input = Float32Array.from({ length: 12 }, (_, index) => index);

  assert.deepEqual(Array.from(resampler.process(input)), [0, 3, 6, 9]);
});

test('StreamingPcmResampler is continuous across input chunk boundaries', () => {
  const input = Float32Array.from({ length: 101 }, (_, index) => Math.sin(index / 7));
  const whole = new StreamingPcmResampler(44_100, 16_000).process(input);

  const chunkedResampler = new StreamingPcmResampler(44_100, 16_000);
  const chunked = concat([
    chunkedResampler.process(input.subarray(0, 7)),
    chunkedResampler.process(input.subarray(7, 53)),
    chunkedResampler.process(input.subarray(53)),
  ]);

  assert.equal(chunked.length, whole.length);
  for (let index = 0; index < whole.length; index += 1) {
    assert.ok(Math.abs(chunked[index] - whole[index]) < 1e-6, `sample ${index} differs`);
  }
});

test('BoundedPcmQueue preserves FIFO order across partial reads', () => {
  const queue = new BoundedPcmQueue(10);
  queue.enqueue(Float32Array.from([1, 2, 3]));
  queue.enqueue(Float32Array.from([4, 5, 6]));

  assert.deepEqual(Array.from(queue.dequeue(4)), [1, 2, 3, 4]);
  assert.equal(queue.bufferedSamples, 2);
  assert.deepEqual(Array.from(queue.dequeue()), [5, 6]);
});

test('BoundedPcmQueue drops oldest samples when the latency bound is exceeded', () => {
  const queue = new BoundedPcmQueue(5);
  queue.enqueue(Float32Array.from([1, 2, 3]));
  const dropped = queue.enqueue(Float32Array.from([4, 5, 6, 7]));

  assert.equal(dropped, 2);
  assert.equal(queue.bufferedSamples, 5);
  assert.deepEqual(Array.from(queue.dequeue()), [3, 4, 5, 6, 7]);
});

test('decodeFloat32Pcm respects a binary view byte offset and little-endian encoding', () => {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  view.setFloat32(4, 0.25, true);
  view.setFloat32(8, -0.5, true);

  assert.deepEqual(Array.from(decodeFloat32Pcm(bytes.subarray(4))), [0.25, -0.5]);
});

test('decodeFloat32Pcm rejects truncated samples', () => {
  assert.throws(() => decodeFloat32Pcm(new Uint8Array(3)), /divisible by four/);
});
