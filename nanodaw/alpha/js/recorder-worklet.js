/**
 * Nanodaw High-Performance Zero-Allocation AudioWorklet Recorder
 * Runs on the dedicated high-priority Audio Rendering Thread.
 * Completely decoupled from the browser main UI thread.
 * Supports arbitrary discrete mono input channels (1..16) and paired stereo streams (1/2, 3/4, ...).
 */

class NanodawRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 4096; // 4096 frames @ 44.1kHz = ~92.8ms per transfer
    this.bufferPool = [];
    this.bufferPoolR = [];

    // Pre-allocate 8 standby chunk buffers per channel in the audio thread
    for (let i = 0; i < 8; i++) {
      this.bufferPool.push(new Float32Array(this.chunkSize));
      this.bufferPoolR.push(new Float32Array(this.chunkSize));
    }
    this.activeBuffer = this.bufferPool.pop();
    this.activeBufferR = this.bufferPoolR.pop();
    this.monoScratch = new Float32Array(512);
    this.writeIndex = 0;
    this.isRecording = true;
    this.totalSamplesProcessed = 0;

    // Input channel / stereo pair routing configuration
    this.channelMode = 'mono'; // 'mono' | 'stereo' | 'auto'
    this.selectedChannel = 0;
    this.stereoLeftChannel = 0;
    this.stereoRightChannel = 1;

    // Real-time transient tracking for count-in & sync calibration clicks
    this.detectTransients = false;
    this.transientThreshold = 0.0631; // Default -24 dBFS (configurable via sensitivity slider)
    this.onsetRatio = 1.65;
    this.lastTransientSample = -999999;
    this.ambientFloor = 0.003;

    // Multi-channel envelope followers & peak telemetry (up to 16 discrete USB channels, e.g. AIR 192|8 & AIR 192|14)
    this.maxTrackedChannels = 16;
    this.channelEnvs = new Float32Array(this.maxTrackedChannels);
    this.channelPeaks = new Float32Array(this.maxTrackedChannels);

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

      if (data.type === 'recycle_buffer') {
        // Recycle returned buffers back into standby pools with zero GC allocation
        if (data.buffer && data.buffer.byteLength === this.chunkSize * 4 && this.bufferPool.length < 16) {
          this.bufferPool.push(new Float32Array(data.buffer));
        }
        if (data.bufferR && data.bufferR.byteLength === this.chunkSize * 4 && this.bufferPoolR.length < 16) {
          this.bufferPoolR.push(new Float32Array(data.bufferR));
        }
      } else if (data.type === 'set_config') {
        if (typeof data.channelMode === 'string' && (data.channelMode === 'mono' || data.channelMode === 'stereo' || data.channelMode === 'auto')) {
          if (data.channelMode !== this.channelMode && this.writeIndex > 0) {
            this.flushPartial();
          }
          this.channelMode = data.channelMode;
        }
        if (typeof data.selectedChannel === 'number' && data.selectedChannel >= 0) {
          this.selectedChannel = data.selectedChannel | 0;
        }
        if (typeof data.stereoLeftChannel === 'number' && data.stereoLeftChannel >= 0) {
          this.stereoLeftChannel = data.stereoLeftChannel | 0;
        }
        if (typeof data.stereoRightChannel === 'number' && data.stereoRightChannel >= 0) {
          this.stereoRightChannel = data.stereoRightChannel | 0;
        }
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
          this.channelEnvs.fill(0);
          this.channelPeaks.fill(0);
          this.firstProcessReported = false;
        }
      } else if (data.type === 'flush') {
        this.flushPartial();
      } else if (data.type === 'ping_diag') {
        const reportedCh = Math.min(this.maxTrackedChannels, Math.max(2, this.lastInputChannels));
        const peaksSnap = [];
        for (let c = 0; c < reportedCh; c++) {
          peaksSnap.push(this.channelPeaks[c]);
        }
        this.port.postMessage({
          type: 'worklet_diag',
          processCalls: this.processCalls,
          emptyInputCalls: this.emptyInputCalls,
          inputChannels: this.lastInputChannels,
          channelMode: this.channelMode,
          selectedChannel: this.selectedChannel,
          stereoPair: this.channelMode === 'stereo' ? [this.stereoLeftChannel, this.stereoRightChannel] : null,
          chunksPosted: this.chunksPosted,
          poolLen: this.bufferPool.length,
          poolRLen: this.bufferPoolR.length,
          poolMisses: this.poolMisses,
          totalSamples: this.totalSamplesProcessed,
          ch0Peak: this.ch0Peak,
          ch1Peak: this.ch1Peak,
          channelPeaks: peaksSnap,
          transientThreshold: this.transientThreshold,
          workletSampleRate: typeof sampleRate === 'number' ? sampleRate : 0,
          workletCurrentTime: typeof currentTime === 'number' ? currentTime : 0
        });
        this.ch0Peak = 0;
        this.ch1Peak = 0;
        this.channelPeaks.fill(0);
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

      if (this.channelMode === 'stereo') {
        const toSendR = this.activeBufferR || new Float32Array(this.chunkSize);
        const nextBufR = this.bufferPoolR.pop();
        if (!nextBufR) this.poolMisses++;
        this.activeBufferR = nextBufR || new Float32Array(this.chunkSize);
        this.writeIndex = 0;
        this.chunksPosted++;
        this.port.postMessage({
          type: 'audio_chunk',
          buffer: toSend,
          bufferR: toSendR,
          channels: 2,
          length: validSamples,
          sampleOffset: this.totalSamplesProcessed - validSamples
        }, [toSend.buffer, toSendR.buffer]);
      } else {
        this.writeIndex = 0;
        this.chunksPosted++;
        this.port.postMessage({
          type: 'audio_chunk',
          buffer: toSend,
          channels: 1,
          length: validSamples,
          sampleOffset: this.totalSamplesProcessed - validSamples
        }, [toSend.buffer]);
      }
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
        channelMode: this.channelMode,
        selectedChannel: this.selectedChannel,
        stereoPair: this.channelMode === 'stereo' ? [this.stereoLeftChannel, this.stereoRightChannel] : null,
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
    const trackedCh = Math.min(this.maxTrackedChannels, chCount);

    for (let c = 0; c < trackedCh; c++) {
      const chArr = in0[c];
      if (!chArr || chArr.length < len) continue;
      let pk = this.channelPeaks[c];
      let env = this.channelEnvs[c];
      for (let i = 0; i < len; i++) {
        const a = Math.abs(chArr[i]);
        if (a > pk) pk = a;
        env = a > env ? a : env * 0.9992;
      }
      this.channelPeaks[c] = pk;
      this.channelEnvs[c] = env;
    }
    this.ch0Peak = this.channelPeaks[0];
    this.ch1Peak = trackedCh > 1 ? this.channelPeaks[1] : 0;

    let srcL = ch0;
    let srcR = null;
    let detectSrc = ch0;

    if (this.channelMode === 'stereo') {
      const idxL = Math.max(0, Math.min(this.stereoLeftChannel, chCount - 1));
      const idxR = Math.max(0, Math.min(this.stereoRightChannel, chCount - 1));
      srcL = (in0[idxL] && in0[idxL].length === len) ? in0[idxL] : ch0;
      srcR = (in0[idxR] && in0[idxR].length === len) ? in0[idxR] : srcL;

      if (this.detectTransients) {
        if (this.monoScratch.length < len) {
          this.monoScratch = new Float32Array(len);
        }
        // Max-magnitude signed composite across L & R: tapping either mic triggers at full 1.0x gain without phase cancellation
        for (let i = 0; i < len; i++) {
          const sL = srcL[i];
          const sR = srcR[i];
          this.monoScratch[i] = Math.abs(sL) >= Math.abs(sR) ? sL : sR;
        }
        detectSrc = this.monoScratch;
      }
    } else if (this.channelMode === 'mono') {
      const idxM = Math.max(0, Math.min(this.selectedChannel, chCount - 1));
      srcL = (in0[idxM] && in0[idxM].length === len) ? in0[idxM] : ch0;
      detectSrc = srcL;
    } else {
      // 'auto' mode: pick strongest active channel at unity gain, or 50/50 sum of top 2 balanced channels
      if (trackedCh > 1) {
        let bestIdx = 0;
        let secondIdx = 1;
        if (this.channelEnvs[1] > this.channelEnvs[0]) {
          bestIdx = 1;
          secondIdx = 0;
        }
        for (let c = 2; c < trackedCh; c++) {
          const envC = this.channelEnvs[c];
          if (envC > this.channelEnvs[bestIdx]) {
            secondIdx = bestIdx;
            bestIdx = c;
          } else if (envC > this.channelEnvs[secondIdx]) {
            secondIdx = c;
          }
        }
        const bestEnv = this.channelEnvs[bestIdx];
        const secondEnv = this.channelEnvs[secondIdx];
        const chBest = (in0[bestIdx] && in0[bestIdx].length === len) ? in0[bestIdx] : ch0;
        const chSec = (in0[secondIdx] && in0[secondIdx].length === len) ? in0[secondIdx] : ch0;

        if (bestEnv > secondEnv * 2.4 && bestEnv > 0.0008) {
          srcL = chBest;
        } else {
          if (this.monoScratch.length < len) {
            this.monoScratch = new Float32Array(len);
          }
          for (let i = 0; i < len; i++) {
            this.monoScratch[i] = 0.5 * (chBest[i] + chSec[i]);
          }
          srcL = this.monoScratch;
        }
      }
      detectSrc = srcL;
    }

    // Low-overhead sample-accurate transient detection using user sensitivity threshold
    if (this.detectTransients) {
      let peak = 0;
      let peakOffset = 0;
      let maxDiff = 0;
      let sumSq = 0;
      for (let i = 0; i < len; i++) {
        const val = detectSrc[i];
        const absVal = Math.abs(val);
        if (absVal > peak) {
          peak = absVal;
          peakOffset = i;
        }
        sumSq += val * val;
        if (i > 0) {
          const d = Math.abs(val - detectSrc[i - 1]);
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
    const isStereo = (this.channelMode === 'stereo' && srcR !== null);

    while (readIdx < len) {
      if (!this.activeBuffer) {
        const nextBuf = this.bufferPool.pop();
        if (!nextBuf) this.poolMisses++;
        this.activeBuffer = nextBuf || new Float32Array(this.chunkSize);
        this.writeIndex = 0;
      }
      if (isStereo && !this.activeBufferR) {
        const nextBufR = this.bufferPoolR.pop();
        if (!nextBufR) this.poolMisses++;
        this.activeBufferR = nextBufR || new Float32Array(this.chunkSize);
      }

      const available = this.chunkSize - this.writeIndex;
      const toCopy = Math.min(len - readIdx, available);

      if (isStereo) {
        for (let i = 0; i < toCopy; i++) {
          this.activeBuffer[this.writeIndex + i] = srcL[readIdx + i];
          this.activeBufferR[this.writeIndex + i] = srcR[readIdx + i];
        }
      } else {
        for (let i = 0; i < toCopy; i++) {
          this.activeBuffer[this.writeIndex + i] = srcL[readIdx + i];
        }
      }

      this.writeIndex += toCopy;
      readIdx += toCopy;
      this.totalSamplesProcessed += toCopy;

      if (this.writeIndex >= this.chunkSize) {
        // Buffer full! Post to main thread via zero-copy Transferable ArrayBuffer(s)
        const fullBuf = this.activeBuffer;
        const nextBuf = this.bufferPool.pop();
        if (!nextBuf) this.poolMisses++;
        this.activeBuffer = nextBuf || new Float32Array(this.chunkSize);

        if (isStereo) {
          const fullBufR = this.activeBufferR;
          const nextBufR = this.bufferPoolR.pop();
          if (!nextBufR) this.poolMisses++;
          this.activeBufferR = nextBufR || new Float32Array(this.chunkSize);
          this.writeIndex = 0;
          this.chunksPosted++;
          this.port.postMessage({
            type: 'audio_chunk',
            buffer: fullBuf,
            bufferR: fullBufR,
            channels: 2,
            length: this.chunkSize,
            sampleOffset: this.totalSamplesProcessed - this.chunkSize
          }, [fullBuf.buffer, fullBufR.buffer]);
        } else {
          this.writeIndex = 0;
          this.chunksPosted++;
          this.port.postMessage({
            type: 'audio_chunk',
            buffer: fullBuf,
            channels: 1,
            length: this.chunkSize,
            sampleOffset: this.totalSamplesProcessed - this.chunkSize
          }, [fullBuf.buffer]);
        }
      }
    }

    return true;
  }
}

registerProcessor('nanodaw-recorder-processor', NanodawRecorderProcessor);
