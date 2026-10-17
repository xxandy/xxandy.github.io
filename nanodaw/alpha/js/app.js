/**
 * NanoDAW - Main Application Controller
 * Handles project loading, transport controls, modals, keyboard shortcuts,
 * native OS sharing, and toast notifications.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const state = new StateManager();
  const audio = new AudioEngine(state);
  const waveforms = new WaveformCache();

  // Instantiate UI
  const timelineEl = document.getElementById('timelineApp');
  const timeline = new TimelineUI(timelineEl, state, audio, waveforms);
  window.__nanodaw = { state, audio, waveforms, timeline };

  // Toast helper
  function showToast(message, type = 'info', duration = 3000) {
    const toast = document.getElementById('appToast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = `app-toast show toast-${type}`;
    setTimeout(() => {
      toast.classList.remove('show');
    }, duration);
  }

  // Loading overlay helper
  const loadingOverlay = document.getElementById('loadingOverlay');
  const loadingText = document.getElementById('loadingText');
  const loadingProgress = document.getElementById('loadingProgress');

  function setLoading(isLoading, text = 'Loading project...', progress = 0) {
    if (!loadingOverlay) return;
    if (isLoading) {
      loadingOverlay.classList.remove('hidden');
      if (loadingText) loadingText.textContent = text;
      if (loadingProgress) loadingProgress.style.width = `${progress}%`;
    } else {
      loadingOverlay.classList.add('hidden');
    }
  }

  // Track loading & chunk streaming events
  audio.on('tracks_initialized', ({ tracks }) => {
    setLoading(false);
    timeline.render();
    if (state.currentTime > 0) {
      timeline.scrollToTime(state.currentTime);
    }
  });

  audio.on('initial_playback_ready', () => {
    setLoading(false);
    showToast('Ready to play! Streaming remaining tracks...', 'info', 2500);
  });

  audio.on('all_chunks_completed', () => {
    showToast('All audio tracks fully decoded into memory', 'success', 2500);
  });

  audio.on('track_loaded', ({ loadedCount, total, track }) => {
    const pct = Math.round((loadedCount / total) * 100);
    setLoading(true, `Loaded ${track.name} (${loadedCount}/${total})`, pct);
  });

  audio.on('all_tracks_loaded', () => {
    setLoading(false);
    timeline.render();
    if (state.currentTime > 0) {
      timeline.scrollToTime(state.currentTime);
    }
    showToast(`Loaded ${audio.tracks.length} tracks successfully`, 'success');
  });

  // --- Load Project ---
  async function loadProjectFromUrl(urlOrPath) {
    try {
      setLoading(true, 'Fetching project definition...', 10);
      
      const fullUrl = new URL(urlOrPath, window.location.href).href;
      const res = await fetch(fullUrl, { cache: 'no-cache' });
      if (!res.ok) {
        throw new Error(`Failed to load project JSON: HTTP ${res.status}`);
      }

      const projectData = await res.json();
      
      // Update page title
      document.title = `NANOdaw - ${projectData.title || 'Untitled Project'}`;
      const projectTitleEl = document.getElementById('projectTitle');
      if (projectTitleEl) {
        projectTitleEl.textContent = projectData.title || 'Untitled Project';
      }

      // Initialize state with full absolute URL
      state.initProject(projectData, fullUrl);

      // Resolve base URL for relative audio tracks
      const baseUrl = new URL('.', fullUrl).href;
      await audio.loadProjectTracks(projectData, baseUrl);

      // Dismiss loading modal as soon as tracks are initialized
      setLoading(false);

      // Seek to initial time if provided in URL
      if (state.currentTime > 0) {
        audio.seek(state.currentTime);
        timeline.scrollToTime(state.currentTime);
      }

    } catch (err) {
      console.error('Error loading project:', err);
      setLoading(false);
      showToast(`Error: ${err.message}`, 'error', 5000);
    }
  }

  // Determine which project to load initially
  const urlParams = new URLSearchParams(window.location.search);
  const projectParam = urlParams.get('project') || 'demo.json';
  await loadProjectFromUrl(projectParam);

  // --- Transport Controls ---
  const btnPlay = document.getElementById('btnPlay');
  const btnRewind = document.getElementById('btnRewind');
  const btnLoop = document.getElementById('btnLoop');
  const btnPrevMarker = document.getElementById('btnPrevMarker');
  const btnNextMarker = document.getElementById('btnNextMarker');
  const btnAddMarker = document.getElementById('btnAddMarker');
  const masterVolSlider = document.getElementById('masterVolSlider');
  const masterVolVal = document.getElementById('masterVolVal');

  if (btnPlay) {
    btnPlay.addEventListener('click', () => {
      audio.togglePlay();
    });
  }

  function handleRewind() {
    audio.seek(0);
    if (timeline && timeline.scrollToStart) {
      timeline.scrollToStart();
    }
  }

  if (btnRewind) {
    btnRewind.addEventListener('click', () => {
      handleRewind();
    });
  }

  if (btnLoop) {
    btnLoop.addEventListener('click', () => {
      audio.setLoop(!audio.isLooping);
      btnLoop.classList.toggle('active', audio.isLooping);
      showToast(audio.isLooping ? 'Loop Mode: Enabled' : 'Loop Mode: Disabled', 'info');
    });
  }

  // Marker Jump Prev / Next
  function jumpToRelativeMarker(direction) {
    const markers = state.markers;
    if (!markers || markers.length === 0) return;

    const currentTime = audio.playheadPosition;
    const threshold = 0.3; // seconds tolerance

    if (direction === -1) {
      // Find previous marker
      for (let i = markers.length - 1; i >= 0; i--) {
        if (markers[i].time < currentTime - threshold) {
          audio.seek(markers[i].time);
          if (timeline && timeline.scrollToMarker) timeline.scrollToMarker(markers[i].time);
          showToast(`Jumped to: ${markers[i].name}`, 'info', 1500);
          return;
        }
      }
      // If at start, jump to first marker or 0
      audio.seek(0);
      if (timeline && timeline.scrollToMarker) timeline.scrollToMarker(0);
    } else {
      // Find next marker
      for (let i = 0; i < markers.length; i++) {
        if (markers[i].time > currentTime + threshold) {
          audio.seek(markers[i].time);
          if (timeline && timeline.scrollToMarker) timeline.scrollToMarker(markers[i].time);
          showToast(`Jumped to: ${markers[i].name}`, 'info', 1500);
          return;
        }
      }
    }
  }

  if (btnPrevMarker) {
    btnPrevMarker.addEventListener('click', () => jumpToRelativeMarker(-1));
  }

  if (btnNextMarker) {
    btnNextMarker.addEventListener('click', () => jumpToRelativeMarker(1));
  }

  // Add Marker Button
  if (btnAddMarker) {
    btnAddMarker.addEventListener('click', () => {
      const currentTime = audio.playheadPosition;
      const mins = Math.floor(currentTime / 60);
      const secs = (currentTime % 60).toFixed(1);
      const markerName = prompt(`Add Marker at ${mins}:${secs.padStart(4, '0')}:`, `Section ${state.markers.length + 1}`);
      if (markerName !== null) {
        state.addMarker(markerName, currentTime);
        showToast(`Marker "${markerName}" added`, 'success');
      }
    });
  }

  // Master Volume
  function updateMasterVolume(vol) {
    audio.setMasterVolume(vol);
    if (masterVolSlider) masterVolSlider.value = vol;
    if (masterVolVal) masterVolVal.textContent = timeline.formatGainDb(vol);

    const overlayVol = document.getElementById('overlayMasterVol');
    const overlayVolVal = document.getElementById('overlayMasterVolVal');
    if (overlayVol) overlayVol.value = vol;
    if (overlayVolVal) overlayVolVal.textContent = timeline.formatGainDb(vol);
  }

  if (masterVolSlider) {
    masterVolSlider.addEventListener('input', (e) => {
      updateMasterVolume(parseFloat(e.target.value));
    });
  }

  // Tools Overlay (Mobile Drawer)
  const btnToggleTools = document.getElementById('btnToggleTools');
  const toolsOverlay = document.getElementById('toolsOverlay');
  const btnCloseToolsOverlay = document.getElementById('btnCloseToolsOverlay');
  const overlayMasterVol = document.getElementById('overlayMasterVol');
  const overlayBtnLoop = document.getElementById('overlayBtnLoop');
  const overlayZoomIn = document.getElementById('overlayZoomIn');
  const overlayZoomOut = document.getElementById('overlayZoomOut');
  const overlayZoomFit = document.getElementById('overlayZoomFit');
  const overlayBtnOpenProject = document.getElementById('overlayBtnOpenProject');

  const overlayBtnGetProfile = document.getElementById('overlayBtnGetProfile');
  const profileEventCountEl = document.getElementById('profileEventCount');

  if (btnToggleTools && toolsOverlay) {
    btnToggleTools.addEventListener('click', () => {
      toolsOverlay.classList.remove('hidden');
      if (profileEventCountEl && window.zoomProfiler) {
        profileEventCountEl.textContent = window.zoomProfiler.getEventCount();
      }
    });
  }

  if (btnCloseToolsOverlay && toolsOverlay) {
    btnCloseToolsOverlay.addEventListener('click', () => {
      toolsOverlay.classList.add('hidden');
    });
  }

  if (overlayMasterVol) {
    overlayMasterVol.addEventListener('input', (e) => {
      updateMasterVolume(parseFloat(e.target.value));
    });
  }

  if (overlayBtnLoop) {
    overlayBtnLoop.addEventListener('click', () => {
      if (btnLoop) btnLoop.click();
      overlayBtnLoop.textContent = audio.isLooping ? 'Loop: ON' : 'Loop: OFF';
    });
  }

  if (overlayZoomIn) {
    overlayZoomIn.addEventListener('click', () => {
      if (btnZoomIn) btnZoomIn.click();
      else timeline.applyZoom(timeline.pixelsPerSecond * 1.3);
      if (profileEventCountEl && window.zoomProfiler) {
        profileEventCountEl.textContent = window.zoomProfiler.getEventCount();
      }
    });
  }
  if (overlayZoomOut) {
    overlayZoomOut.addEventListener('click', () => {
      if (btnZoomOut) btnZoomOut.click();
      else timeline.applyZoom(timeline.pixelsPerSecond / 1.3);
      if (profileEventCountEl && window.zoomProfiler) {
        profileEventCountEl.textContent = window.zoomProfiler.getEventCount();
      }
    });
  }
  if (overlayZoomFit) {
    overlayZoomFit.addEventListener('click', () => {
      if (btnZoomFit) btnZoomFit.click();
      toolsOverlay.classList.add('hidden');
      if (profileEventCountEl && window.zoomProfiler) {
        profileEventCountEl.textContent = window.zoomProfiler.getEventCount();
      }
    });
  }
  if (overlayBtnOpenProject) {
    overlayBtnOpenProject.addEventListener('click', () => {
      toolsOverlay.classList.add('hidden');
      if (projectModal) projectModal.classList.remove('hidden');
    });
  }

  // Pinch Feedback Stretch Toggle in Overlay
  const overlayBtnTogglePinchStretch = document.getElementById('overlayBtnTogglePinchStretch');
  function updatePinchStretchBtnUI() {
    if (!overlayBtnTogglePinchStretch) return;
    const isStretch = timeline.pinchStretchWaveform;
    overlayBtnTogglePinchStretch.textContent = isStretch 
      ? 'Waveform Stretch: ON' 
      : 'Waveform Stretch: OFF (Dots Only)';
    overlayBtnTogglePinchStretch.style.color = isStretch ? '#38bdf8' : 'var(--text-secondary)';
    overlayBtnTogglePinchStretch.style.borderColor = isStretch ? 'rgba(56, 189, 248, 0.4)' : 'var(--border-subtle)';
  }
  updatePinchStretchBtnUI();

  if (overlayBtnTogglePinchStretch) {
    overlayBtnTogglePinchStretch.addEventListener('click', () => {
      const next = !timeline.pinchStretchWaveform;
      timeline.setPinchStretchWaveform(next);
      updatePinchStretchBtnUI();
      showToast(next ? 'Pinch: Hardware Stretch ON (Option C)' : 'Pinch: Dots Only (Option A, no waveform stretch)', 'info', 2500);
    });
  }

  // Global runtime helpers
  window.setPinchStretch = (enabled) => {
    const val = timeline.setPinchStretchWaveform(enabled);
    updatePinchStretchBtnUI();
    return val;
  };
  window.getPinchStretch = () => timeline.pinchStretchWaveform;

  // Get Zoom Profile Download Action
  if (overlayBtnGetProfile) {
    overlayBtnGetProfile.addEventListener('click', () => {
      if (!window.zoomProfiler) {
        showToast('Profiler not initialized', 'error');
        return;
      }
      const res = window.zoomProfiler.downloadProfile({
        projectTitle: state.project ? state.project.title : 'untitled',
        trackCount: audio.tracks ? audio.tracks.length : 0,
        currentZoom: timeline.pixelsPerSecond
      });
      if (res && res.success) {
        showToast(`Profile downloaded: ${res.totalOps} ops, ${res.totalEvents} events`, 'success', 3500);
        if (profileEventCountEl) profileEventCountEl.textContent = window.zoomProfiler.getEventCount();
      } else {
        showToast(res ? res.message : 'No zoom operations recorded yet. Use Zoom +/- first!', 'info', 3000);
      }
    });
  }

  // Zoom Controls
  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnZoomFit = document.getElementById('btnZoomFit');

  if (btnZoomIn) {
    btnZoomIn.addEventListener('click', () => {
      if (window.zoomProfiler && window.ZOOM_OP) {
        window.zoomProfiler.startOp(window.ZOOM_OP.ZOOM_IN);
      }
      timeline.applyZoom(timeline.pixelsPerSecond * 1.3);
      if (window.zoomProfiler) {
        window.zoomProfiler.endOp();
      }
    });
  }
  if (btnZoomOut) {
    btnZoomOut.addEventListener('click', () => {
      if (window.zoomProfiler && window.ZOOM_OP) {
        window.zoomProfiler.startOp(window.ZOOM_OP.ZOOM_OUT);
      }
      timeline.applyZoom(timeline.pixelsPerSecond / 1.3);
      if (window.zoomProfiler) {
        window.zoomProfiler.endOp();
      }
    });
  }
  if (btnZoomFit) {
    btnZoomFit.addEventListener('click', () => {
      if (window.zoomProfiler && window.ZOOM_OP) {
        window.zoomProfiler.startOp(window.ZOOM_OP.ZOOM_FIT);
      }
      const fitZoom = timeline.computeProjectMinZoom();
      timeline.applyZoom(fitZoom);
      if (timeline.timelineScrollArea) {
        timeline.timelineScrollArea.scrollLeft = 0;
        timeline.scrollLeft = 0;
      }
      if (window.zoomProfiler) {
        window.zoomProfiler.endOp();
      }
    });
  }

  // Playback state UI changes: Toggle hero button between Play (green triangle) and Stop (red square)
  function updatePlayButtonUI(isPlaying) {
    if (!btnPlay) return;
    if (isPlaying) {
      btnPlay.classList.add('playing');
      btnPlay.title = 'Stop (Space)';
      btnPlay.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <rect x="5" y="5" width="14" height="14" rx="2"/>
        </svg>
      `;
    } else {
      btnPlay.classList.remove('playing');
      btnPlay.title = 'Play (Space)';
      btnPlay.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="6 4 20 12 6 20 6 4"/>
        </svg>
      `;
    }
  }

  // --- Screen Wake Lock Management (prevent auto-lock during playback) ---
  let wakeLockSentinel = null;

  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        if (!wakeLockSentinel) {
          wakeLockSentinel = await navigator.wakeLock.request('screen');
          wakeLockSentinel.addEventListener('release', () => {
            wakeLockSentinel = null;
          });
        }
      } catch (err) {
        // Can reject if battery saver is active, window not visible, or permission denied
        console.warn('[WakeLock] Unable to acquire screen wake lock:', err);
      }
    }
  }

  async function releaseWakeLock() {
    if (wakeLockSentinel) {
      try {
        await wakeLockSentinel.release();
      } catch (err) {}
      wakeLockSentinel = null;
    }
  }

  // When tab becomes visible again while audio is playing, re-acquire the wake lock
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && audio && audio.isPlaying) {
      await requestWakeLock();
    }
  });

  audio.on('playback_started', () => {
    updatePlayButtonUI(true);
    requestWakeLock();
  });
  audio.on('playback_stopped', () => {
    updatePlayButtonUI(false);
    releaseWakeLock();
  });
  audio.on('playback_paused', () => {
    updatePlayButtonUI(false);
    releaseWakeLock();
  });

  // --- Native OS Share & Clipboard Fallback ---
  const btnShare = document.getElementById('btnShare');
  const shareModal = document.getElementById('shareModal');
  const shareUrlInput = document.getElementById('shareUrlInput');
  const btnCopyShareUrl = document.getElementById('btnCopyShareUrl');
  const btnCloseShareModal = document.getElementById('btnCloseShareModal');

  async function handleShare() {
    const shareUrl = state.buildShareableUrl(true);
    const title = state.project?.title || 'NANOdaw Session';
    const text = `Listen to "${title}" multitrack recording on NANOdaw with customized mix and markers:`;

    if (navigator.share) {
      try {
        await navigator.share({
          title: `NANOdaw - ${title}`,
          text: text,
          url: shareUrl
        });
        showToast('Shared successfully!', 'success');
        return;
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.warn('Native share failed, falling back to clipboard/modal:', err);
        } else {
          return; // User cancelled share dialog
        }
      }
    }

    // Fallback: copy to clipboard directly
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(shareUrl);
        showToast('Mix link copied to clipboard!', 'success', 4000);
      } else {
        throw new Error('Clipboard API unavailable');
      }
    } catch (clipErr) {
      // Fallback: Open Share Modal for manual copy
      if (shareModal && shareUrlInput) {
        shareUrlInput.value = shareUrl;
        shareModal.classList.remove('hidden');
        shareUrlInput.select();
      }
    }
  }

  if (btnShare) {
    btnShare.addEventListener('click', handleShare);
  }

  if (btnCopyShareUrl && shareUrlInput) {
    btnCopyShareUrl.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(shareUrlInput.value);
        showToast('Link copied to clipboard!', 'success');
        shareModal.classList.add('hidden');
      } catch (e) {
        shareUrlInput.select();
        document.execCommand('copy');
        showToast('Link copied to clipboard!', 'success');
        shareModal.classList.add('hidden');
      }
    });
  }

  if (btnCloseShareModal && shareModal) {
    btnCloseShareModal.addEventListener('click', () => shareModal.classList.add('hidden'));
  }

  // --- Open Project Modal ---
  const btnOpenProject = document.getElementById('btnOpenProject');
  const projectModal = document.getElementById('projectModal');
  const btnCloseProjectModal = document.getElementById('btnCloseProjectModal');
  const btnLoadRemoteProject = document.getElementById('btnLoadRemoteProject');
  const projectUrlInput = document.getElementById('projectUrlInput');
  const btnLoadDemo = document.getElementById('btnLoadDemo');
  const jsonFileInput = document.getElementById('jsonFileInput');

  if (btnOpenProject && projectModal) {
    btnOpenProject.addEventListener('click', () => projectModal.classList.remove('hidden'));
  }
  if (btnCloseProjectModal && projectModal) {
    btnCloseProjectModal.addEventListener('click', () => projectModal.classList.add('hidden'));
  }

  if (btnLoadRemoteProject && projectUrlInput) {
    btnLoadRemoteProject.addEventListener('click', () => {
      const url = projectUrlInput.value.trim();
      if (url) {
        projectModal.classList.add('hidden');
        loadProjectFromUrl(url);
      }
    });
  }

  if (btnLoadDemo) {
    btnLoadDemo.addEventListener('click', () => {
      projectModal.classList.add('hidden');
      loadProjectFromUrl('demo.json');
    });
  }

  if (jsonFileInput) {
    jsonFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        const projectData = JSON.parse(text);
        projectModal.classList.add('hidden');

        // Create object URL for local JSON
        const blob = new Blob([text], { type: 'application/json' });
        const localUrl = URL.createObjectURL(blob);

        document.title = `NANOdaw - ${projectData.title || file.name}`;
        state.initProject(projectData, localUrl);
        await audio.loadProjectTracks(projectData, window.location.href);
      } catch (err) {
        showToast(`Failed to parse local JSON: ${err.message}`, 'error');
      }
    });
  }

  // --- Recording Engine & 4-Click-Sync Controller ---
  const btnRecord = document.getElementById('btnRecord');
  const recordSetupModal = document.getElementById('recordSetupModal');
  const btnCloseRecordSetupModal = document.getElementById('btnCloseRecordSetupModal');
  const btnCancelRecordSetup = document.getElementById('btnCancelRecordSetup');
  const recordDeviceSelect = document.getElementById('recordDeviceSelect');
  const record4ClickSync = document.getElementById('record4ClickSync');
  const btnStartRecordingAction = document.getElementById('btnStartRecordingAction');

  const recordingHUD = document.getElementById('recordingHUD');
  const hudRecStatusText = document.getElementById('hudRecStatusText');
  const hudTimer = document.getElementById('hudTimer');
  const hudInstruction = document.getElementById('hudInstruction');
  const hudClickBeads = document.getElementById('hudClickBeads');
  const bead1 = document.getElementById('bead1');
  const bead2 = document.getElementById('bead2');
  const bead3 = document.getElementById('bead3');
  const bead4 = document.getElementById('bead4');
  const btnStopRecordingAction = document.getElementById('btnStopRecordingAction');

  let isRecording = false;
  let recordingState = 'idle'; // 'idle', 'pass1', 'pass1_done', 'pass2_prelude', 'recording_take'
  let recStream = null;
  let recAudioCtx = null;
  let recMicSource = null;
  let recScriptProcessor = null;
  let recSilentGain = null;

  let pass1AudioChunks = [];
  let pass2AudioChunks = [];
  let pass1ClickEvents = [];
  let pass1TimeoutId = null;
  let pass1PostWaitTimeoutId = null;
  let hudTimerIntervalId = null;
  let takeStartTime = 0;
  let recordedTakesCount = 0;
  let detectedIntervalSec = 0;
  let userClickBuffers = [];
  let totalPass1Samples = 0;
  let totalPass2Samples = 0;

  async function refreshAudioInputDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      let audioInputs = devices.filter(d => d.kind === 'audioinput');

      // If device labels are blank, prompt briefly for mic permission
      if (audioInputs.length > 0 && !audioInputs[0].label) {
        try {
          const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          tempStream.getTracks().forEach(t => t.stop());
          devices = await navigator.mediaDevices.enumerateDevices();
          audioInputs = devices.filter(d => d.kind === 'audioinput');
        } catch (_) {}
      }

      if (recordDeviceSelect) {
        recordDeviceSelect.innerHTML = '';
        if (audioInputs.length === 0) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'Default Microphone';
          recordDeviceSelect.appendChild(opt);
        } else {
          audioInputs.forEach((dev, idx) => {
            const opt = document.createElement('option');
            opt.value = dev.deviceId;
            opt.textContent = dev.label || `Microphone ${idx + 1}`;
            recordDeviceSelect.appendChild(opt);
          });
        }
      }
    } catch (err) {
      console.warn('Failed to enumerate audio devices:', err);
    }
  }

  function resetClickBeads() {
    [bead1, bead2, bead3, bead4].forEach(b => {
      if (b) b.className = 'click-bead';
    });
  }

  function playSynthBeep(time, freq = 900, dur = 0.08) {
    if (!recAudioCtx) return;
    try {
      const osc = recAudioCtx.createOscillator();
      const g = recAudioCtx.createGain();
      osc.type = 'triangle'; // Richer harmonics than sine, clearly audible on mobile phone speakers
      osc.frequency.setValueAtTime(freq, time);
      g.gain.setValueAtTime(0.8, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + dur);
      osc.connect(g);
      g.connect(recAudioCtx.destination);
      osc.start(time);
      osc.stop(time + dur + 0.02);
    } catch (e) {
      console.warn('Synth beep error:', e);
    }
  }

  function playClickBuffer(time, clickBuf) {
    if (!recAudioCtx || !clickBuf) return;
    try {
      const src = recAudioCtx.createBufferSource();
      src.buffer = clickBuf;
      const g = recAudioCtx.createGain();
      g.gain.setValueAtTime(3.0, time); // Boost user click playback for mobile audibility
      src.connect(g);
      g.connect(recAudioCtx.destination);
      src.start(time);
    } catch (e) {
      console.warn('User click playback error:', e);
    }
  }

  function startHudTimer() {
    if (hudTimerIntervalId) clearInterval(hudTimerIntervalId);
    if (hudTimer) hudTimer.textContent = '00:00.0';
    hudTimerIntervalId = setInterval(() => {
      if (recordingState !== 'recording_take') return;
      const elapsedSec = (performance.now() - takeStartTime) / 1000;
      const mins = Math.floor(elapsedSec / 60);
      const secs = Math.floor(elapsedSec % 60);
      const tenths = Math.floor((elapsedSec * 10) % 10);
      if (hudTimer) {
        hudTimer.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
      }
    }, 100);
  }

  function cleanupRecordingNodes() {
    if (pass1TimeoutId) {
      clearTimeout(pass1TimeoutId);
      pass1TimeoutId = null;
    }
    if (pass1PostWaitTimeoutId) {
      clearTimeout(pass1PostWaitTimeoutId);
      pass1PostWaitTimeoutId = null;
    }
    if (hudTimerIntervalId) {
      clearInterval(hudTimerIntervalId);
      hudTimerIntervalId = null;
    }

    if (recScriptProcessor) {
      try {
        recScriptProcessor.onaudioprocess = null;
        recScriptProcessor.disconnect();
      } catch (_) {}
      recScriptProcessor = null;
    }

    if (recSilentGain) {
      try { recSilentGain.disconnect(); } catch (_) {}
      recSilentGain = null;
    }

    if (recMicSource) {
      try { recMicSource.disconnect(); } catch (_) {}
      recMicSource = null;
    }

    if (recStream) {
      try {
        recStream.getTracks().forEach(t => t.stop());
      } catch (_) {}
      recStream = null;
    }

    window.__nanodaw_processor = null;
    window.__nanodaw_stream = null;
    window.__nanodaw_mic = null;

    if (recordingHUD) {
      recordingHUD.classList.add('hidden');
      recordingHUD.style.display = 'none';
    }
    if (recordSetupModal) {
      recordSetupModal.classList.add('hidden');
      recordSetupModal.style.display = 'none';
    }
    if (btnRecord) btnRecord.classList.remove('recording');
    isRecording = false;
    recordingState = 'idle';
  }

  function cancelRecording() {
    audio.isRecording = false;
    audio.stop();
    cleanupRecordingNodes();
    showToast('Recording cancelled', 'info');
  }

  async function startRecordingFlow() {
    if (isRecording) {
      stopRecording();
      return;
    }

    const deviceId = recordDeviceSelect ? recordDeviceSelect.value : '';
    const use4ClickSync = record4ClickSync ? record4ClickSync.checked : true;

    try {
      // 1. Acquire mic stream without browser audio DSP filters for pure transient response
      const audioConstraints = {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false
      };
      if (deviceId) {
        audioConstraints.deviceId = { ideal: deviceId };
      }

      try {
        recStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      } catch (e1) {
        // Fallback to basic audio constraint if specific constraints rejected on Android
        recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      // 2. Obtain master AudioContext and ensure it is active
      recAudioCtx = audio.getOrCreateAudioContext();
      if (recAudioCtx.state === 'suspended' || recAudioCtx.state === 'interrupted') {
        await recAudioCtx.resume();
      }

      audio.isRecording = true;
      isRecording = true;
      if (btnRecord) btnRecord.classList.add('recording');
      if (recordingHUD) {
        recordingHUD.classList.remove('hidden');
        recordingHUD.style.display = 'flex';
      }

      if (use4ClickSync) {
        startPass1Calibration();
      } else {
        await startStandardPrelude();
      }
    } catch (err) {
      console.error('Failed to start recording:', err);
      audio.isRecording = false;
      cleanupRecordingNodes();
      showToast(`Microphone error: ${err.message}`, 'error', 4500);
    }
  }

  // --- Pass 1: 4-Click Transient Detection ---
  function startPass1Calibration() {
    recordingState = 'pass1';
    pass1AudioChunks = [];
    pass1ClickEvents = [];
    totalPass1Samples = 0;
    resetClickBeads();

    if (hudRecStatusText) hudRecStatusText.textContent = 'CALIBRATING (4 CLICKS)';
    if (hudInstruction) hudInstruction.textContent = 'Tap 4 sharp clicks / snaps (or tap screen)...';
    if (hudClickBeads) {
      hudClickBeads.classList.remove('hidden');
      hudClickBeads.style.display = 'flex';
    }
    if (hudTimer) hudTimer.textContent = '15s limit';

    // Hook up mic audio processing
    recMicSource = recAudioCtx.createMediaStreamSource(recStream);
    recScriptProcessor = recAudioCtx.createScriptProcessor(512, 1, 1);
    recSilentGain = recAudioCtx.createGain();
    recSilentGain.gain.value = 0.00001; // Avoid Chromium silent node pruning

    // Prevent GC in V8 mobile
    window.__nanodaw_processor = recScriptProcessor;
    window.__nanodaw_stream = recStream;
    window.__nanodaw_mic = recMicSource;

    let lastTransientTime = 0;
    const minRefractorySec = 0.14; // Refractory debounce window between clicks
    let ambientFloor = 0.005;

    function registerClick(now, samplePos) {
      if (recordingState !== 'pass1') return;
      lastTransientTime = now;
      pass1ClickEvents.push({ ctxTime: now, samplePos: samplePos });

      const count = pass1ClickEvents.length;
      if (count >= 1 && bead1) bead1.classList.add('active');
      if (count >= 2 && bead2) bead2.classList.add('active');
      if (count >= 3 && bead3) bead3.classList.add('active');
      if (count >= 4 && bead4) bead4.classList.add('active');

      if (count === 4) {
        recordingState = 'pass1_done';
        if (pass1TimeoutId) {
          clearTimeout(pass1TimeoutId);
          pass1TimeoutId = null;
        }
        if (hudInstruction) hudInstruction.textContent = '4 clicks calibrated! Starting count-in...';

        // Wait ~0.5s after 4th click, stop backing music and initiate Pass 2
        pass1PostWaitTimeoutId = setTimeout(async () => {
          audio.stop();
          await startPass2Flow();
        }, 500);
      }
    }

    recScriptProcessor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      pass1AudioChunks.push(copy);
      const currentSampleOffset = totalPass1Samples;
      totalPass1Samples += input.length;

      if (recordingState !== 'pass1') return;

      // Real-time transient analysis
      let peak = 0;
      let diffSum = 0;
      let sumSq = 0;
      for (let i = 0; i < input.length; i++) {
        const absVal = Math.abs(input[i]);
        if (absVal > peak) peak = absVal;
        sumSq += input[i] * input[i];
        if (i > 0) diffSum += Math.abs(input[i] - input[i - 1]);
      }
      const rms = Math.sqrt(sumSq / input.length);
      const hfMetric = diffSum / input.length;
      ambientFloor = 0.95 * ambientFloor + 0.05 * rms;

      const now = recAudioCtx ? recAudioCtx.currentTime : (performance.now() / 1000);
      if (peak > 0.025 && (peak > ambientFloor * 1.6 || hfMetric > 0.007) && (now - lastTransientTime > minRefractorySec)) {
        registerClick(now, currentSampleOffset);
      }
    };

    // Tap support: User can tap on HUD / beads on screen as an explicit click
    const onHudTap = (evt) => {
      if (recordingState !== 'pass1') return;
      if (evt.target.closest('#btnStopRecordingAction')) return;
      evt.preventDefault();
      evt.stopPropagation();
      const now = recAudioCtx ? recAudioCtx.currentTime : (performance.now() / 1000);
      if (now - lastTransientTime > minRefractorySec) {
        registerClick(now, totalPass1Samples);
      }
    };
    if (hudInstructionBox) {
      hudInstructionBox.addEventListener('pointerdown', onHudTap);
    }

    recMicSource.connect(recScriptProcessor);
    recScriptProcessor.connect(recSilentGain);
    recSilentGain.connect(recAudioCtx.destination);

    // Start music playback from t0
    audio.seek(0);
    audio.play();

    // 15-second safety timeout
    pass1TimeoutId = setTimeout(() => {
      if (recordingState === 'pass1' && pass1ClickEvents.length < 4) {
        cancelRecording();
        showToast('4 clicks were not detected within 15 seconds. You can tap screen or tap louder.', 'error', 4500);
      }
    }, 15000);
  }

  // --- Pass 2: 8-Click Prelude & Live Recording ---
  async function startPass2Flow() {
    if (!isRecording) return;

    // CRITICAL: Ensure audio context is running and NOT suspended!
    if (!recAudioCtx || recAudioCtx.state === 'closed') {
      recAudioCtx = audio.getOrCreateAudioContext();
    }
    if (recAudioCtx.state === 'suspended' || recAudioCtx.state === 'interrupted') {
      await recAudioCtx.resume();
    }

    const sampleRate = recAudioCtx.sampleRate;

    // 1. Calculate detected tempo interval
    const t1 = pass1ClickEvents[0]?.ctxTime || 0;
    const t4 = pass1ClickEvents[3]?.ctxTime || (t1 + 2.0);
    let dt = (t4 - t1) / 3;
    if (isNaN(dt) || dt < 0.25 || dt > 1.5) {
      dt = 60 / (state.project?.tempo || 78);
    }
    detectedIntervalSec = dt;

    // 2. Extract user's 4-click audio from Pass 1 recording
    const totalP1 = pass1AudioChunks.reduce((acc, c) => acc + c.length, 0);
    const p1Full = new Float32Array(totalP1);
    let p1Offset = 0;
    for (const chunk of pass1AudioChunks) {
      p1Full.set(chunk, p1Offset);
      p1Offset += chunk.length;
    }

    userClickBuffers = [];
    const clickWindowSamples = Math.min(Math.round(sampleRate * 0.25), Math.round(dt * 0.75 * sampleRate));
    for (let k = 0; k < 4; k++) {
      const clickSamplePos = pass1ClickEvents[k]?.samplePos || Math.round(k * dt * sampleRate);
      const startIdx = Math.max(0, clickSamplePos - Math.round(0.005 * sampleRate));
      const endIdx = Math.min(totalP1, startIdx + clickWindowSamples);
      const clickPCM = p1Full.slice(startIdx, endIdx);

      // Normalize click snippet so it's clearly audible on mobile
      let peakVal = 0;
      for (let i = 0; i < clickPCM.length; i++) {
        const av = Math.abs(clickPCM[i]);
        if (av > peakVal) peakVal = av;
      }
      const normGain = peakVal > 0.01 ? (0.85 / peakVal) : 2.5;

      // Soft 2ms ramp in / 10ms ramp out
      const rampIn = Math.min(clickPCM.length, Math.round(sampleRate * 0.002));
      const rampOut = Math.min(clickPCM.length, Math.round(sampleRate * 0.010));
      for (let i = 0; i < rampIn; i++) {
        clickPCM[i] *= 0.5 * (1 - Math.cos(Math.PI * (i / rampIn)));
      }
      for (let i = 0; i < rampOut; i++) {
        const idx = clickPCM.length - 1 - i;
        clickPCM[idx] *= 0.5 * (1 - Math.cos(Math.PI * (i / rampOut)));
      }
      for (let i = 0; i < clickPCM.length; i++) {
        clickPCM[i] *= normGain;
      }

      const buf = recAudioCtx.createBuffer(1, clickPCM.length, sampleRate);
      buf.getChannelData(0).set(clickPCM);
      userClickBuffers.push(buf);
    }

    // 3. Prepare Pass 2 recording pipeline
    pass2AudioChunks = [];
    totalPass2Samples = 0;
    recordingState = 'pass2_prelude';
    resetClickBeads();

    if (hudRecStatusText) hudRecStatusText.textContent = 'COUNT-IN (8 BEATS)';
    if (hudInstruction) hudInstruction.textContent = 'Count-in: 4 beeps + 4 of your clicks...';
    if (hudClickBeads) {
      hudClickBeads.classList.remove('hidden');
      hudClickBeads.style.display = 'flex';
    }

    // Capture Pass 2 continuous PCM (including the 8 prelude beats for synchronization)
    recScriptProcessor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      pass2AudioChunks.push(copy);
      totalPass2Samples += input.length;
    };

    // 4. Schedule the 8-beat prelude
    const startPreludeTime = recAudioCtx.currentTime + 0.15;

    // Beats 1 to 4: Synthesized beeps (and NOTHING else!)
    for (let i = 0; i < 4; i++) {
      const beatTime = startPreludeTime + i * dt;
      playSynthBeep(beatTime, i === 3 ? 1800 : 900, 0.08);

      const delayMs = Math.max(0, (beatTime - recAudioCtx.currentTime) * 1000);
      setTimeout(() => {
        if (recordingState !== 'pass2_prelude') return;
        if (hudInstruction) hudInstruction.textContent = `Beep ${i + 1} of 4 (${Math.round(60 / dt)} BPM)`;
        const bead = [bead1, bead2, bead3, bead4][i];
        if (bead) {
          bead.className = 'click-bead beep';
          setTimeout(() => { if (bead) bead.className = 'click-bead'; }, dt * 450);
        }
      }, delayMs);
    }

    // Beats 5 to 8: User's recorded clicks from Pass 1
    for (let i = 0; i < 4; i++) {
      const beatTime = startPreludeTime + (4 + i) * dt;
      playClickBuffer(beatTime, userClickBuffers[i] || userClickBuffers[0]);

      const delayMs = Math.max(0, (beatTime - recAudioCtx.currentTime) * 1000);
      setTimeout(() => {
        if (recordingState !== 'pass2_prelude') return;
        if (hudInstruction) hudInstruction.textContent = `Your Click ${i + 1} of 4 (calibrating...)`;
        const bead = [bead1, bead2, bead3, bead4][i];
        if (bead) {
          bead.className = 'click-bead active';
          setTimeout(() => { if (bead) bead.className = 'click-bead'; }, dt * 450);
        }
      }, delayMs);
    }

    // Beat 9: Downbeat! Backing music drops in, user records performance take
    const downbeatTime = startPreludeTime + 8 * dt;
    const downbeatDelay = Math.max(0, (downbeatTime - recAudioCtx.currentTime) * 1000);

    setTimeout(() => {
      if (recordingState !== 'pass2_prelude') return;
      recordingState = 'recording_take';
      if (hudRecStatusText) hudRecStatusText.textContent = 'RECORDING TAKE';
      if (hudInstruction) hudInstruction.textContent = 'Recording live... Sing or play along!';
      if (hudClickBeads) {
        hudClickBeads.classList.add('hidden');
        hudClickBeads.style.display = 'none';
      }
      takeStartTime = performance.now();
      startHudTimer();

      // Backing tracks start playback from time 0!
      audio.seek(0);
      audio.play();
    }, downbeatDelay);
  }

  // --- Standard Recording Mode (Count-in with 4 synth beeps) ---
  async function startStandardPrelude() {
    if (!recAudioCtx || recAudioCtx.state === 'closed') {
      recAudioCtx = audio.getOrCreateAudioContext();
    }
    if (recAudioCtx.state === 'suspended' || recAudioCtx.state === 'interrupted') {
      await recAudioCtx.resume();
    }

    const sampleRate = recAudioCtx.sampleRate;
    const tempo = state.project?.tempo || 78;
    const dt = 60 / tempo;
    detectedIntervalSec = dt;

    pass2AudioChunks = [];
    totalPass2Samples = 0;
    recordingState = 'pass2_prelude';
    resetClickBeads();

    if (hudRecStatusText) hudRecStatusText.textContent = 'COUNT-IN (4 BEATS)';
    if (hudInstruction) hudInstruction.textContent = `Count-in at ${tempo} BPM...`;
    if (hudClickBeads) {
      hudClickBeads.classList.remove('hidden');
      hudClickBeads.style.display = 'flex';
    }

    recMicSource = recAudioCtx.createMediaStreamSource(recStream);
    recScriptProcessor = recAudioCtx.createScriptProcessor(512, 1, 1);
    recSilentGain = recAudioCtx.createGain();
    recSilentGain.gain.value = 0.00001;

    recScriptProcessor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      pass2AudioChunks.push(copy);
      totalPass2Samples += input.length;
    };

    recMicSource.connect(recScriptProcessor);
    recScriptProcessor.connect(recSilentGain);
    recSilentGain.connect(recAudioCtx.destination);

    window.__nanodaw_processor = recScriptProcessor;
    window.__nanodaw_stream = recStream;
    window.__nanodaw_mic = recMicSource;

    const startPreludeTime = recAudioCtx.currentTime + 0.15;
    for (let i = 0; i < 4; i++) {
      const beatTime = startPreludeTime + i * dt;
      playSynthBeep(beatTime, i === 3 ? 1800 : 900, 0.08);

      const delayMs = Math.max(0, (beatTime - recAudioCtx.currentTime) * 1000);
      setTimeout(() => {
        if (recordingState !== 'pass2_prelude') return;
        if (hudInstruction) hudInstruction.textContent = `Beep ${i + 1} of 4`;
        const bead = [bead1, bead2, bead3, bead4][i];
        if (bead) {
          bead.className = 'click-bead beep';
          setTimeout(() => { if (bead) bead.className = 'click-bead'; }, dt * 450);
        }
      }, delayMs);
    }

    const downbeatTime = startPreludeTime + 4 * dt;
    const downbeatDelay = Math.max(0, (downbeatTime - recAudioCtx.currentTime) * 1000);

    setTimeout(() => {
      if (recordingState !== 'pass2_prelude') return;
      recordingState = 'recording_take';
      if (hudRecStatusText) hudRecStatusText.textContent = 'RECORDING TAKE';
      if (hudInstruction) hudInstruction.textContent = 'Recording live to new track...';
      if (hudClickBeads) {
        hudClickBeads.classList.add('hidden');
        hudClickBeads.style.display = 'none';
      }
      takeStartTime = performance.now();
      startHudTimer();

      audio.seek(0);
      audio.play();
    }, downbeatDelay);
  }

  // --- Stop Recording & Add New Track ---
  function stopRecording() {
    if (!isRecording) return;
    isRecording = false; // Immediately disable to prevent re-entrant calls
    audio.isRecording = false;

    // 1. Immediately hide all recording overlays
    cleanupRecordingNodes();

    // 2. Stop audio playback
    audio.stop();

    // 3. Process audio and create the new track
    const sampleRate = recAudioCtx ? recAudioCtx.sampleRate : 44100;
    const is4Click = record4ClickSync ? record4ClickSync.checked : true;
    const dt = detectedIntervalSec > 0 ? detectedIntervalSec : (60 / (state.project?.tempo || 78));
    const preludeSec = is4Click ? (8 * dt) : (4 * dt);
    const hardwareLatencySec = recAudioCtx ? ((recAudioCtx.outputLatency || 0) + (recAudioCtx.baseLatency || 0) || 0.035) : 0.035;
    const trimSamples = Math.round((preludeSec + hardwareLatencySec) * sampleRate);

    let takePCM = null;

    if (pass2AudioChunks.length > 0) {
      const totalSamples = pass2AudioChunks.reduce((acc, c) => acc + c.length, 0);
      const fullPass2 = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of pass2AudioChunks) {
        fullPass2.set(chunk, offset);
        offset += chunk.length;
      }

      if (totalSamples > trimSamples + Math.round(sampleRate * 0.1)) {
        // Discard the prelude up to the downbeat!
        takePCM = fullPass2.subarray(trimSamples);
      } else {
        // Stopped before or right at downbeat: keep all audio captured in Pass 2!
        takePCM = fullPass2;
      }
    } else if (pass1AudioChunks.length > 0) {
      // Stopped during Pass 1: keep all audio captured in Pass 1!
      const totalSamples = pass1AudioChunks.reduce((acc, c) => acc + c.length, 0);
      takePCM = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of pass1AudioChunks) {
        takePCM.set(chunk, offset);
        offset += chunk.length;
      }
    }

    // Fallback if no audio samples were captured
    if (!takePCM || takePCM.length < Math.round(sampleRate * 0.1)) {
      takePCM = new Float32Array(Math.round(sampleRate * 1.0));
    }

    // Apply a soft 5ms cosine ramp to audio start to avoid any edge click
    const rampSamples = Math.min(takePCM.length, Math.round(sampleRate * 0.005));
    for (let i = 0; i < rampSamples; i++) {
      takePCM[i] *= 0.5 * (1 - Math.cos(Math.PI * (i / rampSamples)));
    }

    const ctx = audio.getOrCreateAudioContext() || recAudioCtx;
    const takeBuffer = ctx.createBuffer(1, takePCM.length, sampleRate);
    takeBuffer.getChannelData(0).set(takePCM);

    recordedTakesCount++;
    const takeName = `Recorded Take ${recordedTakesCount}`;
    audio.addRecordedTrack(takeName, takeBuffer, 0, '#ef4444');

    showToast(`Added "${takeName}" (${(takePCM.length / sampleRate).toFixed(1)}s) to project!`, 'success', 4000);
    audio.seek(0);
    timeline.render();
    timeline.renderWaveforms();
    timeline.updateInspectorPane();
    if (timeline.scrollToStart) timeline.scrollToStart();
  }

  if (btnRecord) {
    btnRecord.addEventListener('click', () => {
      if (isRecording) {
        stopRecording();
      } else {
        if (recordSetupModal) {
          recordSetupModal.classList.remove('hidden');
          recordSetupModal.style.display = 'flex';
          refreshAudioInputDevices();
        }
      }
    });
  }

  if (btnCloseRecordSetupModal && recordSetupModal) {
    btnCloseRecordSetupModal.addEventListener('click', () => {
      recordSetupModal.classList.add('hidden');
      recordSetupModal.style.display = 'none';
    });
  }
  if (btnCancelRecordSetup && recordSetupModal) {
    btnCancelRecordSetup.addEventListener('click', () => {
      recordSetupModal.classList.add('hidden');
      recordSetupModal.style.display = 'none';
    });
  }
  if (btnStartRecordingAction) {
    btnStartRecordingAction.addEventListener('click', () => {
      if (recordSetupModal) {
        recordSetupModal.classList.add('hidden');
        recordSetupModal.style.display = 'none';
      }
      startRecordingFlow();
    });
  }
  if (btnStopRecordingAction) {
    btnStopRecordingAction.addEventListener('click', () => {
      stopRecording();
    });
  }

  // Auto-finish take when backing audio reaches the end
  audio.on('playback_stopped', () => {
    if (isRecording && recordingState === 'recording_take') {
      stopRecording();
    }
  });

  // --- Audio Export Controller ---
  const btnAudioExport = document.getElementById('btnAudioExport');
  const audioExportModal = document.getElementById('audioExportModal');
  const btnCloseAudioExportModal = document.getElementById('btnCloseAudioExportModal');
  const btnCancelAudioExport = document.getElementById('btnCancelAudioExport');
  const btnStartAudioExport = document.getElementById('btnStartAudioExport');
  const audioExportTarget = document.getElementById('audioExportTarget');
  const exportFormatWav = document.getElementById('exportFormatWav');
  const exportFormatMp3 = document.getElementById('exportFormatMp3');
  const exportInfoBox = document.getElementById('exportInfoBox');
  const audioExportProgress = document.getElementById('audioExportProgress');
  const audioExportProgressText = document.getElementById('audioExportProgressText');

  function populateAudioExportTargets() {
    if (!audioExportTarget) return;
    audioExportTarget.innerHTML = '';

    const mixOpt = document.createElement('option');
    mixOpt.value = 'mix';
    mixOpt.textContent = 'Full mix (applies volume / mute / solo)';
    audioExportTarget.appendChild(mixOpt);

    audio.tracks.forEach((track, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      const offsetSec = (track.offset || 0).toFixed(2);
      opt.textContent = `Track ${idx + 1}: ${track.name} (offset: ${offsetSec}s)`;
      audioExportTarget.appendChild(opt);
    });

    updateAudioExportInfo();
  }

  function updateAudioExportInfo() {
    if (!exportInfoBox || !audioExportTarget) return;
    const val = audioExportTarget.value;
    if (val === 'mix') {
      exportInfoBox.textContent = 'Full mix renders all active project tracks mixed together with active volume, mute, and solo settings.';
    } else {
      const idx = parseInt(val, 10);
      const track = audio.tracks[idx];
      const offsetSec = (track?.offset || 0).toFixed(2);
      exportInfoBox.textContent = `Exports raw track "${track?.name || 'Track'}" preceded with sample-accurate silence (${offsetSec}s) and a soft amplitude ramp. Volume, mute, and solo settings are bypassed.`;
    }
  }

  if (btnAudioExport && audioExportModal) {
    btnAudioExport.addEventListener('click', () => {
      populateAudioExportTargets();
      audioExportModal.classList.remove('hidden');
      audioExportModal.style.display = 'flex';
    });
  }

  if (btnCloseAudioExportModal && audioExportModal) {
    btnCloseAudioExportModal.addEventListener('click', () => {
      audioExportModal.classList.add('hidden');
      audioExportModal.style.display = 'none';
    });
  }
  if (btnCancelAudioExport && audioExportModal) {
    btnCancelAudioExport.addEventListener('click', () => {
      audioExportModal.classList.add('hidden');
      audioExportModal.style.display = 'none';
    });
  }
  if (audioExportTarget) {
    audioExportTarget.addEventListener('change', updateAudioExportInfo);
  }

  if (btnStartAudioExport) {
    btnStartAudioExport.addEventListener('click', async () => {
      const targetVal = audioExportTarget ? audioExportTarget.value : 'mix';
      const format = (exportFormatMp3 && exportFormatMp3.checked) ? 'mp3' : 'wav';

      btnStartAudioExport.disabled = true;
      if (audioExportProgress) {
        audioExportProgress.classList.remove('hidden');
        audioExportProgress.style.display = 'flex';
        if (audioExportProgressText) {
          audioExportProgressText.textContent = `Rendering ${format.toUpperCase()} audio...`;
        }
      }

      try {
        let result;
        if (targetVal === 'mix') {
          result = await audio.exportFullMix(format);
        } else {
          const trackIdx = parseInt(targetVal, 10);
          result = await audio.exportTrack(trackIdx, format);
        }

        const { blob, filename } = result;
        const dlUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = dlUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(dlUrl), 30000);

        showToast(`Exported "${filename}" successfully!`, 'success', 3500);
        if (audioExportModal) {
          audioExportModal.classList.add('hidden');
          audioExportModal.style.display = 'none';
        }
      } catch (err) {
        console.error('Audio Export failed:', err);
        showToast(`Export failed: ${err.message}`, 'error', 5000);
      } finally {
        btnStartAudioExport.disabled = false;
        if (audioExportProgress) {
          audioExportProgress.classList.add('hidden');
          audioExportProgress.style.display = 'none';
        }
      }
    });
  }

  // --- Keyboard Shortcuts ---
  window.addEventListener('keydown', (e) => {
    // Ignore when typing inside an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (isRecording) {
          stopRecording();
        } else {
          audio.togglePlay();
        }
        break;
      case 'KeyR':
        e.preventDefault();
        if (isRecording) {
          stopRecording();
        } else {
          if (btnRecord) btnRecord.click();
        }
        break;
      case 'Escape':
        e.preventDefault();
        if (isRecording) {
          cancelRecording();
          break;
        }
        if (!audio.isPlaying) {
          audio.hardReset();
          showToast('Audio Engine Reset', 'info', 1500);
        } else {
          audio.stop();
        }
        break;
      case 'Enter':
      case 'Home':
        e.preventDefault();
        handleRewind();
        break;
      case 'KeyL':
        e.preventDefault();
        if (btnLoop) btnLoop.click();
        break;
      case 'BracketLeft':
        e.preventDefault();
        jumpToRelativeMarker(-1);
        break;
      case 'BracketRight':
        e.preventDefault();
        jumpToRelativeMarker(1);
        break;
      case 'KeyM':
        if (e.shiftKey) {
          e.preventDefault();
          if (btnAddMarker) btnAddMarker.click();
        }
        break;
      case 'Equal':
      case 'NumpadAdd':
        e.preventDefault();
        if (btnZoomIn) btnZoomIn.click();
        break;
      case 'Minus':
      case 'NumpadSubtract':
        e.preventDefault();
        if (btnZoomOut) btnZoomOut.click();
        break;
      case 'Digit0':
      case 'KeyF':
        e.preventDefault();
        if (btnZoomFit) btnZoomFit.click();
        break;
    }
  });

  // Export JSON helper
  const btnExportProject = document.getElementById('btnExportProject');
  if (btnExportProject) {
    btnExportProject.addEventListener('click', () => {
      if (!state.project) return;
      const exportData = {
        ...state.project,
        markers: state.markers.map(m => ({ name: m.name, time: Number(m.time.toFixed(2)) })),
        tracks: state.project.tracks.map((t, i) => ({
          ...t,
          volume: state.tracksState[i]?.volume ?? 1.0,
          mute: state.tracksState[i]?.mute ?? false,
          solo: state.tracksState[i]?.solo ?? false
        }))
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const dlUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = `${(state.project.title || 'nanodaw_project').replace(/[\s/]/g, '_')}.json`;
      a.click();
      URL.revokeObjectURL(dlUrl);
      showToast('Project JSON exported!', 'success');
    });
  }

  // --- Logo Tap Expand / Collapse for Mobile & Touch ---
  const logoWrap = document.querySelector('.logo-icon-wrap');
  if (logoWrap) {
    logoWrap.addEventListener('click', (e) => {
      e.stopPropagation();
      logoWrap.classList.toggle('expanded');
    });

    // Collapse when clicking or tapping anywhere outside the logo
    document.addEventListener('pointerdown', (e) => {
      if (logoWrap.classList.contains('expanded') && !logoWrap.contains(e.target)) {
        logoWrap.classList.remove('expanded');
      }
    });
  }
});
