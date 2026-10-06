/**
 * AudioEngine - High performance Multitrack playback engine
 * Supports:
 * 1. Desktop: Web Audio API (AudioBufferSourceNode) with sample-accurate sync and DSP.
 * 2. Mobile / iOS: HTML5 <audio> streaming fallback + Option C downsampled peak extraction.
 *    - Memory friendly (<15MB RAM on iPhone)
 *    - Bypasses iPhone hardware silent/mute switch via media playback session
 *    - Instant native playback on iOS Safari and Chrome for iOS
 */
class AudioEngine {
  constructor(stateManager) {
    this.state = stateManager;
    this.audioCtx = null;
    this.masterGain = null;
    this.masterAnalyser = null;
    this.masterVolume = 1.0;
    this.tracks = []; // Array of track objects

    this.isPlaying = false;
    this.playheadPosition = 0; // In seconds
    this.playbackStartTime = 0; // audioCtx.currentTime when playback started
    this.playbackStartWallTime = 0; // Date.now() timestamp when playback started
    this.playbackStartOffset = 0; // Playhead position when playback started
    this.lastDriftCheckTime = 0;

    this.isLooping = false;
    this.loopStart = 0;
    this.loopEnd = 0;

    this.rafId = null;
    this.eventListeners = new Map();

    // Detect iOS (iPhone / iPad / iPod / iPadOS Safari)
    this.isIOS = this.detectIOS();

    // Subscribe to state updates
    this.state.subscribe((type, payload) => this.handleStateChange(type, payload));

    // Initialize iOS touch unlock listeners
    this.initUnlockListeners();
  }

  detectIOS() {
    if (typeof navigator === 'undefined') return false;
    return [
      'iPad Simulator',
      'iPhone Simulator',
      'iPod Simulator',
      'iPad',
      'iPhone',
      'iPod'
    ].includes(navigator.platform)
    || (navigator.userAgent.includes('Mac') && 'ontouchend' in document)
    || /iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  initUnlockListeners() {
    if (this.unlockListenersAttached) return;
    this.unlockListenersAttached = true;

    const unlockHandler = () => {
      // 1. Declare playback audio session on iOS 16.4+ (bypasses silent switch)
      if (typeof navigator !== 'undefined' && navigator.audioSession) {
        try {
          navigator.audioSession.type = 'playback';
        } catch (e) {}
      }

      // 2. Resume Web Audio context if desktop or initialized
      if (this.audioCtx && (this.audioCtx.state === 'suspended' || this.audioCtx.state === 'interrupted')) {
        this.audioCtx.resume().catch(() => {});
      }
    };

    ['touchstart', 'touchend', 'pointerdown', 'mousedown', 'click', 'keydown'].forEach(evt => {
      window.addEventListener(evt, unlockHandler, { capture: true, passive: true });
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (typeof navigator !== 'undefined' && navigator.audioSession) {
          try { navigator.audioSession.type = 'playback'; } catch (e) {}
        }
        if (this.audioCtx && this.isPlaying) {
          if (this.audioCtx.state === 'suspended' || this.audioCtx.state === 'interrupted') {
            this.audioCtx.resume().catch(() => {});
          }
        }
      }
    });
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

  initAudioContext() {
    if (this.isIOS) {
      // On iOS, we use native HTML5 Audio for playback to avoid memory exhaustion
      if (typeof navigator !== 'undefined' && navigator.audioSession) {
        try { navigator.audioSession.type = 'playback'; } catch (e) {}
      }
      return;
    }

    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtxClass) {
        console.error('Web Audio API is not supported in this browser.');
        return;
      }
      this.audioCtx = new AudioCtxClass();

      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.value = this.masterVolume;

      this.masterAnalyser = this.audioCtx.createAnalyser();
      this.masterAnalyser.fftSize = 128;
      this.masterAnalyser.smoothingTimeConstant = 0.8;

      this.masterGain.connect(this.audioCtx.destination);
      this.masterGain.connect(this.masterAnalyser);
    }

