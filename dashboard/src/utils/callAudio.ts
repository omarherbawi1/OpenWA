export const CALL_SAMPLE_RATE = 16_000;
export const CALL_FRAME_SAMPLES = 320;

/**
 * Stateful linear PCM resampler for live microphone chunks.
 *
 * The final source sample is retained between calls so interpolation remains
 * continuous at chunk boundaries. This avoids the clicks and sample drift that
 * result from resampling each Web Audio callback independently.
 */
export class StreamingPcmResampler {
  readonly sourceRate: number;
  readonly targetRate: number;
  private readonly step: number;
  private pending = new Float32Array(0);
  private position = 0;

  constructor(sourceRate: number, targetRate = CALL_SAMPLE_RATE) {
    if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) {
      throw new RangeError('Audio sample rates must be positive finite numbers');
    }
    this.sourceRate = sourceRate;
    this.targetRate = targetRate;
    this.step = sourceRate / targetRate;
  }

  process(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array(0);

    const combined = new Float32Array(this.pending.length + input.length);
    combined.set(this.pending);
    combined.set(input, this.pending.length);
    this.pending = combined;

    if (this.pending.length < 2 || this.position >= this.pending.length - 1) {
      this.compact();
      return new Float32Array(0);
    }

    const outputLength = Math.floor((this.pending.length - 1 - this.position) / this.step) + 1;
    const output = new Float32Array(outputLength);
    let written = 0;

    while (this.position < this.pending.length - 1 && written < output.length) {
      const leftIndex = Math.floor(this.position);
      const fraction = this.position - leftIndex;
      const left = this.pending[leftIndex];
      const right = this.pending[leftIndex + 1];
      output[written] = left + (right - left) * fraction;
      written += 1;
      this.position += this.step;
    }

    this.compact();
    return written === output.length ? output : output.slice(0, written);
  }

  reset(): void {
    this.pending = new Float32Array(0);
    this.position = 0;
  }

  private compact(): void {
    if (this.pending.length === 0) return;

    // Keep one sample before the next interpolation point. If position has
    // advanced beyond the available data, retaining the final sample is enough.
    const discard = Math.max(0, Math.min(Math.floor(this.position), this.pending.length - 1));
    if (discard > 0) {
      this.pending = this.pending.slice(discard);
      this.position -= discard;
    }
  }
}

/**
 * FIFO for PCM samples with a hard memory/latency bound. Overflow drops the
 * oldest audio, which is preferable to playing increasingly stale speech.
 */
export class BoundedPcmQueue {
  readonly maxSamples: number;
  private chunks: Float32Array[] = [];
  private sampleCount = 0;

  constructor(maxSamples: number) {
    if (!Number.isSafeInteger(maxSamples) || maxSamples <= 0) {
      throw new RangeError('maxSamples must be a positive integer');
    }
    this.maxSamples = maxSamples;
  }

  get bufferedSamples(): number {
    return this.sampleCount;
  }

  enqueue(input: Float32Array): number {
    if (input.length === 0) return 0;

    const copy = input.slice();
    this.chunks.push(copy);
    this.sampleCount += copy.length;

    let dropped = 0;
    while (this.sampleCount > this.maxSamples) {
      const overflow = this.sampleCount - this.maxSamples;
      const first = this.chunks[0];
      if (first.length <= overflow) {
        this.chunks.shift();
        this.sampleCount -= first.length;
        dropped += first.length;
      } else {
        this.chunks[0] = first.slice(overflow);
        this.sampleCount -= overflow;
        dropped += overflow;
      }
    }
    return dropped;
  }

  dequeue(maxSamples = this.sampleCount): Float32Array {
    if (!Number.isSafeInteger(maxSamples) || maxSamples < 0) {
      throw new RangeError('maxSamples must be a non-negative integer');
    }

    const requested = Math.min(maxSamples, this.sampleCount);
    const output = new Float32Array(requested);
    let written = 0;

    while (written < requested) {
      const first = this.chunks[0];
      const take = Math.min(first.length, requested - written);
      output.set(first.subarray(0, take), written);
      written += take;
      this.sampleCount -= take;

      if (take === first.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = first.slice(take);
      }
    }

    return output;
  }

  clear(): void {
    this.chunks = [];
    this.sampleCount = 0;
  }
}

/** Decode little-endian Float32 PCM from a Socket.IO binary payload. */
export function decodeFloat32Pcm(data: ArrayBuffer | ArrayBufferView): Float32Array {
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new RangeError('PCM frame byte length must be divisible by four');
  }

  const output = new Float32Array(bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
  }
  return output;
}
