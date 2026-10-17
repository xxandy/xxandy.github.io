/**
 * AudioEngine - High performance Web Audio multitrack playback engine
 * Features:
 * - 100% sample-accurate multitrack synchronization using a single master AudioContext.
 * - iOS 16.4+ / iOS 17 / iOS 18 navigator.audioSession.type = 'playback' (bypasses silent switch).
 * - Lazy AudioContext instantiation on first trusted user interaction (prevents iOS pre-gesture lockup).
 * - OfflineAudioContext decoding pipeline (zero pre-gesture context poisoning).
 * - Direct parallel audio graph routing (source -> trackGain -> masterGain -> destination).
 * - Direct gain value assignments (no stalled clock automation ramps).
 */
/**
 * TrackDataLoader - Handles Range-based partial chunk fetching and full-stream caching
 */
class TrackDataLoader {
  constructor(trackIndex, url, audioEngine) {
    this.trackIndex = trackIndex;
    this.url = url;
    this.audioEngine = audioEngine;
    this.fullBuffer = null;
    this.fetchPromise = null;
    this.totalBytes = 0;
  }

  async ensureBuffer() {
    if (this.fullBuffer) return this.fullBuffer;
    if (this.fetchPromise) return this.fetchPromise;

    this.fetchPromise = (async () => {
      const res = await fetch(this.url);
      if (!res.ok) throw new Error(`HTTP ${res.status} loading ${this.url}`);
      const buf = await res.arrayBuffer();
      this.fullBuffer = new Uint8Array(buf);
      this.totalBytes = this.fullBuffer.byteLength;
      return this.fullBuffer;
    })();
    return this.fetchPromise;
  }

  /**
   * Fast header parser to determine exact audio duration from buffer bytes
   */
  detectDuration(buf) {
    if (!buf || buf.length < 32) return null;

    // 1. WAV header
    if (buf.length >= 44 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) { // 'RIFF'
      let offset = 12;
      let sampleRate = 44100;
      let channels = 2;
      let bitsPerSample = 16;
      let dataSize = 0;
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      while (offset < buf.length - 8) {
        const id = String.fromCharCode(buf[offset], buf[offset+1], buf[offset+2], buf[offset+3]);
        const size = view.getUint32(offset + 4, true);
        if (id === 'fmt ') {
          channels = view.getUint16(offset + 10, true);
          sampleRate = view.getUint32(offset + 12, true);
          bitsPerSample = view.getUint16(offset + 22, true);
        } else if (id === 'data') {
          dataSize = size;
          break;
        }
        offset += 8 + size;
      }
      if (dataSize > 0 && sampleRate > 0 && channels > 0) {
        return dataSize / (sampleRate * channels * (bitsPerSample / 8));
      }
    }

    // 2. MP3 Xing / Info header (standard in LAME, FFmpeg, Lavf)
    const limit = Math.min(buf.length - 16, 8192);
    for (let i = 0; i < limit; i++) {
      if ((buf[i] === 0x58 && buf[i+1] === 0x69 && buf[i+2] === 0x6e && buf[i+3] === 0x67) || // 'Xing'
          (buf[i] === 0x49 && buf[i+1] === 0x6e && buf[i+2] === 0x66 && buf[i+3] === 0x6f)) {  // 'Info'
        const view = new DataView(buf.buffer, buf.byteOffset + i, 16);
        const flags = view.getUint32(4, false);
        if (flags & 1) {
          const frames = view.getUint32(8, false);
          let sampleRate = 44100;
          for (let h = Math.max(0, i - 160); h <= i; h++) {
            if (buf[h] === 0xFF && (buf[h+1] & 0xE0) === 0xE0) {
              const srIdx = (buf[h+2] >> 2) & 0x03;
              const rates = [44100, 48000, 32000];
              if (rates[srIdx]) sampleRate = rates[srIdx];
              break;
            }
          }
          return (frames * 1152) / sampleRate;
        }
      }
    }

    // 3. MP3 CBR from first valid MPEG frame
    for (let i = 0; i < limit; i++) {
      if (buf[i] === 0xFF && (buf[i+1] & 0xFE) === 0xFA) { // MPEG-1 Layer 3
        const brIdx = (buf[i+2] >> 4) & 0x0F;
        const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
        const kbps = bitrates[brIdx];
        if (kbps > 0) {
          return (buf.length * 8) / (kbps * 1000);
        }
      }
    }

    // 4. WASM decoder seek fallback
    if (window.mp3Decoder && typeof window.mp3Decoder.getDuration === 'function') {
      try {
        const dur = window.mp3Decoder.getDuration(buf);
        if (dur > 0) return dur;
      } catch (e) {}
    }

    return null;
  }
}

class AudioEngine {
  constructor(stateManager) {
    this.state = stateManager;
    this.audioCtx = null;
    this.masterGain = null;
    this.masterAnalyser = null;
    this.masterVolume = 1.0;
    this.tracks = []; // Array of { index, name, url, offset, duration, buffer, gainNode, analyserNode, sourceNode, color }

    this.isPlaying = false;
    this.isRecording = false;
    this.playheadPosition = 0; // In seconds
    this.playbackStartTime = 0; // audioCtx.currentTime when playback started
    this.playbackStartOffset = 0; // Playhead position when playback started

    this.isLooping = false;
    this.loopStart = 0;
    this.loopEnd = 0;

    this.rafId = null;
    this.eventListeners = new Map();
    this.activeSources = new Set();
    this.playbackEpoch = 0;

    // Subscribe to state updates
    this.state.subscribe((type, payload) => this.handleStateChange(type, payload));

    // Declare playback audio session immediately
    this.setPlaybackAudioSession();

    // Initialize lazy user touch unlock listeners
    this.initTouchUnlockListeners();
  }

  setPlaybackAudioSession() {
    if (typeof navigator !== 'undefined' && navigator.audioSession) {
      try {
        navigator.audioSession.type = 'playback';
      } catch (e) {
        console.warn('Setting navigator.audioSession failed:', e);
      }
    }
  }

