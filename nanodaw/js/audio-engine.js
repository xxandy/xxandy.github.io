/**
 * AudioEngine - High performance Web Audio multitrack playback engine
 * Handles sample-accurate scheduling, track offsets, gain nodes, VU metering,
 * seeking, and loop regions.
 */
class AudioEngine {
  constructor(stateManager) {
    this.state = stateManager;
    this.audioCtx = null;
    this.masterGain = null;
    this.masterAnalyser = null;
    this.tracks = []; // Array of { buffer, gainNode, analyserNode, sourceNode, duration, offset }
    
    this.isPlaying = false;
    this.playheadPosition = 0; // In seconds
    this.playbackStartTime = 0; // audioCtx.currentTime when playback started
    this.playbackStartOffset = 0; // Playhead position when playback started
    
    this.isLooping = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    
    this.rafId = null;
    this.eventListeners = new Map();
    this.loadingProgress = new Map();

    // Subscribe to state updates
    this.state.subscribe((type, payload) => this.handleStateChange(type, payload));
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
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtxClass();
      
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.setValueAtTime(1.0, this.audioCtx.currentTime);

      this.masterAnalyser = this.audioCtx.createAnalyser();
      this.masterAnalyser.fftSize = 128;
      this.masterAnalyser.smoothingTimeConstant = 0.8;

      this.masterGain.connect(this.masterAnalyser);
      this.masterAnalyser.connect(this.audioCtx.destination);
    }

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  /**
   * Load all tracks for the given project
   */
  async loadProjectTracks(project, baseUrl) {
    this.initAudioContext();
    this.stop();
    this.tracks = [];

    const rawTracks = project.tracks || [];
    let loadedCount = 0;

    const trackPromises = rawTracks.map(async (t, index) => {
      // Resolve track URL relative to project JSON location
      let resolvedUrl = t.url;
      try {
        resolvedUrl = new URL(t.url, baseUrl).href;
      } catch (e) {
        resolvedUrl = t.url;
      }

      this.emit('track_loading', { index, name: t.name, progress: 0 });

      try {
        const response = await fetch(resolvedUrl);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} loading ${resolvedUrl}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);

        // Create per-track gain and analyser
        const gainNode = this.audioCtx.createGain();
        const analyserNode = this.audioCtx.createAnalyser();
        analyserNode.fftSize = 64;
        analyserNode.smoothingTimeConstant = 0.6;

        gainNode.connect(analyserNode);
        analyserNode.connect(this.masterGain);

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
          color: t.color || '#00f2fe'
        };

        // Attach duration back to project track for waveform renderer
        t.duration = audioBuffer.duration;

        this.tracks[index] = trackData;
        loadedCount++;
        this.emit('track_loaded', { index, track: trackData, loadedCount, total: rawTracks.length });
        return trackData;
      } catch (err) {
        console.error(`Failed to load track ${index} (${t.name}):`, err);
        this.emit('track_error', { index, name: t.name, error: err.message });
        // Create silent dummy buffer so app still functions
        const dummyBuffer = this.audioCtx.createBuffer(2, this.audioCtx.sampleRate * 2, this.audioCtx.sampleRate);
        const gainNode = this.audioCtx.createGain();
        const analyserNode = this.audioCtx.createAnalyser();
        gainNode.connect(analyserNode);
        analyserNode.connect(this.masterGain);

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
        return dummyTrack;
      }
    });

    await Promise.all(trackPromises);

    // Apply initial volume/mute/solo states from stateManager
    this.updateAllGains();

    // Default loop region to full project duration
    const totalDuration = this.getTotalDuration();
    this.loopStart = 0;
    this.loopEnd = totalDuration;

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
    return Math.max(maxEnd, 5);
  }

  /**
   * Calculate and apply effective gain for each track (accounting for Mute & Solo)
   */
  updateAllGains() {
    if (!this.audioCtx) return;
    const states = this.state.tracksState;
    const hasAnySolo = states.some(s => s && s.solo);

    this.tracks.forEach((track, index) => {
      if (!track || !track.gainNode) return;
      const trackState = states[index] || { volume: 1.0, mute: false, solo: false };

      let targetGain = trackState.volume;

      if (hasAnySolo) {
        // When solo is active on any track, unmute only soloed tracks
        if (!trackState.solo) {
          targetGain = 0;
        }
      } else if (trackState.mute) {
        targetGain = 0;
      }

      // Smooth gain ramp to avoid clicks
      const now = this.audioCtx.currentTime;
      track.gainNode.gain.cancelScheduledValues(now);
      track.gainNode.gain.setTargetAtTime(targetGain, now, 0.015);
    });
  }

  handleStateChange(type, payload) {
    if (type === 'track_volume' || type === 'track_mute' || type === 'track_solo' ||
        type === 'all_unmuted' || type === 'solos_cleared') {
      this.updateAllGains();
    }
  }

  setMasterVolume(vol) {
    if (!this.masterGain || !this.audioCtx) return;
    const clamped = Math.max(0, Math.min(2.0, vol));
    this.masterGain.gain.setTargetAtTime(clamped, this.audioCtx.currentTime, 0.015);
  }

  /**
   * Start multitrack playback from current playhead position
   */
  play() {
    this.initAudioContext();
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
    const audioNow = this.audioCtx.currentTime;
    const currentPlayhead = this.playheadPosition;

    this.tracks.forEach((track) => {
      if (!track || !track.buffer) return;

      // Stop previous source if running
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

      if (currentPlayhead >= trackEnd) {
        // Track has already finished playing
        return;
      }

      const source = this.audioCtx.createBufferSource();
      source.buffer = track.buffer;
      source.connect(track.gainNode);
      track.sourceNode = source;

      if (currentPlayhead < offset) {
        // Track starts in future
        const delayUntilStart = offset - currentPlayhead;
        const scheduleTime = audioNow + delayUntilStart;
        source.start(scheduleTime, 0);
      } else {
        // Track is already in progress
        const offsetInTrack = currentPlayhead - offset;
        source.start(audioNow, offsetInTrack);
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

    if (this.isPlaying) {
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