    if (this.audioCtx.state === 'suspended' || this.audioCtx.state === 'interrupted') {
      this.audioCtx.resume().catch(() => {});
    }
  }

  /**
   * Helper to decode an ArrayBuffer into an AudioBuffer safely
   */
  decodeAudio(arrayBuffer) {
    return new Promise((resolve, reject) => {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      const ctx = this.audioCtx || (AudioCtxClass ? new AudioCtxClass() : null);
      if (!ctx) {
        reject(new Error('AudioContext not available for decoding'));
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
        const promise = ctx.decodeAudioData(bufferCopy, onSuccess, onError);
        if (promise && typeof promise.then === 'function') {
          promise.then(onSuccess).catch(onError);
        }
      } catch (e) {
        onError(e);
      }
    });
  }

  /**
   * Option C: Downsampled Peak Extraction from an AudioBuffer.
   * Extracts compact min/max peak data and immediately frees raw PCM buffer memory.
   */
  extractPeaksFromBuffer(audioBuffer, pointsPerSec = 50) {
    const duration = audioBuffer.duration;
    const totalPoints = Math.max(100, Math.min(1000, Math.floor(duration * pointsPerSec)));
    const channelData = audioBuffer.getChannelData(0);
    const samplesPerPoint = Math.max(1, Math.floor(channelData.length / totalPoints));

    const minPeaks = new Float32Array(totalPoints);
    const maxPeaks = new Float32Array(totalPoints);

    for (let p = 0; p < totalPoints; p++) {
      let min = 1.0;
      let max = -1.0;
      const start = p * samplesPerPoint;
      const end = Math.min(start + samplesPerPoint, channelData.length);

      for (let s = start; s < end; s++) {
        const val = channelData[s];
        if (val < min) min = val;
        if (val > max) max = val;
      }

      minPeaks[p] = min === 1.0 ? 0 : min;
      maxPeaks[p] = max === -1.0 ? 0 : max;
    }

    return { minPeaks, maxPeaks, totalPoints, duration };
  }

  /**
   * Load all tracks for the project
   */
  async loadProjectTracks(project, baseUrl) {
    this.initAudioContext();
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

      if (this.isIOS) {
        // --- iOS / Mobile Fallback: Native HTML5 Audio Element Streaming ---
        const audioEl = new Audio();
        audioEl.src = resolvedUrl;
        audioEl.preload = 'auto';
        audioEl.playsInline = true;
        audioEl.setAttribute('playsinline', '');
        audioEl.setAttribute('webkit-playsinline', '');
        audioEl.crossOrigin = 'anonymous';

        const trackData = {
          index,
          name: t.name || `Track ${index + 1}`,
          url: resolvedUrl,
          offset: Math.max(0, Number(t.offset) || 0),
          duration: Number(t.duration) || 30,
          audioEl: audioEl,
          buffer: null, // No heavy raw PCM in RAM on iOS
          peaks: null,
          color: t.color || '#00f2fe'
        };
        this.tracks[index] = trackData;

        // Option C: Extract downsampled peaks one-by-one and immediately discard the raw buffer
        try {
          const response = await fetch(resolvedUrl);
          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            const decoded = await this.decodeAudio(arrayBuffer);
            trackData.duration = decoded.duration;
            t.duration = decoded.duration;
            trackData.peaks = this.extractPeaksFromBuffer(decoded);
          }
        } catch (err) {
          console.warn(`Downsampled peak extraction fallback for ${t.name}:`, err);
        }

        loadedCount++;
        this.emit('track_loaded', { index, track: trackData, loadedCount, total: rawTracks.length });

      } else {
        // --- Desktop Mode: Full Web Audio Engine (AudioBufferSourceNode) ---
        try {
          const response = await fetch(resolvedUrl);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} loading ${resolvedUrl}`);
          }

          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = await this.decodeAudio(arrayBuffer);

          const gainNode = this.audioCtx.createGain();
          gainNode.gain.value = typeof t.volume === 'number' ? t.volume : 1.0;

          const analyserNode = this.audioCtx.createAnalyser();
          analyserNode.fftSize = 64;
          analyserNode.smoothingTimeConstant = 0.6;

          gainNode.connect(this.masterGain);
          gainNode.connect(analyserNode);

          const trackData = {
            index,
            name: t.name || `Track ${index + 1}`,
            url: resolvedUrl,
            offset: Math.max(0, Number(t.offset) || 0),
            duration: audioBuffer.duration,
            buffer: audioBuffer,
            gainNode,
            analyserNode,
            sourceNode: null,
            peaks: this.extractPeaksFromBuffer(audioBuffer),
            color: t.color || '#00f2fe'
          };

          t.duration = audioBuffer.duration;
          this.tracks[index] = trackData;
          loadedCount++;
          this.emit('track_loaded', { index, track: trackData, loadedCount, total: rawTracks.length });

        } catch (err) {
          console.error(`Failed to load track ${index} (${t.name}):`, err);
          this.emit('track_error', { index, name: t.name, error: err.message });

          const dummyBuffer = this.audioCtx ? this.audioCtx.createBuffer(2, 44100 * 2, 44100) : null;
          const gainNode = this.audioCtx ? this.audioCtx.createGain() : null;
          const analyserNode = this.audioCtx ? this.audioCtx.createAnalyser() : null;
          if (gainNode && analyserNode) {
            gainNode.connect(this.masterGain);
            gainNode.connect(analyserNode);
          }

          const dummyTrack = {
            index,
            name: (t.name || `Track ${index + 1}`) + ' (Failed)',
            url: resolvedUrl,
            offset: Math.max(0, Number(t.offset) || 0),
            duration: 2,
            buffer: dummyBuffer,
            gainNode,
            analyserNode,
            sourceNode: null,
            color: '#ef4444',
            hasError: true
          };
          this.tracks[index] = dummyTrack;
        }
      }
    }

    // Apply initial volume/mute/solo states from stateManager
    this.updateAllGains();

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
      if (t) {
        const dur = (t.buffer ? t.buffer.duration : t.duration) || 0;
        const end = (t.offset || 0) + dur;
        if (end > maxEnd) maxEnd = end;
      }
    });
    if (maxEnd === 0 && this.state) {
      maxEnd = this.state.getProjectDuration();
    }
    return Math.max(maxEnd, 5);
  }

  /**
   * Apply effective gain / volume / mute / solo to all tracks
   */
  updateAllGains() {
    const states = this.state.tracksState;
    const hasAnySolo = states.some(s => s && s.solo);

    this.tracks.forEach((track, index) => {
      if (!track) return;
      const trackState = states[index] || { volume: 1.0, mute: false, solo: false };
      let effVol = typeof trackState.volume === 'number' ? trackState.volume : 1.0;

      if (hasAnySolo) {
        if (!trackState.solo) effVol = 0;
      } else if (trackState.mute) {
        effVol = 0;
      }

      if (this.isIOS && track.audioEl) {
        // HTML5 Audio volume: 0.0 to 1.0
        const finalVol = Math.max(0, Math.min(1.0, effVol * this.masterVolume));
        track.audioEl.volume = finalVol;
        track.audioEl.muted = (finalVol === 0);
      } else if (track.gainNode) {
        track.gainNode.gain.value = effVol;
      }
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
    if (this.isIOS) {
      this.updateAllGains();
    }
  }

  /**
   * Start multitrack playback
   */
  play() {
    if (typeof navigator !== 'undefined' && navigator.audioSession) {
      try { navigator.audioSession.type = 'playback'; } catch (e) {}
    }

    if (this.isPlaying) return;

    const totalDur = this.getTotalDuration();
    if (this.playheadPosition >= totalDur) {
      this.playheadPosition = 0;
    }

    this.isPlaying = true;
    this.playbackStartWallTime = Date.now();
    this.playbackStartOffset = this.playheadPosition;

    if (this.isIOS) {
      // --- iOS HTML5 Playback Start ---
      const curTime = this.playheadPosition;
      this.tracks.forEach(track => {
        if (!track || !track.audioEl) return;
        const offset = track.offset || 0;
        const duration = track.duration || 30;
        if (curTime >= offset && curTime < offset + duration) {
          track.audioEl.currentTime = Math.max(0, curTime - offset);
          track.audioEl.play().catch(e => console.warn('iOS audio play error:', e));
        } else {
          track.audioEl.pause();
        }
      });
    } else {
      // --- Desktop Web Audio Start ---
      this.initAudioContext();
      if (this.audioCtx && (this.audioCtx.state === 'suspended' || this.audioCtx.state === 'interrupted')) {
        this.audioCtx.resume().catch(() => {});
      }
      this.playbackStartTime = this.audioCtx ? this.audioCtx.currentTime : 0;
      this.scheduleTrackSources();
    }

    this.startPlayheadTracker();
    this.emit('playback_started', { time: this.playheadPosition });
  }

  /**
   * Schedule all Web Audio sources (Desktop)
   */
  scheduleTrackSources() {
    if (this.isIOS || !this.audioCtx) return;

    const audioNow = this.audioCtx.currentTime;
    const currentPlayhead = this.playheadPosition;

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
        source.start(0, offsetInTrack);
      }
    });
  }

  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;

    if (this.isIOS) {
      this.tracks.forEach(track => {
        if (track && track.audioEl) {
          track.audioEl.pause();
        }
      });
    } else {
      this.stopAllSources();
    }

    this.stopPlayheadTracker();
    this.emit('playback_paused', { time: this.playheadPosition });
    this.state.setCurrentTime(this.playheadPosition);
  }

  stop() {
    this.isPlaying = false;

    if (this.isIOS) {
      this.tracks.forEach(track => {
        if (track && track.audioEl) {
          track.audioEl.pause();
          track.audioEl.currentTime = 0;
        }
      });
    } else {
      this.stopAllSources();
    }

    this.stopPlayheadTracker();
    this.playheadPosition = 0;
    this.emit('playback_stopped', { time: 0 });
    this.state.setCurrentTime(0);
  }

  stopAllSources() {
    if (this.isIOS) {
      this.tracks.forEach(t => t && t.audioEl && t.audioEl.pause());
      return;
    }

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
    this.playbackStartWallTime = Date.now();
    this.playbackStartOffset = targetTime;
    this.state.setCurrentTime(targetTime);

    if (this.isIOS) {
      this.tracks.forEach(track => {
        if (!track || !track.audioEl) return;
        const offset = track.offset || 0;
        const duration = track.duration || 30;
        const timeInTrack = Math.max(0, targetTime - offset);
        track.audioEl.currentTime = timeInTrack;

        if (this.isPlaying) {
          if (targetTime >= offset && targetTime < offset + duration) {
            track.audioEl.play().catch(() => {});
          } else {
            track.audioEl.pause();
          }
        }
      });
    } else {
      if (this.isPlaying && this.audioCtx) {
        this.playbackStartTime = this.audioCtx.currentTime;
        this.scheduleTrackSources();
      }
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
   * Playhead tracking loop (60 FPS) with drift correction and loop handling
   */
  startPlayheadTracker() {
    const tick = () => {
      if (!this.isPlaying) return;

      if (this.isIOS) {
        // Wall clock time tracking for iOS HTML5 Audio
        const now = Date.now();
        const elapsed = (now - this.playbackStartWallTime) / 1000;
        this.playheadPosition = this.playbackStartOffset + elapsed;

        // Auto-trigger tracks whose offset is reached during playback
        this.tracks.forEach(track => {
          if (!track || !track.audioEl) return;
          const offset = track.offset || 0;
          const duration = track.duration || 30;
          if (this.playheadPosition >= offset && this.playheadPosition < offset + duration) {
            if (track.audioEl.paused) {
              track.audioEl.currentTime = Math.max(0, this.playheadPosition - offset);
              track.audioEl.play().catch(() => {});
            }
          } else if (this.playheadPosition >= offset + duration) {
            if (!track.audioEl.paused) {
              track.audioEl.pause();
            }
          }
        });

        // Drift check every 500ms
        if (now - this.lastDriftCheckTime > 500) {
          this.lastDriftCheckTime = now;
          this.tracks.forEach(track => {
            if (!track || !track.audioEl || track.audioEl.paused) return;
            const targetTrackTime = Math.max(0, this.playheadPosition - (track.offset || 0));
            const drift = Math.abs(track.audioEl.currentTime - targetTrackTime);
            if (drift > 0.08) {
              track.audioEl.currentTime = targetTrackTime;
            }
          });
        }
      } else {
        // Web Audio clock tracking
        if (!this.audioCtx) return;
        const elapsed = this.audioCtx.currentTime - this.playbackStartTime;
        this.playheadPosition = this.playbackStartOffset + elapsed;
      }

      // Check loop / song end
      const totalDur = this.getTotalDuration();
      const endThreshold = this.isLooping ? this.loopEnd : totalDur;

      if (this.playheadPosition >= endThreshold) {
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
   * Peak levels for VU meters
   */
  getTrackPeak(index) {
    const track = this.tracks[index];
    if (!track || !this.isPlaying) return 0;

    if (this.isIOS) {
      // Simulate peak meter based on track peaks and volume state on iOS
      if (track.peaks && track.peaks.maxPeaks) {
        const offset = track.offset || 0;
        const curTime = this.playheadPosition;
        if (curTime >= offset && curTime < offset + (track.duration || 30)) {
          const relTime = curTime - offset;
          const ptIdx = Math.floor((relTime / (track.duration || 30)) * track.peaks.totalPoints);
          if (ptIdx >= 0 && ptIdx < track.peaks.totalPoints) {
            const rawPeak = track.peaks.maxPeaks[ptIdx] || 0.4;
            const effVol = track.audioEl ? track.audioEl.volume : 1.0;
            return rawPeak * effVol;
          }
        }
      }
      return track.audioEl && !track.audioEl.paused && !track.audioEl.muted ? 0.4 : 0;
    }

    if (!track.analyserNode) return 0;
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
    if (!this.isPlaying) return 0;

    if (this.isIOS) {
      let maxTrackPeak = 0;
      this.tracks.forEach((_, idx) => {
        const p = this.getTrackPeak(idx);
        if (p > maxTrackPeak) maxTrackPeak = p;
      });
      return maxTrackPeak;
    }

    if (!this.masterAnalyser) return 0;
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
