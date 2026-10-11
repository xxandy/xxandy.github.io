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
   * Load all tracks sequentially
   */
  async loadProjectTracks(project, baseUrl) {
    this.isPlaying = false;
    this.stopAllSources();
    this.stopPlayheadTracker();
    this.tracks = [];
    const targetPlayhead = (this.state && this.state.currentTime > 0) ? this.state.currentTime : 0;

    const rawTracks = project.tracks || [];
    let loadedCount = 0;

    for (let index = 0; index < rawTracks.length; index++) {
      const t = rawTracks[index];
      let resolvedUrl = t.url;
      try {
        resolvedUrl = new URL(t.url, baseUrl).href;
      } catch (e) {
        resolvedUrl = t.url;
      }

      this.emit('track_loading', { index, name: t.name, progress: Math.round((loadedCount / rawTracks.length) * 100) });

      try {
        const response = await fetch(resolvedUrl);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} loading ${resolvedUrl}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await this.decodeAudio(arrayBuffer);

        const trackData = {
          index,
          name: t.name || `Track ${index + 1}`,
          url: resolvedUrl,
          offset: Math.max(0, Number(t.offset) || 0),
          duration: audioBuffer.duration,
          buffer: audioBuffer,
          gainNode: null,
          analyserNode: null,
          sourceNode: null,
          color: t.color || '#00f2fe'
        };

        t.duration = audioBuffer.duration;
        this.tracks[index] = trackData;
        loadedCount++;
        this.emit('track_loaded', { index, track: trackData, loadedCount, total: rawTracks.length });

      } catch (err) {
        console.error(`Failed to load track ${index} (${t.name}):`, err);
        this.emit('track_error', { index, name: t.name, error: err.message });

        const dummyTrack = {
          index,
          name: (t.name || `Track ${index + 1}`) + ' (Failed)',
          url: resolvedUrl,
          offset: Math.max(0, Number(t.offset) || 0),
          duration: 2,
          buffer: null,
          gainNode: null,
          analyserNode: null,
          sourceNode: null,
          color: '#ef4444',
          hasError: true
        };
        this.tracks[index] = dummyTrack;
      }
    }

    // Connect nodes if AudioContext is already active
    this.reconnectAllTrackNodes();

    // Default loop region to full project duration
    const totalDuration = this.getTotalDuration();
    this.loopStart = 0;
    this.loopEnd = totalDuration;

    // Restore initial playhead position
    if (targetPlayhead > 0) {
      this.seek(targetPlayhead);
    } else {
      this.playheadPosition = 0;
      this.emit('time_update', { time: 0 });
    }

    this.emit('all_tracks_loaded', { tracks: this.tracks, totalDuration });
    return this.tracks;
  }

  getTotalDuration() {
    let maxEnd = 0;
    this.tracks.forEach(t => {
      if (t && t.buffer) {
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

      // Direct assignment ensures instant, reliable gain setting
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

    const totalDur = this.getTotalDuration();
    if (this.playheadPosition >= totalDur) {
      this.playheadPosition = 0;
    }

    this.isPlaying = true;
    this.playbackStartTime = this.audioCtx.currentTime;
    this.playbackStartOffset = this.playheadPosition;

    this.scheduleTrackSources();
    this.startPlayheadTracker();
    this.emit('playback_started', { time: this.playheadPosition });
  }

  /**
   * Schedule all track AudioBufferSourceNodes based on current playhead and track offsets
   */
  scheduleTrackSources() {
    if (!this.audioCtx) return;

    const audioNow = this.audioCtx.currentTime;
    const currentPlayhead = this.playheadPosition;

    this.reconnectAllTrackNodes();

    this.tracks.forEach((track) => {
      if (!track || !track.buffer || !track.gainNode) return;

      if (track.sourceNode) {
        try {
          track.sourceNode.stop();
          track.sourceNode.disconnect();
        } catch (e) {}
        track.sourceNode = null;
      }

      const offset = track.offset;
      const duration = track.duration;
      const trackEnd = offset + duration;

      if (currentPlayhead >= trackEnd) return;

      const source = this.audioCtx.createBufferSource();
      source.buffer = track.buffer;
      source.connect(track.gainNode);
      track.sourceNode = source;

      if (currentPlayhead < offset) {
        const delayUntilStart = offset - currentPlayhead;
        source.start(audioNow + delayUntilStart, 0);
      } else {
        const offsetInTrack = currentPlayhead - offset;
        source.start(0, Math.max(0, offsetInTrack));
      }
    });
  }

  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.stopAllSources();
    this.stopPlayheadTracker();
    this.emit('playback_paused', { time: this.playheadPosition });
    this.state.setCurrentTime(this.playheadPosition);
  }

  stop() {
    this.isPlaying = false;
    this.stopAllSources();
    this.stopPlayheadTracker();
    this.playheadPosition = 0;
    this.emit('playback_stopped', { time: 0 });
    this.state.setCurrentTime(0);
  }

  stopAllSources() {
    this.tracks.forEach(track => {
      if (track && track.sourceNode) {
        try {
          track.sourceNode.stop();
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

    if (this.isPlaying && this.audioCtx) {
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
          this.seek(this.loopStart);
        } else {
          this.pause();
          this.seek(0);
          return;
        }
      }

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
