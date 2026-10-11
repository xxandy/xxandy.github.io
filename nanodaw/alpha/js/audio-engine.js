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
   * Decode a specific 20-second chunk for a track
   */
  async decodeTrackChunk(trackIndex, chunkIndex) {
    const track = this.tracks[trackIndex];
    if (!track || !track.chunks || !track.chunks[chunkIndex]) return;
    const chunk = track.chunks[chunkIndex];
    if (chunk.status === 'decoded') return chunk;
    if (chunk.status === 'loading') return;

    chunk.status = 'loading';
    this.emit('chunk_loading', { trackIndex, chunkIndex });

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

      const isWav = track.url.toLowerCase().endsWith('.wav');
      if (isWav) {
        if (!track.fullWavBuffer) {
          track.fullWavBuffer = await this.decodeAudio(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        }
        const fullBuf = track.fullWavBuffer;
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
        const p = this.computePeaks(fullBuf.getChannelData(0).subarray(startFrame, endFrame), frames / fullBuf.sampleRate);
        chunk.minPeaks = p.minPeaks;
        chunk.maxPeaks = p.maxPeaks;
        chunk.totalPoints = p.totalPoints;
        chunk.status = 'decoded';
      } else {
        if (!window.mp3Decoder || !window.mp3Decoder.wasm) {
          if (window.mp3Decoder) await window.mp3Decoder.init();
        }
        const decoded = window.mp3Decoder.decodeChunk(bytes, chunk.duration, chunk.startTime, this.audioCtx);
        chunk.buffer = decoded.audioBuffer;
        chunk.duration = decoded.duration;
        chunk.minPeaks = decoded.minPeaks;
        chunk.maxPeaks = decoded.maxPeaks;
        chunk.totalPoints = decoded.totalPoints;
        chunk.status = 'decoded';
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

      // If currently playing, seamlessly schedule this newly ready chunk only if within lookahead!
      if (this.isPlaying) {
        const relTime = Math.max(0, this.playheadPosition - track.offset);
        const currentChunkIdx = Math.floor(relTime / 20.0);
        if (chunkIndex === currentChunkIdx || chunkIndex === currentChunkIdx + 1) {
          this.scheduleSingleChunk(track, chunk);
        }
      }
      return chunk;
    } catch (err) {
      console.warn(`Failed decoding track ${trackIndex} chunk ${chunkIndex}:`, err);
      chunk.status = 'error';
      this.emit('chunk_error', { trackIndex, chunkIndex, error: err.message });
    }
  }

  /**
   * React immediately to user seek by prioritizing chunks around the playhead
   */
  prioritizeSeek(targetTime) {
    const CHUNK_DURATION = 20.0;
    this.tracks.forEach((track, trackIndex) => {
      if (!track || !track.chunks) return;
      const relTime = Math.max(0, targetTime - track.offset);
      const targetChunkIdx = Math.floor(relTime / CHUNK_DURATION);

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
        const currentChunkIdx = Math.floor(relTime / CHUNK_DURATION);

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
      const currentChunkIdx = Math.floor(relTime / CHUNK_DURATION);

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

      // Clean up past chunk source nodes
      if (track.sourceNodes) {
        for (const [idx, source] of track.sourceNodes) {
          if (idx < currentChunkIdx) {
            try {
              source.onended = null;
              source.stop(0);
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
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.playbackEpoch++;

    if (this.masterGain && this.audioCtx) {
      try {
        this.masterGain.gain.cancelScheduledValues(this.audioCtx.currentTime);
        this.masterGain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      } catch (e) {}
    }

    this.stopAllSources();
    this.stopPlayheadTracker();

    if (this.audioCtx && (this.audioCtx.state === 'running' || this.audioCtx.state === 'interrupted')) {
      try {
        this.audioCtx.suspend().catch(() => {});
      } catch (e) {}
    }

    this.emit('playback_paused', { time: this.playheadPosition });
    this.state.setCurrentTime(this.playheadPosition);
  }

  /**
   * Complete hardware audio engine shutdown and reset to beginning
   */
  stop() {
    this.isPlaying = false;
    this.isWindingDown = false;
    this.playbackEpoch++;

    // 1. Hardware-level instant master gain mute
    if (this.masterGain && this.audioCtx) {
      try {
        this.masterGain.gain.cancelScheduledValues(this.audioCtx.currentTime);
        this.masterGain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      } catch (e) {}
    }

    // 2. Unconditionally stop and disconnect all source nodes
    this.stopAllSources();
    this.stopPlayheadTracker();

    // 3. Disconnect all track gain & analyser nodes
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

    // 4. Suspend audio context hardware thread
    if (this.audioCtx && (this.audioCtx.state === 'running' || this.audioCtx.state === 'interrupted')) {
      try {
        this.audioCtx.suspend().catch(() => {});
      } catch (e) {}
    }

    // 5. Reset playhead to 0
    this.playheadPosition = 0;
    this.state.setCurrentTime(0);
    this.emit('playback_stopped', { time: 0 });
    this.emit('time_update', { time: 0 });
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
      }
    });

    this.emit('engine_reset');
  }

  stopAllSources() {
    // 1. Terminate all globally tracked active sources across the engine
    if (this.activeSources) {
      for (const source of this.activeSources) {
        try {
          source.onended = null;
          source.stop(0);
          source.disconnect();
        } catch (e) {}
      }
      this.activeSources.clear();
    }

    // 2. Clean all track source maps
    this.tracks.forEach(track => {
      if (!track) return;
      if (track.sourceNodes) {
        for (const [idx, source] of track.sourceNodes) {
          try {
            source.onended = null;
            source.stop(0);
            source.disconnect();
          } catch (e) {}
        }
        track.sourceNodes.clear();
      }
      if (track.sourceNode) {
        try {
          track.sourceNode.onended = null;
          track.sourceNode.stop(0);
          track.sourceNode.disconnect();
        } catch (e) {}
        track.sourceNode = null;
      }
    });
  }

  seek(timeInSeconds) {
    const totalDur = this.getTotalDuration();
    const targetTime = Math.max(0, Math.min(totalDur, timeInSeconds));

    this.playheadPosition = targetTime;
    this.state.setCurrentTime(targetTime);

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
      this.pause();
    } else {
      this.play();
    }
  }

  setLoop(enabled, start = 0, end = null) {
    this.isLooping = enabled;
    this.loopStart = Math.max(0, start);
    this.loopEnd = end !== null ? end : this.getTotalDuration();
    this.emit('loop_changed', { isLooping: this.isLooping, start: this.loopStart, end: this.loopEnd });
  }

  /**
   * Smooth wind down and stop: ramp master gain to 0 over 35ms before stopping
   * Eliminates DAC DC offset popping at the end of the song
   */
  windDownAndStop() {
    if (!this.isPlaying) return;
    if (this.isWindingDown) return;
    this.isWindingDown = true;

    if (this.masterGain && this.audioCtx) {
      try {
        const now = this.audioCtx.currentTime;
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
        this.masterGain.gain.linearRampToValueAtTime(0, now + 0.035);
      } catch (e) {}
    }

    setTimeout(() => {
      this.isWindingDown = false;
      this.stop();
    }, 40);
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
          this.windDownAndStop();
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
}
