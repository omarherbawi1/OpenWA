// TypeScript's DOM library does not currently expose the AudioWorklet global
// scope, so declare the two platform APIs used by this isolated worklet module.
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][]): boolean;
}

declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void;

class CallCaptureProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (input && input.length > 0) {
      const copy = input.slice();
      this.port.postMessage(copy.buffer, [copy.buffer]);
    }
    return true;
  }
}

registerProcessor('openwa-call-capture', CallCaptureProcessor);
