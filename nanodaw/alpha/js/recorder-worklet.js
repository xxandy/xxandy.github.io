/**
 * Nanodaw High-Performance Zero-Allocation AudioWorklet Recorder
 * Runs on the dedicated high-priority Audio Rendering Thread.
 * Completely decoupled from the browser main UI thread.
 */

class NanodawRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 4096; // 4096 frames @ 44.1kHz = ~92.8ms per transfer
    this.bufferPool = [];

    // Pre-allocate 8 standby chunk buffers in the audio thread
    for (let i = 0; i < 8; i++) {
      this.bufferPool.push(new Float32Array(this.chunkSize));
    }
    this.activeBuffer = this.bufferPool.pop();
    this.writeIndex = 0;
    this.isRecording = true;
    this.totalSamplesProcessed = 0;

    // Real-time transient tracking for count-in calibration clicks
    this.detectTransients = false;
    this.lastTransientSample = -999999;
    this.minRefractorySamples = 6000; // ~136ms refractory window at 44.1kHz
    this.ambientFloor = 0.005;

    this.port.onmessage = (e) => {
      const data = e.data;
      if (!data) return;

      if (data.type === 'recycle_buffer' && data.buffer) {
        // Recycle returned buffer back into standby pool with zero GC allocation
        if (data.buffer.byteLength === this.chunkSize * 4) {
          this.bufferPool.push(new Float32Array(data.buffer));
        }
      } else if (data.type === 'set_config') {
        if (typeof data.detectTransients === 'boolean') {
          this.detectTransients = data.detectTransients;
        }
        if (typeof data.isRecording === 'boolean') {
          this.isRecording = data.isRecording;
        }
        if (typeof data.resetSampleCounter === 'boolean' && data.resetSampleCounter) {
          this.totalSamplesProcessed = 0;
          this.lastTransientSample = -999999;
          this.writeIndex = 0;
        }
      } else if (data.type === 'flush') {
        this.flushPartial();
      }
    };
  }

  flushPartial() {
    if (this.writeIndex > 0 && this.activeBuffer) {
      const validSamples = this.writeIndex;
      const toSend = this.activeBuffer;
      this.activeBuffer = this.bufferPool.pop() || new Float32Array(this.chunkSize);
      this.writeIndex = 0;
      this.port.postMessage({
        type: 'audio_chunk',
        buffer: toSend,
        length: validSamples,
        sampleOffset: this.totalSamplesProcessed - validSamples
      }, [toSend.buffer]);
    }
  }

  process(inputs, outputs, parameters) {
    if (!this.isRecording) return true;
    const inputChannel = inputs[0] ? inputs[0][0] : null;
    if (!inputChannel || inputChannel.length === 0) return true;

    const len = inputChannel.length; // Always 128 frames in standard Web Audio
    let readIdx = 0;

    // Low-overhead transient detection during calibration
    if (this.detectTransients) {
      let peak = 0;
      let diffSum = 0;
      let sumSq = 0;
      for (let i = 0; i < len; i++) {
        const val = inputChannel[i];
        const absVal = Math.abs(val);
        if (absVal > peak) peak = absVal;
        sumSq += val * val;
        if (i > 0) diffSum += Math.abs(val - inputChannel[i - 1]);
      }
      const rms = Math.sqrt(sumSq / len);
      const hf = diffSum / len;
      this.ambientFloor = 0.95 * this.ambientFloor + 0.05 * rms;

      const currentSamplePos = this.totalSamplesProcessed;
      if (peak > 0.008 && (peak > this.ambientFloor * 1.5 || hf > 0.004)) {
        if (currentSamplePos - this.lastTransientSample > this.minRefractorySamples) {
          this.lastTransientSample = currentSamplePos;
          this.port.postMessage({
            type: 'transient',
            samplePos: currentSamplePos,
            peak: peak
          });
        }
      }
    }

    while (readIdx < len) {
      if (!this.activeBuffer) {
        this.activeBuffer = this.bufferPool.pop() || new Float32Array(this.chunkSize);
        this.writeIndex = 0;
      }
      const available = this.chunkSize - this.writeIndex;
      const toCopy = Math.min(len - readIdx, available);

      for (let i = 0; i < toCopy; i++) {
        this.activeBuffer[this.writeIndex + i] = inputChannel[readIdx + i];
      }
      this.writeIndex += toCopy;
      readIdx += toCopy;
      this.totalSamplesProcessed += toCopy;

      if (this.writeIndex >= this.chunkSize) {
        // Buffer full! Post to main thread via zero-copy Transferable ArrayBuffer
        const fullBuf = this.activeBuffer;
        this.activeBuffer = this.bufferPool.pop() || new Float32Array(this.chunkSize);
        this.writeIndex = 0;
        this.port.postMessage({
          type: 'audio_chunk',
          buffer: fullBuf,
          length: this.chunkSize,
          sampleOffset: this.totalSamplesProcessed - this.chunkSize
        }, [fullBuf.buffer]);
      }
    }

    return true;
  }
}

registerProcessor('nanodaw-recorder-processor', NanodawRecorderProcessor);