  initTouchUnlockListeners() {
    const unlockHandler = () => {
      this.setPlaybackAudioSession();
      this.ensureAudioContextUnlocked();
    };

    ['touchstart', 'touchend', 'pointerdown', 'mousedown', 'click', 'keydown'].forEach(evt => {
      window.addEventListener(evt, unlockHandler, { capture: true, passive: true });
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.setPlaybackAudioSession();
        if (this.audioCtx && this.isPlaying) {
          if (this.audioCtx.state === 'suspended' || this.audioCtx.state === 'interrupted') {
            this.audioCtx.resume().catch(() => {});
          }
        }
      }
    });
  }

  /**
   * Lazily instantiate and unlock the master AudioContext inside a user gesture
   */
  getOrCreateAudioContext() {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtxClass) {
        console.error('Web Audio API is not supported in this browser.');
        return null;
      }
      this.audioCtx = new AudioCtxClass();

      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.value = this.masterVolume;

      this.masterAnalyser = this.audioCtx.createAnalyser();
      this.masterAnalyser.fftSize = 128;
      this.masterAnalyser.smoothingTimeConstant = 0.8;

      // Direct parallel routing (masterGain -> destination, masterGain -> masterAnalyser)
      this.masterGain.connect(this.audioCtx.destination);
      this.masterGain.connect(this.masterAnalyser);

      // Connect any existing tracks to the new audio graph
      this.reconnectAllTrackNodes();
    }

    return this.audioCtx;
  }

  ensureAudioContextUnlocked() {
    const ctx = this.getOrCreateAudioContext();
    if (!ctx) return;

    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      ctx.resume().catch(() => {});
    }

    // Play micro 1-sample silent buffer directly to destination to activate iOS WebKit audio pipeline
    if (!this.silentBufferUnlocked) {
      try {
        const buffer = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
        this.silentBufferUnlocked = true;
      } catch (e) {}
    }
  }

  reconnectAllTrackNodes() {
    if (!this.audioCtx || !this.masterGain) return;

    this.tracks.forEach((track, index) => {
      if (!track) return;

      if (!track.gainNode) {
        const gainNode = this.audioCtx.createGain();
        const trackState = this.state.tracksState[index] || { volume: 1.0, mute: false, solo: false };
        gainNode.gain.value = typeof trackState.volume === 'number' ? trackState.volume : 1.0;

        const analyserNode = this.audioCtx.createAnalyser();
        analyserNode.fftSize = 64;
        analyserNode.smoothingTimeConstant = 0.6;

        // Direct parallel connection
        gainNode.connect(this.masterGain);
        gainNode.connect(analyserNode);

        track.gainNode = gainNode;
        track.analyserNode = analyserNode;
      }
    });

    this.updateAllGains();
  }

  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event).add(callback);
    return () => this.eventListeners.get(event).delete(callback);
  }

  emit(event, data) {
    if (this.eventListeners.has(event)) {
      this.eventListeners.get(event).forEach(cb => cb(data));
    }
  }

  /**
   * Decode an ArrayBuffer without requiring an active output AudioContext
   */
  decodeAudio(arrayBuffer) {
    return new Promise((resolve, reject) => {
      const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      
      const decodeCtx = this.audioCtx || (OfflineCtx ? new OfflineCtx(1, 1, 44100) : (AudioCtxClass ? new AudioCtxClass() : null));
      if (!decodeCtx) {
        reject(new Error('Audio decoder not available'));
        return;
      }

      const bufferCopy = arrayBuffer.slice(0);
      let isSettled = false;

      const onSuccess = (decoded) => {
        if (!isSettled) {
          isSettled = true;
          resolve(decoded);
        }
      };

      const onError = (err) => {
        if (!isSettled) {
          isSettled = true;
          reject(err || new Error('decodeAudioData failed'));
        }
      };

      try {
        const promise = decodeCtx.decodeAudioData(bufferCopy, onSuccess, onError);
        if (promise && typeof promise.then === 'function') {
          promise.then(onSuccess).catch(onError);
        }
      } catch (e) {
        onError(e);
      }
    });
  }

  /**
   * Load project tracks using fixed 20-second streaming blocks and minimp3.wasm
   */
  async loadProjectTracks(project, baseUrl) {
    this.isPlaying = false;
    this.stopAllSources();
    this.stopPlayheadTracker();
    this.tracks = [];
    const targetPlayhead = (this.state && this.state.currentTime > 0) ? this.state.currentTime : 0;

    // Ensure minimp3 WebAssembly decoder is initialized
    if (window.mp3Decoder) {
      try {
        await window.mp3Decoder.init();
      } catch (e) {
        console.warn('WASM MP3 Decoder init warning:', e);
      }
    }

    const rawTracks = project.tracks || [];
    const defaultDuration = (this.state && this.state.getProjectDuration) ? this.state.getProjectDuration() : 266.0;
    const CHUNK_DURATION = 20.0;

    // 1. Immediately instantiate all track structures & 20s chunk blocks
    for (let index = 0; index < rawTracks.length; index++) {
      const t = rawTracks[index];
      let resolvedUrl = t.url;
      try {
        resolvedUrl = new URL(t.url, baseUrl).href;
      } catch (e) {
        resolvedUrl = t.url;
      }

      const offset = Math.max(0, Number(t.offset) || 0);
      const hasExplicitDuration = typeof t.duration === 'number' && t.duration > 0;
      const trackDuration = Math.max(5.0, hasExplicitDuration ? t.duration : defaultDuration);
      const numChunks = Math.ceil(trackDuration / CHUNK_DURATION);
      const chunks = [];

      for (let k = 0; k < numChunks; k++) {
        chunks.push({
          index: k,
          startTime: k * CHUNK_DURATION,
          duration: Math.min(CHUNK_DURATION, trackDuration - k * CHUNK_DURATION),
          status: 'undecoded', // 'undecoded' | 'loading' | 'decoded' | 'error'
          buffer: null,
          minPeaks: null,
          maxPeaks: null,
          totalPoints: 0
        });
      }

      const trackData = {
        index,
        name: t.name || `Track ${index + 1}`,
        url: resolvedUrl,
        offset,
        duration: trackDuration,
        hasExplicitDuration,
        durationDetected: false,
        chunks,
        loader: new TrackDataLoader(index, resolvedUrl, this),
        mp3Decoder: new Mp3BlockDecoder(),
        fullAudioBuffer: null,
        fullAudioPromise: null,
        sourceNodes: new Map(),
        gainNode: null,
        analyserNode: null,
        sourceNode: null,
        color: t.color || '#00f2fe'
      };

      this.tracks[index] = trackData;
    }

    // Connect nodes if AudioContext is already active
    this.reconnectAllTrackNodes();

    // Default loop region
    const totalDuration = this.getTotalDuration();
    this.loopStart = 0;
    this.loopEnd = totalDuration;

    // 2. Immediately emit tracks_initialized so UI shell renders in <50ms!
    this.emit('tracks_initialized', { tracks: this.tracks, totalDuration });

    // Restore initial playhead position
    if (targetPlayhead > 0) {
      this.seek(targetPlayhead);
    } else {
      this.playheadPosition = 0;
      this.emit('time_update', { time: 0 });
    }

    // 3. Start progressive chunk streaming and decoding in background
    this.startBackgroundChunkStreaming(targetPlayhead);

    return this.tracks;
  }

  /**
   * Background loader: decodes initial chunk across all tracks in parallel, then streams rest
   */
  async startBackgroundChunkStreaming(initialPlayhead = 0) {
    const CHUNK_DURATION = 20.0;
    const targetChunkIdx = Math.floor(initialPlayhead / CHUNK_DURATION);

    // Phase 1: Concurrently decode Chunk 0 (or target chunk) for ALL tracks!
    const initialPromises = this.tracks.map(t => {
      const k = (targetChunkIdx < t.chunks.length) ? targetChunkIdx : 0;
      return this.decodeTrackChunk(t.index, k);
    });
    await Promise.all(initialPromises);

    this.emit('initial_playback_ready', { time: initialPlayhead });

    // Phase 2: Stream remaining chunks progressively across tracks
    const maxChunks = Math.max(...this.tracks.map(t => t.chunks ? t.chunks.length : 0));
    for (let k = 0; k < maxChunks; k++) {
      for (let t of this.tracks) {
        if (t.chunks && t.chunks[k] && t.chunks[k].status === 'undecoded') {
          await this.decodeTrackChunk(t.index, k);
          // 8ms micro-yield keeps UI 60fps silky smooth
          await new Promise(r => setTimeout(r, 8));
        }
      }
    }

    this.emit('all_chunks_completed');
  }

  /**
   * Compute waveform peaks from Float32Array channel data
   */
  computePeaks(channelData, duration, pointsPerSec = 80) {
    const totalPoints = Math.max(10, Math.floor(duration * pointsPerSec));
    const samplesPerPoint = Math.max(1, Math.floor(channelData.length / totalPoints));
    const minPeaks = new Float32Array(totalPoints);
    const maxPeaks = new Float32Array(totalPoints);

    for (let p = 0; p < totalPoints; p++) {
      let min = 1.0;
      let max = -1.0;
      const start = p * samplesPerPoint;
      const end = Math.min((p + 1) * samplesPerPoint, channelData.length);
      for (let s = start; s < end; s += 4) {
        const val = channelData[s];
        if (val < min) min = val;
        if (val > max) max = val;
      }
      minPeaks[p] = min === 1.0 ? 0 : min;
      maxPeaks[p] = max === -1.0 ? 0 : max;
    }
    return { minPeaks, maxPeaks, totalPoints };
  }

  /**
   * Apply smooth half-cosine micro-fade out on the tail of an audio buffer
   */
  applyBufferMicroFadeEnd(audioBuffer, fadeSeconds = 0.05) {
    if (!audioBuffer) return;
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const fadeSamples = Math.min(audioBuffer.length, Math.floor(sampleRate * fadeSeconds));
    if (fadeSamples <= 0) return;
    const startIdx = audioBuffer.length - fadeSamples;

    for (let ch = 0; ch < numChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < fadeSamples; i++) {
        const progress = i / fadeSamples;
        const gain = 0.5 * (1 + Math.cos(Math.PI * progress));
        data[startIdx + i] *= gain;
      }
    }
  }

  /**
   * Apply smooth half-cosine micro-fade in on the head of an audio buffer
   */
  applyBufferMicroFadeStart(audioBuffer, fadeSeconds = 0.005) {
    if (!audioBuffer) return;
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const fadeSamples = Math.min(audioBuffer.length, Math.floor(sampleRate * fadeSeconds));
    if (fadeSamples <= 0) return;

    for (let ch = 0; ch < numChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < fadeSamples; i++) {
        const progress = i / fadeSamples;
        const gain = 0.5 * (1 - Math.cos(Math.PI * progress));
        data[i] *= gain;
      }
    }
  }

  /**
   * Ensure track chunks exist up to current track duration
   */
  syncTrackChunks(track) {
    const CHUNK_DURATION = 20.0;
    const numChunks = Math.ceil(track.duration / CHUNK_DURATION);
    while (track.chunks.length < numChunks) {
      const k = track.chunks.length;
      track.chunks.push({
        index: k,
        startTime: k * CHUNK_DURATION,
        duration: Math.min(CHUNK_DURATION, track.duration - k * CHUNK_DURATION),
        status: 'undecoded',
        buffer: null,
        minPeaks: null,
        maxPeaks: null,
        totalPoints: 0
      });
    }
    if (track.chunks.length > numChunks) {
      track.chunks.length = numChunks;
    }
    if (numChunks > 0) {
      track.chunks[numChunks - 1].duration = track.duration - (numChunks - 1) * CHUNK_DURATION;
    }
  }

  /**
   * Find index of chunk that contains the given relative track time
   */
  getTrackChunkIndexAtTime(track, relTime) {
    if (!track.chunks || track.chunks.length === 0) return 0;
    for (let i = 0; i < track.chunks.length; i++) {
      const c = track.chunks[i];
      if (relTime < c.startTime + c.duration) {
        return i;
      }
    }
    return Math.max(0, track.chunks.length - 1);
  }

  /**
   * Decode a specific 20-second chunk for a track
   */
  async decodeTrackChunk(trackIndex, chunkIndex) {
    const track = this.tracks[trackIndex];
    if (!track || !track.chunks || !track.chunks[chunkIndex]) return;
    const chunk = track.chunks[chunkIndex];
    if (chunk.status === 'decoded') return chunk;
    if (chunk.decodePromise) return chunk.decodePromise;

    chunk.status = 'loading';
    this.emit('chunk_loading', { trackIndex, chunkIndex });

    chunk.decodePromise = (async () => {
      const _chunkDecodeStart = performance.now();
      if (typeof window !== 'undefined' && window.zoomProfiler && window.zoomProfiler.logEvent && window.PROFILER_STEP) {
        window.zoomProfiler.logEvent(window.PROFILER_STEP.CHUNK_DECODE_START, {
          opType: window.PROFILER_OP ? window.PROFILER_OP.PROJECT : 7,
          trackIndex,
          extraData: chunkIndex
        });
      }
      try {
        const bytes = await track.loader.ensureBuffer();
        this.ensureAudioContextUnlocked();

        // Detect actual media duration if not explicitly specified in project JSON
        if (!track.hasExplicitDuration && !track.durationDetected) {
          const detectedDur = track.loader.detectDuration(bytes);
          if (detectedDur && detectedDur > 1.0) {
            track.duration = detectedDur;
            track.durationDetected = true;
            this.syncTrackChunks(track);
            this.emit('track_duration_updated', {
              trackIndex,
              duration: track.duration,
              totalDuration: this.getTotalDuration()
            });
          }
        }

        // Feature flag: USE_NATIVE_DECODER
        // Kept in codebase as fallback for future reference, but disabled for now
        // so minimp3.wasm is the primary audio engine across all platforms (including iOS).
        const USE_NATIVE_DECODER = false;
        let decodedViaNative = false;

        if (USE_NATIVE_DECODER) {
          try {
            if (!track.fullAudioBuffer) {
              if (!track.fullAudioPromise) {
                track.fullAudioPromise = this.decodeAudio(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
              }
              track.fullAudioBuffer = await track.fullAudioPromise;
            }

            const fullBuf = track.fullAudioBuffer;
            if (fullBuf) {
              // Detect actual media duration from full decoded buffer
              if (!track.hasExplicitDuration || !track.durationDetected) {
                if (Math.abs(track.duration - fullBuf.duration) > 0.05) {
                  track.duration = fullBuf.duration;
                  track.durationDetected = true;
                  this.syncTrackChunks(track);
                  this.emit('track_duration_updated', {
                    trackIndex,
                    duration: track.duration,
                    totalDuration: this.getTotalDuration()
                  });
                }
              }

              const startFrame = Math.floor(chunk.startTime * fullBuf.sampleRate);
              const endFrame = Math.min(fullBuf.length, Math.floor((chunk.startTime + chunk.duration) * fullBuf.sampleRate));
              const frames = Math.max(0, endFrame - startFrame);
              let chunkBuf = null;
              if (this.audioCtx && frames > 0) {
                chunkBuf = this.audioCtx.createBuffer(fullBuf.numberOfChannels, frames, fullBuf.sampleRate);
                for (let ch = 0; ch < fullBuf.numberOfChannels; ch++) {
                  chunkBuf.getChannelData(ch).set(fullBuf.getChannelData(ch).subarray(startFrame, endFrame));
                }
              }
              chunk.buffer = chunkBuf;
              chunk.duration = frames / fullBuf.sampleRate;
              const p = this.computePeaks(fullBuf.getChannelData(0).subarray(startFrame, endFrame), chunk.duration);
              chunk.minPeaks = p.minPeaks;
              chunk.maxPeaks = p.maxPeaks;
              chunk.totalPoints = p.totalPoints;
              chunk.status = 'decoded';
              decodedViaNative = true;
            }
          } catch (nativeErr) {
            console.warn(`Native audio decode failed for track ${trackIndex}, falling back to minimp3:`, nativeErr);
          }
        }

        if (!decodedViaNative) {
          // Primary path: minimp3.wasm with per-track isolated instance and sequential stream continuity
          const isWav = bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46; // 'RIFF'

          if (isWav) {
            // For WAV files, decode via decodeAudio
            if (!track.fullAudioBuffer) {
              if (!track.fullAudioPromise) {
                track.fullAudioPromise = this.decodeAudio(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
              }
              track.fullAudioBuffer = await track.fullAudioPromise;
            }
            const fullBuf = track.fullAudioBuffer;
            const startFrame = Math.floor(chunk.startTime * fullBuf.sampleRate);
            const endFrame = Math.min(fullBuf.length, Math.floor((chunk.startTime + chunk.duration) * fullBuf.sampleRate));
            const frames = Math.max(0, endFrame - startFrame);
            let chunkBuf = null;
            if (this.audioCtx && frames > 0) {
              chunkBuf = this.audioCtx.createBuffer(fullBuf.numberOfChannels, frames, fullBuf.sampleRate);
              for (let ch = 0; ch < fullBuf.numberOfChannels; ch++) {
                chunkBuf.getChannelData(ch).set(fullBuf.getChannelData(ch).subarray(startFrame, endFrame));
              }
            }
            chunk.buffer = chunkBuf;
            chunk.duration = frames / fullBuf.sampleRate;
            const p = this.computePeaks(fullBuf.getChannelData(0).subarray(startFrame, endFrame), chunk.duration);
            chunk.minPeaks = p.minPeaks;
            chunk.maxPeaks = p.maxPeaks;
            chunk.totalPoints = p.totalPoints;
            chunk.status = 'decoded';
          } else {
            // MP3 audio stream: decode via track.mp3Decoder
            if (!track.mp3Decoder) {
              track.mp3Decoder = new Mp3BlockDecoder();
            }
            if (!track.mp3Decoder.wasm) {
              await track.mp3Decoder.init();
            }

            // Ensure any preceding chunks 0 ... chunkIndex - 1 are decoded sequentially first
            // to keep the IMDCT synthesis filterbank and bit-reservoir perfectly primed!
            for (let p = 0; p < chunkIndex; p++) {
              const prevChunk = track.chunks[p];
              if (prevChunk && prevChunk.status !== 'decoded') {
                await this.decodeTrackChunk(trackIndex, p);
              }
            }

            // Compute exact contiguous starting time
            let targetStartTime = 0.0;
            if (chunkIndex > 0) {
              const prev = track.chunks[chunkIndex - 1];
              if (prev && prev.status === 'decoded') {
                targetStartTime = prev.startTime + prev.duration;
              } else {
                targetStartTime = chunk.startTime;
              }
            }

            const decoded = track.mp3Decoder.decodeChunk(bytes, 20.0, targetStartTime, this.audioCtx);
            chunk.startTime = targetStartTime;
            chunk.buffer = decoded.audioBuffer;
            chunk.duration = decoded.duration;
            chunk.minPeaks = decoded.minPeaks;
            chunk.maxPeaks = decoded.maxPeaks;
            chunk.totalPoints = decoded.totalPoints;
            chunk.status = 'decoded';

            // Pre-align the start time of the subsequent chunk so there is 0 gap
            if (chunkIndex + 1 < track.chunks.length) {
              track.chunks[chunkIndex + 1].startTime = chunk.startTime + chunk.duration;
            }
          }
        }

        // Smooth buffer boundaries: micro-fade in on start chunk, micro-fade out on final chunk
        if (chunk.buffer) {
          if (chunkIndex === 0) {
            this.applyBufferMicroFadeStart(chunk.buffer, 0.005);
          }
          if (chunkIndex === track.chunks.length - 1) {
            this.applyBufferMicroFadeEnd(chunk.buffer, 0.05);
          }
        }

        this.emit('chunk_decoded', { trackIndex, chunkIndex, chunk });

        if (typeof window !== 'undefined' && window.zoomProfiler && window.zoomProfiler.logEvent && window.PROFILER_STEP) {
          window.zoomProfiler.logEvent(window.PROFILER_STEP.CHUNK_DECODE_END, {
            opType: window.PROFILER_OP ? window.PROFILER_OP.PROJECT : 7,
            trackIndex,
            duration: performance.now() - _chunkDecodeStart,
            extraData: chunkIndex
          });
        }

        // If currently playing, seamlessly schedule this newly ready chunk only if within lookahead!
        if (this.isPlaying) {
          const relTime = Math.max(0, this.playheadPosition - track.offset);
          const currentChunkIdx = this.getTrackChunkIndexAtTime(track, relTime);
          if (chunkIndex === currentChunkIdx || chunkIndex === currentChunkIdx + 1) {
            this.scheduleSingleChunk(track, chunk);
          }
        }
        chunk.decodePromise = null;
        return chunk;
      } catch (err) {
        console.warn(`Failed decoding track ${trackIndex} chunk ${chunkIndex}:`, err);
        chunk.status = 'error';
        chunk.decodePromise = null;
        this.emit('chunk_error', { trackIndex, chunkIndex, error: err.message });
      }
    })();

    return chunk.decodePromise;
  }

  /**
   * React immediately to user seek by prioritizing chunks around the playhead
   */
  prioritizeSeek(targetTime) {
    this.tracks.forEach((track, trackIndex) => {
      if (!track || !track.chunks) return;
      const relTime = Math.max(0, targetTime - track.offset);
      const targetChunkIdx = this.getTrackChunkIndexAtTime(track, relTime);

      // Prioritize target chunk and immediate adjacent chunks
      for (let k of [targetChunkIdx, targetChunkIdx + 1]) {
        if (track.chunks[k] && track.chunks[k].status === 'undecoded') {
          this.decodeTrackChunk(trackIndex, k);
        }
      }
    });
  }

  getTotalDuration() {
    let maxEnd = 0;
    this.tracks.forEach(t => {
      if (t) {
        const end = (t.offset || 0) + (t.duration || 0);
        if (end > maxEnd) maxEnd = end;
      }
    });
    if (maxEnd === 0 && this.state) {
      maxEnd = this.state.getProjectDuration();
    }
    return Math.max(maxEnd, 5);
  }

  /**
   * Apply effective gain / mute / solo to all tracks
   */
  updateAllGains() {
    if (!this.audioCtx) return;
    const states = this.state.tracksState;
    const hasAnySolo = states.some(s => s && s.solo);

    this.tracks.forEach((track, index) => {
      if (!track || !track.gainNode) return;
      const trackState = states[index] || { volume: 1.0, mute: false, solo: false };

      let targetGain = typeof trackState.volume === 'number' ? trackState.volume : 1.0;

      if (hasAnySolo) {
        if (!trackState.solo) targetGain = 0;
      } else if (trackState.mute) {
        targetGain = 0;
      }

      track.gainNode.gain.value = targetGain;
    });
  }

  handleStateChange(type, payload) {
    if (type === 'track_volume' || type === 'track_mute' || type === 'track_solo' ||
        type === 'all_unmuted' || type === 'solos_cleared') {
      this.updateAllGains();
    }
  }

  setMasterVolume(vol) {
    const clamped = Math.max(0, Math.min(2.0, vol));
    this.masterVolume = clamped;
    if (this.masterGain) {
      this.masterGain.gain.value = clamped;
    }
    if (typeof window !== 'undefined' && window.zoomProfiler && window.zoomProfiler.logEvent && window.PROFILER_STEP) {
      window.zoomProfiler.logEvent(window.PROFILER_STEP.MASTER_VOLUME, {
        opType: window.PROFILER_OP ? window.PROFILER_OP.MIXER : 6,
        extraData: Math.round(clamped * 100)
      });
    }
  }

  /**
   * Start multitrack playback from current playhead position
   */
  play() {
    this.setPlaybackAudioSession();
    this.ensureAudioContextUnlocked();

    if (!this.audioCtx) return;
    if (this.isPlaying) return;

    if (this.audioCtx.state === 'suspended' || this.audioCtx.state === 'interrupted') {
      this.audioCtx.resume().catch(() => {});
    }

    // Reconnect track audio nodes cleanly and restore master volume
    this.reconnectAllTrackNodes();
    if (this.masterGain) {
      try {
        this.masterGain.gain.cancelScheduledValues(this.audioCtx.currentTime);
        this.masterGain.gain.setValueAtTime(this.masterVolume, this.audioCtx.currentTime);
      } catch (e) {}
    }

    const totalDur = this.getTotalDuration();
    if (this.playheadPosition >= totalDur) {
      this.playheadPosition = 0;
    }

    this.playbackEpoch++;
    this.isPlaying = true;
    this.playbackStartTime = this.audioCtx.currentTime;
    this.playbackStartOffset = this.playheadPosition;

    // Ensure chunks at playhead are prioritized
    this.prioritizeSeek(this.playheadPosition);

    this.scheduleTrackSources();
    this.startPlayheadTracker();
    this.emit('playback_started', { time: this.playheadPosition });

    if (typeof window !== 'undefined' && window.zoomProfiler && window.zoomProfiler.logEvent && window.PROFILER_STEP) {
      window.zoomProfiler.logEvent(window.PROFILER_STEP.AUDIO_PLAY, {
        opType: window.PROFILER_OP ? window.PROFILER_OP.TRANSPORT : 5,
        extraData: Math.round(this.playheadPosition * 100)
      });
    }
  }

  /**
   * Schedule a single 20s chunk into Web Audio
   */
  scheduleSingleChunk(track, chunk) {
    if (!this.audioCtx || !this.isPlaying || !chunk.buffer || !track.gainNode) return;

    const chunkStart = track.offset + chunk.startTime;
    const chunkEnd = chunkStart + chunk.duration;
    const currentPlayhead = this.playheadPosition;

    if (currentPlayhead >= chunkEnd) return; // In the past

    if (!track.sourceNodes) track.sourceNodes = new Map();
    // Prevent double-scheduling of the exact same chunk
    if (track.sourceNodes.has(chunk.index)) return;

    try {
      const source = this.audioCtx.createBufferSource();
      source.buffer = chunk.buffer;
      source.connect(track.gainNode);
      track.sourceNodes.set(chunk.index, source);
      if (this.activeSources) this.activeSources.add(source);

      const audioNow = this.audioCtx.currentTime;
      const chunkAudioStartTime = this.playbackStartTime + (chunkStart - this.playbackStartOffset);

      if (chunkAudioStartTime > audioNow) {
        // Scheduled in the future at the exact hardware timestamp
        source.start(chunkAudioStartTime, 0);
      } else {
        // Currently playing right now; offset into the chunk buffer
        const offsetInChunk = audioNow - chunkAudioStartTime;
        if (offsetInChunk < chunk.duration) {
          source.start(0, Math.max(0, offsetInChunk));
        } else {
          if (this.activeSources) this.activeSources.delete(source);
          track.sourceNodes.delete(chunk.index);
          try { source.disconnect(); } catch (e) {}
          return;
        }
      }

      source.onended = () => {
        if (this.activeSources) this.activeSources.delete(source);
        try { source.disconnect(); } catch (e) {}
        // Only delete from map if this exact source node is still registered
        if (track.sourceNodes && track.sourceNodes.get(chunk.index) === source) {
          track.sourceNodes.delete(chunk.index);
        }
      };
    } catch (e) {
      console.warn('Error scheduling chunk:', e);
    }
  }

  /**
   * Schedule track sources using bounded lookahead (current chunk + immediate next chunk)
   */
  scheduleTrackSources() {
    if (!this.audioCtx) return;
    this.reconnectAllTrackNodes();
    this.stopAllSources();

    const currentPos = this.playheadPosition;
    const CHUNK_DURATION = 20.0;

    this.tracks.forEach(track => {
      if (!track || !track.gainNode) return;

      if (track.chunks && track.chunks.length > 0) {
        const relTime = Math.max(0, currentPos - track.offset);
        const currentChunkIdx = this.getTrackChunkIndexAtTime(track, relTime);

        // Schedule only current and immediate next chunk (lookahead)
        for (let k of [currentChunkIdx, currentChunkIdx + 1]) {
          const chunk = track.chunks[k];
          if (chunk && chunk.status === 'decoded' && chunk.buffer) {
            this.scheduleSingleChunk(track, chunk);
          }
        }
      } else if (track.buffer) {
        const offset = track.offset;
        const duration = track.duration;
        const trackEnd = offset + duration;
        if (this.playheadPosition < trackEnd) {
          const source = this.audioCtx.createBufferSource();
          source.buffer = track.buffer;
          source.connect(track.gainNode);
          track.sourceNode = source;
          if (this.activeSources) this.activeSources.add(source);

          source.onended = () => {
            if (this.activeSources) this.activeSources.delete(source);
            try { source.disconnect(); } catch (e) {}
            if (track.sourceNode === source) {
              track.sourceNode = null;
            }
          };

          const audioNow = this.audioCtx.currentTime;
          if (this.playheadPosition < offset) {
            source.start(audioNow + (offset - this.playheadPosition), 0);
          } else {
            source.start(audioNow, this.playheadPosition - offset);
          }
        }
      }
    });
  }

  /**
   * Lookahead maintenance called during animation frame tick
   */
  checkScheduleLookahead() {
    if (!this.isPlaying || !this.audioCtx) return;
    const CHUNK_DURATION = 20.0;

    this.tracks.forEach(track => {
      if (!track || !track.chunks || !track.gainNode) return;
      const relTime = Math.max(0, this.playheadPosition - track.offset);
      const currentChunkIdx = this.getTrackChunkIndexAtTime(track, relTime);

      // Ensure current chunk is scheduled
      const curChunk = track.chunks[currentChunkIdx];
      if (curChunk && curChunk.status === 'decoded' && curChunk.buffer) {
        if (!track.sourceNodes || !track.sourceNodes.has(currentChunkIdx)) {
          this.scheduleSingleChunk(track, curChunk);
        }
      }

      // Lookahead: ensure next chunk is scheduled
      const nextChunk = track.chunks[currentChunkIdx + 1];
      if (nextChunk && nextChunk.status === 'decoded' && nextChunk.buffer) {
        if (!track.sourceNodes || !track.sourceNodes.has(currentChunkIdx + 1)) {
          this.scheduleSingleChunk(track, nextChunk);
        }
      }

      // Clean up past chunk source nodes (safe threshold: more than 1 chunk in past, so current boundary is never cut)
      if (track.sourceNodes) {
        for (const [idx, source] of track.sourceNodes) {
          if (idx < currentChunkIdx - 1) {
            try {
              source.onended = null;
              source.disconnect();
            } catch (e) {}
            if (this.activeSources) this.activeSources.delete(source);
            track.sourceNodes.delete(idx);
          }
        }
      }
    });
  }

  pause() {
    this.stop();
  }

  /**
   * Complete hardware audio engine shutdown and voice reset without resetting playhead position
   */
  stop() {
    if (!this.isPlaying && (!this.audioCtx || this.audioCtx.state === 'suspended')) return;
    this.isPlaying = false;
    this.playbackEpoch++;
    const currentEpoch = this.playbackEpoch;

    // 1. Stop playhead tracker immediately so UI and timecode freeze on current position
    this.stopPlayheadTracker();

    // 2. Preserve playhead position (do NOT reset to 0)
    this.state.setCurrentTime(this.playheadPosition);
    this.emit('playback_stopped', { time: this.playheadPosition });
    this.emit('time_update', { time: this.playheadPosition });

    if (typeof window !== 'undefined' && window.zoomProfiler && window.zoomProfiler.logEvent && window.PROFILER_STEP) {
      window.zoomProfiler.logEvent(window.PROFILER_STEP.AUDIO_PAUSE, {
        opType: window.PROFILER_OP ? window.PROFILER_OP.TRANSPORT : 5,
        extraData: Math.round(this.playheadPosition * 100)
      });
    }

    // 3. Hardware-level smooth 20ms de-click ramp to zero so DAC never clicks
    if (this.masterGain && this.audioCtx && this.audioCtx.state === 'running') {
      try {
        const now = this.audioCtx.currentTime;
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
        this.masterGain.gain.linearRampToValueAtTime(0, now + 0.02);
        // Schedule all playing sources to stop at now + 0.025 (when volume is already 0)
        this.stopAllSources(now + 0.025);
      } catch (e) {
        this.stopAllSources(0);
      }
    } else {
      this.stopAllSources(0);
    }

    // 4. Complete voice reset and suspend context after the 25ms de-click completes
    setTimeout(() => {
      // If user started playing again during the de-click fade, do NOT tear down!
      if (this.isPlaying || this.playbackEpoch !== currentEpoch) return;

      this.stopAllSources(0);
      this.tracks.forEach(track => {
        if (track) {
          if (track.gainNode) {
            try { track.gainNode.disconnect(); } catch (e) {}
            track.gainNode = null;
          }
          if (track.analyserNode) {
            try { track.analyserNode.disconnect(); } catch (e) {}
            track.analyserNode = null;
          }
        }
      });

      if (!this.isRecording && this.audioCtx && (this.audioCtx.state === 'running' || this.audioCtx.state === 'interrupted')) {
        try {
          this.audioCtx.suspend().catch(() => {});
        } catch (e) {}
      }
    }, 28);
  }

  /**
   * Hard reset: complete teardown of AudioContext and graph
   * Called when Stop button is clicked while stopped or on double-tap
   */
  hardReset() {
    this.stop();

    if (this.audioCtx) {
      try {
        this.audioCtx.close().catch(() => {});
      } catch (e) {}
      this.audioCtx = null;
      this.masterGain = null;
      this.masterAnalyser = null;
      this.silentBufferUnlocked = false;
    }

    this.tracks.forEach(track => {
      if (track) {
        track.gainNode = null;
        track.analyserNode = null;
        track.sourceNode = null;
        if (track.sourceNodes) track.sourceNodes.clear();
        track.fullAudioBuffer = null;
        track.fullAudioPromise = null;
        track.mp3Decoder = null;
      }
    });

    this.emit('engine_reset');
  }

  stopAllSources(stopTime = 0) {
    const isScheduled = typeof stopTime === 'number' && stopTime > 0;

    // 1. Terminate all globally tracked active sources across the engine
    if (this.activeSources) {
      for (const source of this.activeSources) {
        try {
          if (isScheduled) {
            source.stop(stopTime);
          } else {
            source.onended = null;
            source.stop(0);
            source.disconnect();
          }
        } catch (e) {}
      }
      if (!isScheduled) {
        this.activeSources.clear();
      }
    }

    // 2. Clean all track source maps
    this.tracks.forEach(track => {
      if (!track) return;
      if (track.sourceNodes) {
        for (const [idx, source] of track.sourceNodes) {
          try {
            if (isScheduled) {
              source.stop(stopTime);
            } else {
              source.onended = null;
              source.stop(0);
              source.disconnect();
            }
          } catch (e) {}
        }
        if (!isScheduled) {
          track.sourceNodes.clear();
        }
      }
      if (track.sourceNode) {
        try {
          if (isScheduled) {
            track.sourceNode.stop(stopTime);
          } else {
            track.sourceNode.onended = null;
            track.sourceNode.stop(0);
            track.sourceNode.disconnect();
          }
        } catch (e) {}
        if (!isScheduled) {
          track.sourceNode = null;
        }
      }
    });
  }

  seek(timeInSeconds) {
    const totalDur = this.getTotalDuration();
    const targetTime = Math.max(0, Math.min(totalDur, timeInSeconds));

    this.playheadPosition = targetTime;
    this.state.setCurrentTime(targetTime);

    if (typeof window !== 'undefined' && window.zoomProfiler && window.zoomProfiler.logEvent && window.PROFILER_STEP) {
      window.zoomProfiler.logEvent(window.PROFILER_STEP.AUDIO_SEEK, {
        opType: window.PROFILER_OP ? window.PROFILER_OP.TRANSPORT : 5,
        extraData: Math.round(targetTime * 100)
      });
    }

    // Immediately trigger priority decode for the seek target!
    this.prioritizeSeek(targetTime);

    if (this.isPlaying && this.audioCtx) {
      this.playbackEpoch++;
      this.playbackStartTime = this.audioCtx.currentTime;
      this.playbackStartOffset = this.playheadPosition;
      this.scheduleTrackSources();
    }

    this.emit('time_update', { time: targetTime });
  }

  togglePlay() {
    if (this.isPlaying) {
      this.stop();
    } else {
      this.play();
    }
  }

  setLoop(enabled, start = 0, end = null) {
    this.isLooping = enabled;
    this.loopStart = Math.max(0, start);
    this.loopEnd = end !== null ? end : this.getTotalDuration();
    if (typeof window !== 'undefined' && window.zoomProfiler && window.zoomProfiler.logEvent && window.PROFILER_STEP) {
      window.zoomProfiler.logEvent(window.PROFILER_STEP.AUDIO_LOOP_TOGGLE, {
        opType: window.PROFILER_OP ? window.PROFILER_OP.TRANSPORT : 5,
        extraData: enabled ? 1 : 0
      });
    }
    this.emit('loop_changed', { isLooping: this.isLooping, start: this.loopStart, end: this.loopEnd });
  }

  /**
   * Seamless loop transition: blends tail of loop into loop head with continuous voice handover
   */
  performSeamlessLoop() {
    if (!this.isPlaying || !this.audioCtx) return;

    const loopStart = this.loopStart || 0;
    const now = this.audioCtx.currentTime;
    const CHUNK_DURATION = 20.0;
    const targetChunkIdx = Math.floor(loopStart / CHUNK_DURATION);

    // 1. Gently stop tail source nodes with a 20ms tail-off so there is no abrupt DC drop
    this.tracks.forEach(track => {
      if (!track || !track.sourceNodes) return;
      for (const [idx, source] of track.sourceNodes) {
        if (idx !== targetChunkIdx) {
          try {
            source.onended = null;
            source.stop(now + 0.02);
          } catch (e) {}
        }
      }
      track.sourceNodes.clear();
      if (track.sourceNode) {
        try {
          track.sourceNode.onended = null;
          track.sourceNode.stop(now + 0.02);
        } catch (e) {}
        track.sourceNode = null;
      }
    });

    // 2. Advance playback timing reference cleanly
    this.playbackEpoch++;
    this.playbackStartTime = now;
    this.playbackStartOffset = loopStart;
    this.playheadPosition = loopStart;

    // 3. Schedule target head chunk immediately starting seamlessly at 'now'
    this.tracks.forEach(track => {
      if (!track || !track.gainNode) return;
      if (track.chunks && track.chunks.length > 0) {
        const headChunk = track.chunks[targetChunkIdx];
        if (headChunk && headChunk.status === 'decoded' && headChunk.buffer) {
          this.scheduleSingleChunk(track, headChunk);
        }
      } else if (track.buffer) {
        const source = this.audioCtx.createBufferSource();
        source.buffer = track.buffer;
        source.connect(track.gainNode);
        track.sourceNode = source;
        if (this.activeSources) this.activeSources.add(source);
        source.onended = () => {
          if (this.activeSources) this.activeSources.delete(source);
          try { source.disconnect(); } catch (e) {}
          if (track.sourceNode === source) track.sourceNode = null;
        };
        source.start(now, loopStart);
      }
    });

    this.emit('time_update', { time: loopStart });
  }

  /**
   * High frequency loop to update playhead position and handle end of playback / loop
   */
  startPlayheadTracker() {
    const tick = () => {
      if (!this.isPlaying || !this.audioCtx) return;

      const elapsed = this.audioCtx.currentTime - this.playbackStartTime;
      const currentPos = this.playbackStartOffset + elapsed;
      this.playheadPosition = currentPos;

      // Check loop / song end
      const totalDur = this.getTotalDuration();
      const endThreshold = this.isLooping ? this.loopEnd : totalDur;

      if (currentPos >= endThreshold) {
        if (this.isLooping) {
          this.performSeamlessLoop();
        } else {
          this.playheadPosition = totalDur;
          this.stop();
          return;
        }
      }

      // Check lookahead scheduling
      this.checkScheduleLookahead();

      // Proactively prioritize decoding ahead of playhead
      this.prioritizeSeek(this.playheadPosition + 15.0);

      this.emit('time_update', { time: this.playheadPosition });
      this.rafId = requestAnimationFrame(tick);
    };

    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(tick);
  }

  stopPlayheadTracker() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Get real-time peak levels for VU meters
   */
  getTrackPeak(index) {
    const track = this.tracks[index];
    if (!track || !track.analyserNode || !this.isPlaying) return 0;

    const data = new Uint8Array(track.analyserNode.frequencyBinCount);
    track.analyserNode.getByteTimeDomainData(data);

    let maxVal = 0;
    for (let i = 0; i < data.length; i++) {
      const val = Math.abs((data[i] - 128) / 128);
      if (val > maxVal) maxVal = val;
    }
    return maxVal;
  }

  getMasterPeak() {
    if (!this.masterAnalyser || !this.isPlaying) return 0;
    const data = new Uint8Array(this.masterAnalyser.frequencyBinCount);
    this.masterAnalyser.getByteTimeDomainData(data);

    let maxVal = 0;
    for (let i = 0; i < data.length; i++) {
      const val = Math.abs((data[i] - 128) / 128);
      if (val > maxVal) maxVal = val;
    }
    return maxVal;
  }

  /**
   * Add a recorded audio buffer as a new track
   */
  addRecordedTrack(name, audioBuffer, offset = 0, color = '#ef4444') {
    const CHUNK_DURATION = 20.0;
    const index = this.tracks.length;
    const duration = audioBuffer.duration;
    const numChunks = Math.max(1, Math.ceil(duration / CHUNK_DURATION));
    const chunks = [];
    const sampleRate = audioBuffer.sampleRate;

    for (let k = 0; k < numChunks; k++) {
      const chunkStartSec = k * CHUNK_DURATION;
      const chunkDurSec = Math.min(CHUNK_DURATION, duration - chunkStartSec);
      const startSample = Math.floor(chunkStartSec * sampleRate);
      const endSample = Math.min(audioBuffer.length, Math.floor((chunkStartSec + chunkDurSec) * sampleRate));
      const chunkSamples = Math.max(1, endSample - startSample);

      let chunkBuffer = null;
      const ctx = this.getOrCreateAudioContext() || new (window.AudioContext || window.webkitAudioContext)();
      if (chunkSamples > 0) {
        chunkBuffer = ctx.createBuffer(audioBuffer.numberOfChannels, chunkSamples, sampleRate);
        for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
          chunkBuffer.getChannelData(ch).set(audioBuffer.getChannelData(ch).subarray(startSample, endSample));
        }
      }

      const leadChannel = audioBuffer.getChannelData(0).subarray(startSample, endSample);
      const peaks = this.computePeaks(leadChannel, chunkDurSec);

      chunks.push({
        index: k,
        startTime: chunkStartSec,
        duration: chunkDurSec,
        status: 'decoded',
        buffer: chunkBuffer,
        minPeaks: peaks.minPeaks,
        maxPeaks: peaks.maxPeaks,
        totalPoints: peaks.totalPoints
      });
    }

    const trackData = {
      index,
      name: name || `Take ${index + 1}`,
      url: '',
      offset: Math.max(0, Number(offset) || 0),
      duration,
      hasExplicitDuration: true,
      durationDetected: true,
      chunks,
      loader: null,
      mp3Decoder: null,
      fullAudioBuffer: audioBuffer,
      fullAudioPromise: Promise.resolve(audioBuffer),
      sourceNodes: new Map(),
      gainNode: null,
      analyserNode: null,
      sourceNode: null,
      color: color || '#ef4444'
    };

    this.tracks.push(trackData);
    this.reconnectAllTrackNodes();

    const totalDuration = this.getTotalDuration();
    if (this.loopEnd < totalDuration) this.loopEnd = totalDuration;

    if (this.state) {
      this.state.addTrack({
        name: trackData.name,
        url: '',
        offset: trackData.offset,
        duration,
        color: trackData.color
      }, { volume: 1.0, mute: false, solo: false });
    }

    this.emit('track_added', { trackIndex: index, track: trackData, totalDuration });
    return trackData;
  }

  /**
   * Retrieve full AudioBuffer for any track (project audio or recorded take)
   */
  async getTrackAudioBuffer(trackIndex) {
    const track = this.tracks[trackIndex];
    if (!track) throw new Error(`Track ${trackIndex} not found`);

    if (track.fullAudioBuffer) {
      return track.fullAudioBuffer;
    }

    if (track.loader) {
      try {
        const bytes = await track.loader.ensureBuffer();
        if (bytes && bytes.length > 0) {
          const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          const decoded = await this.decodeAudio(raw);
          track.fullAudioBuffer = decoded;
          return decoded;
        }
      } catch (e) {
        console.warn(`Direct decodeAudio failed for track ${trackIndex}, will stitch decoded chunks:`, e);
      }
    }

    if (track.chunks && track.chunks.length > 0) {
      for (let k = 0; k < track.chunks.length; k++) {
        if (track.chunks[k].status !== 'decoded') {
          await this.decodeTrackChunk(trackIndex, k);
        }
      }

      const firstChunk = track.chunks.find(c => c.buffer);
      if (!firstChunk) throw new Error(`No decoded audio data for track ${trackIndex}`);

      const sampleRate = firstChunk.buffer.sampleRate;
      const numChannels = firstChunk.buffer.numberOfChannels;
      const totalFrames = track.chunks.reduce((acc, c) => acc + (c.buffer ? c.buffer.length : 0), 0);

      const ctx = this.getOrCreateAudioContext() || new (window.AudioContext || window.webkitAudioContext)();
      const stitched = ctx.createBuffer(numChannels, totalFrames, sampleRate);

      let frameOffset = 0;
      for (const chunk of track.chunks) {
        if (!chunk.buffer) continue;
        for (let ch = 0; ch < numChannels; ch++) {
          stitched.getChannelData(ch).set(chunk.buffer.getChannelData(ch), frameOffset);
        }
        frameOffset += chunk.buffer.length;
      }
      track.fullAudioBuffer = stitched;
      return stitched;
    }

    throw new Error(`Unable to load audio for track ${trackIndex}`);
  }

  /**
   * Encode AudioBuffer to 16-bit PCM WAV Blob
   */
  audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;
    const numFrames = buffer.length;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;
    const arrayBuffer = new ArrayBuffer(totalSize);
    const view = new DataView(arrayBuffer);

    function writeString(offset, string) {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size
    view.setUint16(20, format, true); // AudioFormat PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true); // ByteRate
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) {
      channels.push(buffer.getChannelData(ch));
    }

    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = channels[ch][i];
        sample = Math.max(-1, Math.min(1, sample));
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, intSample, true);
        offset += 2;
      }
    }

    return new Blob([view], { type: 'audio/wav' });
  }

  /**
   * Encode AudioBuffer to MP3 Blob using lamejs
   */
  audioBufferToMp3(buffer, kbps = 192) {
    if (typeof lamejs === 'undefined') {
      throw new Error('MP3 encoder (lamejs) is not loaded.');
    }
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const mp3encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, kbps);
    const mp3Data = [];
    const numFrames = buffer.length;
    const chunkSize = 1152;

    const left = buffer.getChannelData(0);
    const right = numChannels > 1 ? buffer.getChannelData(1) : left;

    for (let i = 0; i < numFrames; i += chunkSize) {
      const end = Math.min(i + chunkSize, numFrames);
      const len = end - i;
      const leftChunk = new Int16Array(len);
      const rightChunk = new Int16Array(len);

      for (let j = 0; j < len; j++) {
        let sL = Math.max(-1, Math.min(1, left[i + j]));
        leftChunk[j] = sL < 0 ? sL * 0x8000 : sL * 0x7FFF;
        if (numChannels > 1) {
          let sR = Math.max(-1, Math.min(1, right[i + j]));
          rightChunk[j] = sR < 0 ? sR * 0x8000 : sR * 0x7FFF;
        } else {
          rightChunk[j] = leftChunk[j];
        }
      }

      const mp3buf = (numChannels === 1) 
        ? mp3encoder.encodeBuffer(leftChunk)
        : mp3encoder.encodeBuffer(leftChunk, rightChunk);
      if (mp3buf.length > 0) {
        mp3Data.push(mp3buf);
      }
    }

    const end = mp3encoder.flush();
    if (end.length > 0) {
      mp3Data.push(end);
    }

    return new Blob(mp3Data, { type: 'audio/mp3' });
  }

  /**
   * Export Full Mix applying volume, mute, and solo settings
   */
  async exportFullMix(format = 'wav') {
    const projectTitle = (this.state?.project?.title || 'nanodaw_mix').replace(/[\s/\\:]/g, '_');
    const tracks = this.tracks;
    if (!tracks || tracks.length === 0) throw new Error('No tracks available to export');

    const trackBuffers = [];
    let maxEndSec = 0;
    const sampleRate = 44100;

    for (let i = 0; i < tracks.length; i++) {
      const buf = await this.getTrackAudioBuffer(i);
      trackBuffers[i] = buf;
      const endSec = (tracks[i].offset || 0) + buf.duration;
      if (endSec > maxEndSec) maxEndSec = endSec;
    }

    const totalSamples = Math.max(sampleRate, Math.ceil(maxEndSec * sampleRate));
    const OfflineCtxClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offlineCtx = new OfflineCtxClass(2, totalSamples, sampleRate);

    const states = this.state.tracksState;
    const hasAnySolo = states.some(s => s && s.solo);

    for (let i = 0; i < tracks.length; i++) {
      const trackState = states[i] || { volume: 1.0, mute: false, solo: false };
      if (trackState.mute) continue;
      if (hasAnySolo && !trackState.solo) continue;

      const effectiveVolume = (typeof trackState.volume === 'number' ? trackState.volume : 1.0) * this.masterVolume;
      if (effectiveVolume <= 0.001) continue;

      const buf = trackBuffers[i];
      const source = offlineCtx.createBufferSource();
      source.buffer = buf;

      const gain = offlineCtx.createGain();
      gain.gain.value = effectiveVolume;

      source.connect(gain);
      gain.connect(offlineCtx.destination);

      const offsetSec = Math.max(0, tracks[i].offset || 0);
      source.start(offsetSec);
    }

    const rendered = await offlineCtx.startRendering();
    const ext = format === 'mp3' ? 'mp3' : 'wav';
    const blob = format === 'mp3' ? this.audioBufferToMp3(rendered, 192) : this.audioBufferToWav(rendered);
    const filename = `${projectTitle}_full_mix.${ext}`;
    return { blob, filename };
  }

  /**
   * Export individual track preceded with sample-accurate silence and amplitude ramp
   */
  async exportTrack(trackIndex, format = 'wav') {
    const track = this.tracks[trackIndex];
    if (!track) throw new Error(`Track ${trackIndex} not found`);

    const projectTitle = (this.state?.project?.title || 'nanodaw').replace(/[\s/\\:]/g, '_');
    const trackName = (track.name || `Track_${trackIndex + 1}`).replace(/[\s/\\:]/g, '_');

    const rawBuffer = await this.getTrackAudioBuffer(trackIndex);
    const offsetSec = Math.max(0, Number(track.offset) || 0);
    const sampleRate = rawBuffer.sampleRate;
    const numChannels = rawBuffer.numberOfChannels;
    const offsetSamples = Math.round(offsetSec * sampleRate);
    const totalSamples = offsetSamples + rawBuffer.length;

    const OfflineCtxClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offlineCtx = new OfflineCtxClass(numChannels, totalSamples, sampleRate);
    const outBuffer = offlineCtx.createBuffer(numChannels, totalSamples, sampleRate);

    // First offsetSamples are pure zeros (silence)
    // Audio starts at offsetSamples with a smooth 15ms cosine ramp
    const rampSeconds = 0.015;
    const rampSamples = Math.min(rawBuffer.length, Math.round(sampleRate * rampSeconds));

    for (let ch = 0; ch < numChannels; ch++) {
      const srcData = rawBuffer.getChannelData(ch);
      const dstData = outBuffer.getChannelData(ch);
      dstData.set(srcData, offsetSamples);

      // Amplitude ramp to soften the change from pre-offset silence to audio start
      for (let i = 0; i < rampSamples; i++) {
        const gain = 0.5 * (1 - Math.cos(Math.PI * (i / rampSamples)));
        dstData[offsetSamples + i] *= gain;
      }
    }

    const ext = format === 'mp3' ? 'mp3' : 'wav';
    const blob = format === 'mp3' ? this.audioBufferToMp3(outBuffer, 192) : this.audioBufferToWav(outBuffer);
    const filename = `${projectTitle}_${trackName}_offset_${offsetSec.toFixed(2)}s.${ext}`;
    return { blob, filename };
  }
}
