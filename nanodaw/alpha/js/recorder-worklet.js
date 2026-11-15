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
    this.monoScratch = new Float32Array(512);
    this.writeIndex = 0;
    this.isRecording = true;
    this.totalSamplesProcessed = 0;

    // Real-time transient tracking for count-in & sync calibration clicks
    this.detectTransients = false;
    this.transientThreshold = 0.0631; // Default -24 dBFS (configurable via sensitivity slider)
    this.onsetRatio = 1.65;
    this.lastTransientSample = -999999;
    this.ambientFloor = 0.003;

    // Multi-channel smart mono envelope followers (supports Ch1, Ch2 on USB interfaces like AIR 192|8, or stereo mics)
    this.ch0Env = 0;
    this.ch1Env = 0;

    // Zero-overhead audio-thread telemetry counters (read only on ping_diag or first quantum)
    this.processCalls = 0;
    this.emptyInputCalls = 0;
    this.lastInputChannels = 0;
    this.chunksPosted = 0;
    this.poolMisses = 0;
    this.ch0Peak = 0;
    this.ch1Peak = 0;
    this.firstProcessReported = false;

    this.port.onmessage = (e) => {
      const data = e.data;
      if (!data) return;

      if (data.type === 'recycle_buffer' && data.buffer) {
        // Recycle returned buffer back into standby pool with zero GC allocation
        if (data.buffer.byteLength === this.chunkSize * 4 && this.bufferPool.length < 16) {
          this.bufferPool.push(new Float32Array(data.buffer));
        }
      } else if (data.type === 'set_config') {
        if (typeof data.detectTransients === 'boolean') {
          this.detectTransients = data.detectTransients;
        }
        if (typeof data.transientThreshold === 'number' && data.transientThreshold > 0) {
          this.transientThreshold = data.transientThreshold;
        }
        if (typeof data.onsetRatio === 'number' && data.onsetRatio > 1.0) {
          this.onsetRatio = data.onsetRatio;
        }
        if (typeof data.isRecording === 'boolean') {
          this.isRecording = data.isRecording;
        }
        if (typeof data.resetSampleCounter === 'boolean' && data.resetSampleCounter) {
          this.totalSamplesProcessed = 0;
          this.lastTransientSample = -999999;
          this.ambientFloor = 0.003;
          this.writeIndex = 0;
          this.processCalls = 0;
          this.emptyInputCalls = 0;
          this.chunksPosted = 0;
          this.poolMisses = 0;
          this.ch0Peak = 0;
          this.ch1Peak = 0;
          this.ch0Env = 0;
          this.ch1Env = 0;
          this.firstProcessReported = false;
        }
      } else if (data.type === 'flush') {
        this.flushPartial();
      } else if (data.type === 'ping_diag') {
        this.port.postMessage({
          type: 'worklet_diag',
          processCalls: this.processCalls,
          emptyInputCalls: this.emptyInputCalls,
          inputChannels: this.lastInputChannels,
          chunksPosted: this.chunksPosted,
          poolLen: this.bufferPool.length,
          poolMisses: this.poolMisses,
          totalSamples: this.totalSamplesProcessed,
          ch0Peak: this.ch0Peak,
          ch1Peak: this.ch1Peak,
          transientThreshold: this.transientThreshold,
          workletSampleRate: typeof sampleRate === 'number' ? sampleRate : 0,
          workletCurrentTime: typeof currentTime === 'number' ? currentTime : 0
        });
        this.ch0Peak = 0;
        this.ch1Peak = 0;
      }
    };
  }

  flushPartial() {
    if (this.writeIndex > 0 && this.activeBuffer) {
      const validSamples = this.writeIndex;
      const toSend = this.activeBuffer;
      const nextBuf = this.bufferPool.pop();
      if (!nextBuf) this.poolMisses++;
      this.activeBuffer = nextBuf || new Float32Array(this.chunkSize);
      this.writeIndex = 0;
      this.chunksPosted++;
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
    this.processCalls++;
    const in0 = inputs[0];
    const chCount = in0 ? in0.length : 0;
    this.lastInputChannels = chCount;
    const ch0 = chCount > 0 ? in0[0] : null;

    if (!this.firstProcessReported) {
      this.firstProcessReported = true;
      this.port.postMessage({
        type: 'worklet_first_process',
        inputCount: inputs.length,
        channelCount: chCount,
        frameLen: ch0 ? ch0.length : 0,
        workletSampleRate: typeof sampleRate === 'number' ? sampleRate : 0,
        workletCurrentTime: typeof currentTime === 'number' ? currentTime : 0
      });
    }

    if (!ch0 || ch0.length === 0) {
      this.emptyInputCalls++;
      return true;
    }

    const len = ch0.length; // Typically 128 frames in standard Web Audio
    const ch1 = (chCount > 1 && in0[1] && in0[1].length === len) ? in0[1] : null;

    for (let i = 0; i < len; i++) {
      const a0 = Math.abs(ch0[i]);
      if (a0 > this.ch0Peak) this.ch0Peak = a0;
      this.ch0Env = a0 > this.ch0Env ? a0 : this.ch0Env * 0.9992;
      if (ch1) {
        const a1 = Math.abs(ch1[i]);
        if (a1 > this.ch1Peak) this.ch1Peak = a1;
        this.ch1Env = a1 > this.ch1Env ? a1 : this.ch1Env * 0.9992;
      }
    }

    // Select active USB channel at unity gain (Ch1 or Ch2), or 50/50 sum when true stereo
    let monoSrc = ch0;
    if (ch1) {
      if (this.ch1Env > this.ch0Env * 2.8 && this.ch1Env > 0.001) {
        monoSrc = ch1;
      } else if (this.ch0Env > this.ch1Env * 2.8) {
        monoSrc = ch0;
      } else {
        if (this.monoScratch.length < len) {
          this.monoScratch = new Float32Array(len);
        }
        for (let i = 0; i < len; i++) {
          this.monoScratch[i] = 0.5 * (ch0[i] + ch1[i]);
        }
        monoSrc = this.monoScratch;
      }
    }

    // Low-overhead sample-accurate transient detection using user sensitivity threshold
    if (this.detectTransients) {
      let peak = 0;
      let peakOffset = 0;
      let maxDiff = 0;
      let sumSq = 0;
      for (let i = 0; i < len; i++) {
        const val = monoSrc[i];
        const absVal = Math.abs(val);
        if (absVal > peak) {
          peak = absVal;
          peakOffset = i;
        }
        sumSq += val * val;
        if (i > 0) {
          const d = Math.abs(val - monoSrc[i - 1]);
          if (d > maxDiff) maxDiff = d;
        }
      }
      const rms = Math.sqrt(sumSq / len);
      const thresh = this.transientThreshold;
      if (peak < thresh) {
        this.ambientFloor = 0.94 * this.ambientFloor + 0.06 * rms;
      } else {
        this.ambientFloor = 0.992 * this.ambientFloor + 0.008 * Math.min(rms, thresh * 0.5);
      }

      const sr = (typeof sampleRate === 'number' && sampleRate > 8000) ? sampleRate : 44100;
      const refractSamples = Math.round(0.135 * sr);
      const eventSamplePos = this.totalSamplesProcessed + peakOffset;

      if (peak >= thresh && (peak >= this.ambientFloor * this.onsetRatio || maxDiff >= thresh * 0.16)) {
        if (eventSamplePos - this.lastTransientSample > refractSamples) {
          this.lastTransientSample = eventSamplePos;
          this.port.postMessage({
            type: 'transient',
            samplePos: eventSamplePos,
            peak: peak
          });
        }
      }
    }

    let readIdx = 0;
    while (readIdx < len) {
      if (!this.activeBuffer) {
        const nextBuf = this.bufferPool.pop();
        if (!nextBuf) this.poolMisses++;
        this.activeBuffer = nextBuf || new Float32Array(this.chunkSize);
        this.writeIndex = 0;
      }
      const available = this.chunkSize - this.writeIndex;
      const toCopy = Math.min(len - readIdx, available);

      for (let i = 0; i < toCopy; i++) {
        this.activeBuffer[this.writeIndex + i] = monoSrc[readIdx + i];
      }
      this.writeIndex += toCopy;
      readIdx += toCopy;
      this.totalSamplesProcessed += toCopy;

      if (this.writeIndex >= this.chunkSize) {
        // Buffer full! Post to main thread via zero-copy Transferable ArrayBuffer
        const fullBuf = this.activeBuffer;
        const nextBuf = this.bufferPool.pop();
        if (!nextBuf) this.poolMisses++;
        this.activeBuffer = nextBuf || new Float32Array(this.chunkSize);
        this.writeIndex = 0;
        this.chunksPosted++;
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
