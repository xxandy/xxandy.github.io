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
  const isNewProjectSession = urlParams.has('new') || /(?:^\?|&)new(?=&|$)/i.test(window.location.search);

  if (isNewProjectSession) {
    const tempo = parseInt(urlParams.get('bpm') || '90', 10) || 90;
    const projectData = {
      title: 'New Project (Empty)',
      tempo: tempo,
      timeSignature: [4, 4],
      tracks: [],
      markers: []
    };
    document.title = 'NANOdaw - New Project (Empty)';
    const projectTitleEl = document.getElementById('projectTitle');
    if (projectTitleEl) {
      projectTitleEl.textContent = 'New Project (Empty)';
    }
    state.initProject(projectData, window.location.href, true);
    await audio.loadProjectTracks(projectData, window.location.href);
    setLoading(false);
    timeline.render();
    timeline.renderWaveforms();
    timeline.updateInspectorPane();

    // Alert reminder when navigating away from a new project
    window.addEventListener('beforeunload', (e) => {
      e.preventDefault();
      e.returnValue = '';
    });
  } else {
    const projectParam = urlParams.get('project') || 'demo.json';
    await loadProjectFromUrl(projectParam);
  }

  // --- Transport Controls ---
  const transportPlayRecSlot = document.getElementById('transportPlayRecSlot');
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
      if (isRecording) {
        stopRecording();
      } else {
        audio.togglePlay();
      }
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

  function refreshProfileBadgeCount() {
    if (!profileEventCountEl || !window.zoomProfiler) return;
    const evCount = window.zoomProfiler.getEventCount ? window.zoomProfiler.getEventCount() : 0;
    const diagCount = window.zoomProfiler.getDiagCount ? window.zoomProfiler.getDiagCount() : 0;
    profileEventCountEl.textContent = diagCount > 0 ? `${evCount} ev + ${diagCount} rec` : `${evCount}`;
  }

  if (btnToggleTools && toolsOverlay) {
    btnToggleTools.addEventListener('click', () => {
      toolsOverlay.classList.remove('hidden');
      refreshProfileBadgeCount();
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

  function triggerProfileDownload(triggerSource = 'manual') {
    if (!window.zoomProfiler) {
      showToast('Profiler not initialized', 'error');
      return;
    }
    const ctxRef = audio.audioCtx;
    const res = window.zoomProfiler.downloadProfile({
      triggerSource,
      projectTitle: state.project ? state.project.title : 'untitled',
      trackCount: audio.tracks ? audio.tracks.length : 0,
      currentZoom: timeline.pixelsPerSecond,
      audioCtxState: ctxRef ? ctxRef.state : 'none',
      audioCtxSampleRate: ctxRef ? ctxRef.sampleRate : null,
      audioCtxCurrentTime: ctxRef ? Number((ctxRef.currentTime || 0).toFixed(4)) : null
    });
    if (res && res.success) {
      const diagSuffix = res.totalDiag ? `, ${res.totalDiag} rec logs` : '';
      showToast(`Log saved: ${res.totalEvents} events${diagSuffix}`, 'success', 3500);
      refreshProfileBadgeCount();
    } else {
      showToast(res ? res.message : 'No telemetry recorded yet.', 'info', 3000);
    }
  }

  // Get Zoom & Recording Profile Download Action
  if (overlayBtnGetProfile) {
    overlayBtnGetProfile.addEventListener('click', () => {
      triggerProfileDownload('tools_overlay');
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

  // Playback & Recording state UI changes: Toggle hero button between Play (green triangle) and Stop (red square)
  let transportRecModeActive = false;
  function updatePlayButtonUI(isPlaying) {
    if (!btnPlay) return;
    const showStop = Boolean(isPlaying || transportRecModeActive || isRecording);
    if (showStop) {
      btnPlay.classList.add('playing');
      btnPlay.title = (transportRecModeActive || isRecording) ? 'Stop Recording (Space)' : 'Stop (Space)';
      btnPlay.setAttribute('aria-label', (transportRecModeActive || isRecording) ? 'Stop recording' : 'Stop playback');
      btnPlay.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <rect x="5" y="5" width="14" height="14" rx="2"/>
        </svg>
      `;
    } else {
      btnPlay.classList.remove('playing');
      btnPlay.title = 'Play (Space)';
      btnPlay.setAttribute('aria-label', 'Play');
      btnPlay.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="6 4 20 12 6 20 6 4"/>
        </svg>
      `;
    }
  }

  function setTransportRecordingUI(active) {
    transportRecModeActive = Boolean(active);
    if (transportPlayRecSlot) {
      transportPlayRecSlot.classList.toggle('recording-mode', transportRecModeActive);
    }
    updatePlayButtonUI(audio.isPlaying);
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
      if (isNewProjectSession) {
        if (!confirm('Reminder: If you have unsaved work in this new project, remember to export your project and audio before leaving. Continue?')) {
          return;
        }
      }
      projectModal.classList.add('hidden');
      loadProjectFromUrl('demo.json');
    });
  }

  if (jsonFileInput) {
    jsonFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (isNewProjectSession) {
        if (!confirm('Reminder: If you have unsaved work in this new project, remember to export your project and audio before leaving. Continue?')) {
          e.target.value = '';
          return;
        }
      }

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

  // --- Recording Engine & 2-Pass Sync Controller ---
  const btnRecord = document.getElementById('btnRecord');
  const recordSetupModal = document.getElementById('recordSetupModal');
  const btnCloseRecordSetupModal = document.getElementById('btnCloseRecordSetupModal');
  const btnCancelRecordSetup = document.getElementById('btnCancelRecordSetup');
  const recordDeviceSelect = document.getElementById('recordDeviceSelect');
  const recordChannelSelect = document.getElementById('recordChannelSelect');
  const recordChannelStatusBadge = document.getElementById('recordChannelStatusBadge');
  const record2PassSync = document.getElementById('record2PassSync');
  const container2PassSync = document.getElementById('container2PassSync');
  const containerSinglePass = document.getElementById('containerSinglePass');
  const guideModeSynth = document.getElementById('guideModeSynth');
  const guideModeTrack = document.getElementById('guideModeTrack');
  const guideSynthSubOptions = document.getElementById('guideSynthSubOptions');
  const guideTrackSubOptions = document.getElementById('guideTrackSubOptions');
  const syncSynthTempo = document.getElementById('syncSynthTempo');
  const syncMetronomeOn = document.getElementById('syncMetronomeOn');
  const syncMetronomeVolume = document.getElementById('syncMetronomeVolume');
  const syncGuideTrackSelect = document.getElementById('syncGuideTrackSelect');
  const singleMetronomeOn = document.getElementById('singleMetronomeOn');
  const singleMetronomeSubOptions = document.getElementById('singleMetronomeSubOptions');
  const singleMetronomeTempo = document.getElementById('singleMetronomeTempo');
  const singleMetronomeVolume = document.getElementById('singleMetronomeVolume');
  const btnStartRecordingAction = document.getElementById('btnStartRecordingAction');

  // Metronome Tab Elements
  const tabBtnRecord = document.getElementById('tabBtnRecord');
  const tabBtnMetronome = document.getElementById('tabBtnMetronome');
  const tabContentRecord = document.getElementById('tabContentRecord');
  const tabContentMetronome = document.getElementById('tabContentMetronome');
  const recordModalHeaderTitle = document.getElementById('recordModalHeaderTitle');
  const syncTrackFirstBeat = document.getElementById('syncTrackFirstBeat');
  const syncTrackNumBeats = document.getElementById('syncTrackNumBeats');

  if (syncTrackNumBeats) {
    const onBeatsChange = () => {
      if (typeof refreshPeakTriangleShades === 'function') {
        refreshPeakTriangleShades();
      }
    };
    syncTrackNumBeats.addEventListener('input', onBeatsChange);
    syncTrackNumBeats.addEventListener('change', onBeatsChange);
  }

  const metroTrackName = document.getElementById('metroTrackName');
  const metroTempo = document.getElementById('metroTempo');
  const metroBeatsPerMeasure = document.getElementById('metroBeatsPerMeasure');
  const metroDuration = document.getElementById('metroDuration');
  const btnGoMetronome = document.getElementById('btnGoMetronome');
  const btnCancelMetronome = document.getElementById('btnCancelMetronome');
  const recordAutoGain = document.getElementById('recordAutoGain');
  const recordAutoGainBadge = document.getElementById('recordAutoGainBadge');

  function isIOSorIPad() {
    const ua = navigator.userAgent || '';
    const isIOSPlatform = /iPad|iPhone|iPod/.test(ua);
    const isIPadOS = (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return isIOSPlatform || isIPadOS;
  }

  // Classify input device labels across Android (where Chromium names USB interfaces "USB headset"),
  // iOS/macOS CoreAudio, Windows WDM/WASAPI, and Linux ALSA/PipeWire.
  function classifyInputDeviceLabel(rawLabel) {
    const label = String(rawLabel || '').trim();
    const isUsb = /\busb\b|m-audio|\bair\s*192|scarlett|focusrite|behringer|\bumc\d|steinberg|\bur\d|motu|presonus|audient|\bssl\b|volt\s*\d|rubix|zoom\s+[hlu]\d|tascam|line\s*6|helix|irig|apogee|rode|shure|yeti|analogue\s*\d|analog\s*\d|external\s*audio/i.test(label);
    const isWiredHeadset = !isUsb && /\bwired\s*headset\b|\bheadset\s*microphone\b|\bearpods\b/i.test(label);
    const isBt = !isUsb && !isWiredHeadset && !/\busb\b|\bwired\b/i.test(label) && /bluetooth|hands-free|\bhfp\b|\bsco\b|powerbeat|airpod|galaxy\s*buds|pixel\s*buds|wh-|wf-|bose|wireless|headset/i.test(label);
    const isInternal = !isUsb && !isBt && !isWiredHeadset && /built-in|internal|phone|iphone|ipad|speakerphone|camcorder|front|back|^default\b|microphone$/i.test(label);
    return { isUsb, isBt, isWiredHeadset, isInternal };
  }

  // Detect 1-based hardware pair numbering in WDM endpoint names such as "Analogue 3 + 4 (M-Audio AIR 192|14)" or "Line 5/6"
  function getHardwarePairBaseChannel(deviceLabel) {
    const clean = String(deviceLabel || '').replace(/^[^\w(]+/, '');
    const m = clean.match(/\b(?:in(?:put)?s?|line|analog(?:ue)?|mic|ch(?:annel)?s?)\s*(\d{1,2})\s*(?:\+|\/|-|&|and)\s*(\d{1,2})\b/i)
      || clean.match(/^(\d{1,2})\s*(?:\+|\/|-|&)\s*(\d{1,2})\b/);
    if (m) {
      const n1 = parseInt(m[1], 10);
      const n2 = parseInt(m[2], 10);
      if (n1 >= 1 && n1 <= 31 && n2 === n1 + 1) {
        return n1;
      }
    }
    return 1;
  }

  const CHANNEL_PREF_STORAGE_KEY = 'nanodaw_channel_sel_v1';
  const deviceRawLabelById = new Map();
  let userManuallySelectedDeviceId = null;

  function getSelectedDeviceRawLabel() {
    if (!recordDeviceSelect) return '';
    const id = recordDeviceSelect.value || '';
    if (deviceRawLabelById.has(id)) return deviceRawLabelById.get(id) || '';
    const opt = recordDeviceSelect.selectedOptions && recordDeviceSelect.selectedOptions[0];
    return opt ? opt.textContent : '';
  }

  function normalizeDevicePrefKey(deviceLabel) {
    const clean = String(deviceLabel || 'default').toLowerCase().replace(/\s+/g, ' ').trim();
    return clean.slice(0, 80) || 'default';
  }

  function saveChannelSelectionPref(deviceLabel, selValue) {
    try {
      const raw = localStorage.getItem(CHANNEL_PREF_STORAGE_KEY);
      const map = raw ? JSON.parse(raw) : {};
      map[normalizeDevicePrefKey(deviceLabel)] = String(selValue);
      localStorage.setItem(CHANNEL_PREF_STORAGE_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  function loadChannelSelectionPref(deviceLabel) {
    try {
      const raw = localStorage.getItem(CHANNEL_PREF_STORAGE_KEY);
      if (!raw) return null;
      const map = JSON.parse(raw);
      return map[normalizeDevicePrefKey(deviceLabel)] || null;
    } catch (_) {
      return null;
    }
  }

  function parseChannelSelection(val) {
    const s = String(val || 'mono:0').trim();
    if (s === 'auto') {
      return { raw: 'auto', mode: 'auto', ch: 0, left: 0, right: 1, neededChannels: 2 };
    }
    if (s.startsWith('stereo:')) {
      const parts = s.split(':');
      const left = Math.max(0, parseInt(parts[1], 10) || 0);
      const right = Math.max(0, parseInt(parts[2], 10) || (left + 1));
      return {
        raw: `stereo:${left}:${right}`,
        mode: 'stereo',
        ch: left,
        left,
        right,
        neededChannels: Math.max(left, right) + 1
      };
    }
    if (s.startsWith('mono:')) {
      const ch = Math.max(0, parseInt(s.split(':')[1], 10) || 0);
      return { raw: `mono:${ch}`, mode: 'mono', ch, left: ch, right: ch, neededChannels: ch + 1 };
    }
    return { raw: 'mono:0', mode: 'mono', ch: 0, left: 0, right: 0, neededChannels: 1 };
  }

  let vuStreamTotalCh = 1;
  let vuStreamMaxCapCh = 1;

  function updateChannelStatusBadge(hintText = null) {
    if (!recordChannelStatusBadge) return;
    if (hintText) {
      recordChannelStatusBadge.textContent = hintText;
      recordChannelStatusBadge.classList.add('signal-hint');
      return;
    }
    recordChannelStatusBadge.classList.remove('signal-hint');
    const sel = parseChannelSelection(recordChannelSelect ? recordChannelSelect.value : 'mono:0');
    const modeTag = sel.mode === 'stereo' ? 'Stereo L/R' : (sel.mode === 'auto' ? 'Auto Mono' : 'Mono');
    if (vuStreamMaxCapCh > vuStreamTotalCh) {
      recordChannelStatusBadge.textContent = `${vuStreamTotalCh}/${vuStreamMaxCapCh} ch · ${modeTag}`;
    } else {
      recordChannelStatusBadge.textContent = `${vuStreamTotalCh} ch active · ${modeTag}`;
    }
  }

  function populateChannelSelectOptions({ streamChannels = 1, maxCapChannels = 1, deviceLabel = '', preserveValue = true } = {}) {
    if (!recordChannelSelect) return;
    const prevValue = preserveValue ? recordChannelSelect.value : null;
    const savedPref = loadChannelSelectionPref(deviceLabel);
    const totalCh = Math.min(16, Math.max(1, streamChannels | 0, maxCapChannels | 0));
    const baseNum = getHardwarePairBaseChannel(deviceLabel);

    vuStreamTotalCh = Math.max(1, streamChannels | 0);
    vuStreamMaxCapCh = totalCh;

    recordChannelSelect.innerHTML = '';

    // 1. Individual discrete mono streams: Input 1 (Mono), Input 2 (Mono), ..., Input N (Mono)
    for (let c = 0; c < totalCh; c++) {
      const opt = document.createElement('option');
      opt.value = `mono:${c}`;
      const hwNum = baseNum + c;
      opt.textContent = `Input ${hwNum} (Mono)`;
      recordChannelSelect.appendChild(opt);
    }

    // 2. Paired stereo streams: Stereo 1/2 (1 = L, 2 = R), Stereo 3/4 (3 = L, 4 = R), ...
    if (totalCh >= 2) {
      for (let c = 0; c + 1 < totalCh; c += 2) {
        const opt = document.createElement('option');
        opt.value = `stereo:${c}:${c + 1}`;
        const hwL = baseNum + c;
        const hwR = baseNum + c + 1;
        opt.textContent = `Stereo ${hwL}/${hwR} (${hwL} = L, ${hwR} = R)`;
        recordChannelSelect.appendChild(opt);
      }

      // 3. Smart auto-detect option for quick plug-and-play mono capture
      const autoOpt = document.createElement('option');
      autoOpt.value = 'auto';
      autoOpt.textContent = 'Auto-Detect Active Input (Mono)';
      recordChannelSelect.appendChild(autoOpt);
    }

    const validValues = new Set(Array.from(recordChannelSelect.options).map(o => o.value));
    if (prevValue && validValues.has(prevValue)) {
      recordChannelSelect.value = prevValue;
    } else if (savedPref && validValues.has(savedPref)) {
      recordChannelSelect.value = savedPref;
    } else {
      recordChannelSelect.value = 'mono:0';
    }

    updateChannelStatusBadge();
  }

  let autoGainUserOverridden = false;
  function initAutoGainDefault() {
    if (!recordAutoGain) return;
    if (!autoGainUserOverridden) {
      const devInfo = classifyInputDeviceLabel(getSelectedDeviceRawLabel());
      // Always disable OS Auto Gain by default for external USB audio interfaces (preserves hardware preamp gain & multi-channel streams)
      const shouldEnable = isIOSorIPad() && !devInfo.isUsb;
      recordAutoGain.checked = shouldEnable;
      if (recordAutoGainBadge) {
        recordAutoGainBadge.textContent = devInfo.isUsb
          ? 'AUTO (USB OFF)'
          : (shouldEnable ? 'AUTO (iPad ON)' : 'AUTO (Android OFF)');
      }
    }
  }

  if (recordAutoGain) {
    initAutoGainDefault();
    recordAutoGain.addEventListener('change', () => {
      autoGainUserOverridden = true;
      if (recordAutoGain.checked && recordChannelSelect) {
        const sel = parseChannelSelection(recordChannelSelect.value);
        if (sel.neededChannels > 1) {
          recordChannelSelect.value = 'mono:0';
          showToast('Auto Gain uses mono voice processing — switched input to Input 1 (Mono).', 'info', 3500);
        }
      }
      if (recordAutoGainBadge) {
        recordAutoGainBadge.textContent = recordAutoGain.checked ? 'MANUAL (ON)' : 'MANUAL (OFF)';
      }
      recDiag('REC_AUTOGAIN_TOGGLED', { autoGain: recordAutoGain.checked }, { forcePersist: true });
      if (activeRecordModalTab === 'record') {
        startVUMonitor(true);
      }
    });
  }

  const recordInternalGain = document.getElementById('recordInternalGain');
  const recordInternalGainBadge = document.getElementById('recordInternalGainBadge');

  if (recordInternalGain) {
    // ALWAYS off by default
    recordInternalGain.checked = false;
    recordInternalGain.addEventListener('change', () => {
      if (recordInternalGainBadge) {
        if (recordInternalGain.checked) {
          recordInternalGainBadge.textContent = 'ON';
          recordInternalGainBadge.style.background = 'rgba(6, 182, 212, 0.2)';
          recordInternalGainBadge.style.color = 'var(--accent-cyan)';
          recordInternalGainBadge.style.borderColor = 'rgba(6, 182, 212, 0.4)';
        } else {
          recordInternalGainBadge.textContent = 'OFF';
          recordInternalGainBadge.style.background = 'rgba(255, 255, 255, 0.08)';
          recordInternalGainBadge.style.color = 'var(--text-secondary)';
          recordInternalGainBadge.style.borderColor = 'var(--border-color)';
        }
      }
    });
  }

  let activeRecordModalTab = 'record'; // 'record' or 'metronome'
  let activeSyncSession = null;

  const recordingHUD = document.getElementById('recordingHUD');
  const hudInstructionBox = document.getElementById('hudInstructionBox');
  const hudRecStatusText = document.getElementById('hudRecStatusText');
  const hudTimer = document.getElementById('hudTimer');
  const hudInstruction = document.getElementById('hudInstruction');
  const hudLatencyText = document.getElementById('hudLatencyText');
  const hudClickBeads = document.getElementById('hudClickBeads');
  const hudLiveAlert = document.getElementById('hudLiveAlert');
  const btnStopRecordingAction = document.getElementById('btnStopRecordingAction');
  const btnRecModalGetLog = document.getElementById('btnRecModalGetLog');
  const btnHudGetLog = document.getElementById('btnHudGetLog');

  if (btnRecModalGetLog) {
    btnRecModalGetLog.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerProfileDownload('record_modal');
    });
  }
  if (btnHudGetLog) {
    btnHudGetLog.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerProfileDownload('recording_hud');
    });
  }

  let isRecording = false;
  let recordingState = 'idle'; // 'idle', 'sync_preroll', 'pass2_prelude', 'recording_take'
  let recStream = null;
  let recAudioCtx = null;
  let recMicSource = null;
  let recScriptProcessor = null;
  let recWorkletNode = null;
  let recSilentGain = null;

  let pass2ClickEvents = [];
  let hudTimerIntervalId = null;
  let takeStartTime = 0;
  let recordedTakesCount = 0;
  let detectedIntervalSec = 0;
  let totalPass2Samples = 0;
  let pass2StreamStartTime = null;
  let pass2DownbeatScheduledTime = null;
  let recordingStartPlayhead = 0;

  // --- Recording Stream & Pipeline Realtime Diagnostics ---
  let recDiagCleanupTrackListeners = null;
  let recDiagWatchdogId = null;
  let recChunksReceivedTotal = 0;
  let recFirstChunkLogged = false;
  let recPipelineAttachPerfMs = 0;
  let lastWorkletDiagReport = null;

  function recDiag(stage, detail = {}, options = {}) {
    if (window.zoomProfiler && typeof window.zoomProfiler.logDiag === 'function') {
      window.zoomProfiler.logDiag(stage, detail, options);
    }
  }

  function inspectAudioCtx(ctx) {
    if (!ctx) return { exists: false };
    return {
      exists: true,
      state: ctx.state,
      sampleRate: ctx.sampleRate,
      currentTime: Number((ctx.currentTime || 0).toFixed(4)),
      baseLatency: typeof ctx.baseLatency === 'number' ? Number(ctx.baseLatency.toFixed(5)) : null,
      outputLatency: typeof ctx.outputLatency === 'number' ? Number(ctx.outputLatency.toFixed(5)) : null,
      destChannelCount: ctx.destination ? ctx.destination.channelCount : null,
      destMaxChannelCount: ctx.destination ? ctx.destination.maxChannelCount : null,
      destChannelCountMode: ctx.destination ? ctx.destination.channelCountMode : null,
      audioSessionType: (typeof navigator !== 'undefined' && navigator.audioSession) ? (navigator.audioSession.type || 'unset') : 'unsupported'
    };
  }

  function inspectMediaStream(stream) {
    if (!stream) return { exists: false };
    const tracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
    return {
      exists: true,
      id: stream.id ? String(stream.id).slice(0, 16) : null,
      active: Boolean(stream.active),
      trackCount: tracks.length,
      tracks: tracks.map((t, idx) => {
        let settings = null;
        let capabilities = null;
        let constraints = null;
        try { if (typeof t.getSettings === 'function') settings = t.getSettings(); } catch (_) {}
        try { if (typeof t.getCapabilities === 'function') capabilities = t.getCapabilities(); } catch (_) {}
        try { if (typeof t.getConstraints === 'function') constraints = t.getConstraints(); } catch (_) {}
        return {
          idx,
          label: t.label || '',
          readyState: t.readyState,
          enabled: t.enabled,
          muted: t.muted,
          settings: settings ? {
            sampleRate: settings.sampleRate,
            sampleSize: settings.sampleSize,
            channelCount: settings.channelCount,
            latency: settings.latency,
            echoCancellation: settings.echoCancellation,
            autoGainControl: settings.autoGainControl,
            noiseSuppression: settings.noiseSuppression,
            deviceIdPrefix: settings.deviceId ? String(settings.deviceId).slice(0, 12) : undefined
          } : null,
          capabilities: capabilities ? {
            sampleRate: capabilities.sampleRate,
            sampleSize: capabilities.sampleSize,
            channelCount: capabilities.channelCount,
            latency: capabilities.latency,
            echoCancellation: capabilities.echoCancellation,
            autoGainControl: capabilities.autoGainControl,
            noiseSuppression: capabilities.noiseSuppression
          } : null,
          constraints
        };
      })
    };
  }

  function attachStreamTrackListeners(stream, role = 'recording') {
    if (!stream || !stream.getAudioTracks) return () => {};
    const cleanups = [];
    stream.getAudioTracks().forEach((track, idx) => {
      const onMute = () => {
        recDiag('REC_MIC_TRACK_MUTED', {
          role,
          idx,
          label: track.label,
          readyState: track.readyState,
          muted: track.muted,
          recordingState,
          ctx: inspectAudioCtx(recAudioCtx || audio.audioCtx)
        }, {
          level: 'warn',
          stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_TRACK_EVENT : undefined,
          extraData: 1,
          forcePersist: true
        });
      };
      const onUnmute = () => {
        recDiag('REC_MIC_TRACK_UNMUTED', {
          role,
          idx,
          label: track.label,
          readyState: track.readyState,
          muted: track.muted,
          recordingState
        }, {
          stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_TRACK_EVENT : undefined,
          extraData: 2,
          forcePersist: true
        });
      };
      const onEnded = () => {
        recDiag('REC_MIC_TRACK_ENDED', {
          role,
          idx,
          label: track.label,
          readyState: track.readyState,
          muted: track.muted,
          recordingState,
          ctx: inspectAudioCtx(recAudioCtx || audio.audioCtx)
        }, {
          level: 'error',
          stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_TRACK_EVENT : undefined,
          extraData: 3,
          forcePersist: true
        });
      };
      track.addEventListener('mute', onMute);
      track.addEventListener('unmute', onUnmute);
      track.addEventListener('ended', onEnded);
      cleanups.push(() => {
        track.removeEventListener('mute', onMute);
        track.removeEventListener('unmute', onUnmute);
        track.removeEventListener('ended', onEnded);
      });
    });
    return () => cleanups.forEach(fn => { try { fn(); } catch (_) {} });
  }

  function stopRecordingWatchdog() {
    if (recDiagWatchdogId) {
      clearInterval(recDiagWatchdogId);
      recDiagWatchdogId = null;
    }
  }

  function startRecordingWatchdog() {
    stopRecordingWatchdog();
    let lastCtxTime = recAudioCtx ? recAudioCtx.currentTime : 0;
    let lastChunks = recChunksReceivedTotal;
    let tickIndex = 0;

    recDiagWatchdogId = setInterval(() => {
      if (!isRecording) {
        stopRecordingWatchdog();
        return;
      }
      tickIndex++;
      if (recWorkletNode && recWorkletNode.port) {
        try { recWorkletNode.port.postMessage({ type: 'ping_diag' }); } catch (_) {}
      }

      const curCtxTime = recAudioCtx ? recAudioCtx.currentTime : 0;
      const ctxDelta = Number((curCtxTime - lastCtxTime).toFixed(4));
      const chunksDelta = recChunksReceivedTotal - lastChunks;
      lastCtxTime = curCtxTime;
      lastChunks = recChunksReceivedTotal;

      const trk = (recStream && recStream.getAudioTracks && recStream.getAudioTracks()[0]) || null;
      const snapshot = {
        tick: tickIndex,
        recordingState,
        ctxState: recAudioCtx ? recAudioCtx.state : 'none',
        ctxTime: Number(curCtxTime.toFixed(4)),
        ctxDeltaSec: ctxDelta,
        chunksDelta,
        chunksTotal: recChunksReceivedTotal,
        capturedSamples: totalPass2Samples,
        streamActive: recStream ? Boolean(recStream.active) : false,
        trackReadyState: trk ? trk.readyState : 'none',
        trackMuted: trk ? trk.muted : null,
        isPlaying: Boolean(audio.isPlaying),
        playhead: Number((audio.playheadPosition || 0).toFixed(3)),
        worklet: lastWorkletDiagReport
      };

      const isClockStalled = (recAudioCtx && recAudioCtx.state === 'running' && ctxDelta < 0.02);
      const isChunkStalled = (tickIndex >= 2 && chunksDelta === 0 && (recordingState === 'sync_preroll' || recordingState === 'pass2_prelude' || recordingState === 'recording_take'));

      if (isClockStalled || isChunkStalled) {
        recDiag('REC_STREAM_STALL_DETECTED', {
          ...snapshot,
          isClockStalled,
          isChunkStalled
        }, {
          level: 'warn',
          stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_STREAM_STALL : undefined,
          extraData: isClockStalled ? 1 : 2,
          forcePersist: true
        });
      } else {
        recDiag('REC_HEARTBEAT', snapshot, {
          stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_WORKLET_HEARTBEAT : undefined,
          extraData: chunksDelta
        });
      }
    }, 1000);
  }

  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      let summary = [];
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        summary = devs
          .filter(d => d.kind === 'audioinput' || d.kind === 'audiooutput')
          .map(d => ({ kind: d.kind, label: d.label || '(unlabeled)', idPrefix: d.deviceId ? d.deviceId.slice(0, 10) : '' }));
      } catch (_) {}
      recDiag('MEDIA_DEVICES_CHANGED', {
        isRecording,
        recordingState,
        devices: summary,
        ctx: inspectAudioCtx(recAudioCtx || audio.audioCtx)
      }, {
        level: isRecording ? 'warn' : 'info',
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_TRACK_EVENT : undefined,
        extraData: 9,
        forcePersist: true
      });
      // Hot-plug support (e.g. USB-C OTG audio interface plugged in while Record Setup modal is open)
      if (!isRecording && recordSetupModal && !recordSetupModal.classList.contains('hidden') && recordSetupModal.style.display !== 'none') {
        await refreshAudioInputDevices();
        if (activeRecordModalTab === 'record') {
          startVUMonitor(true);
        }
      }
    });
  }

  // --- High-Performance Batched Zero-Allocation Recording Store ---
  class BatchedAudioStore {
    constructor(segmentSize = 524288, initialSegments = 4) {
      this.segmentSize = segmentSize; // ~11.88 sec per segment at 44.1kHz (2 MB)
      this.activeSegments = [];
      this.standbySegments = [];
      this.totalSamples = 0;
      this.currentSegWriteIndex = 0;

      for (let i = 0; i < initialSegments; i++) {
        this.standbySegments.push(new Float32Array(this.segmentSize));
      }
    }

    prepareAheadOfTime(minStandby = 4) {
      while (this.standbySegments.length < minStandby) {
        this.standbySegments.push(new Float32Array(this.segmentSize));
      }
    }

    ensureStandbyCapacity() {
      // Proactively ensure at least 2 standby segments (~24s headroom) are ready in advance
      while (this.standbySegments.length < 2) {
        this.standbySegments.push(new Float32Array(this.segmentSize));
      }
    }

    reset() {
      while (this.activeSegments.length > 0) {
        this.standbySegments.push(this.activeSegments.pop());
      }
      this.totalSamples = 0;
      this.currentSegWriteIndex = 0;
      this.prepareAheadOfTime(4);
    }

    append(chunk, validLength) {
      const len = validLength !== undefined ? validLength : chunk.length;
      let srcOffset = 0;

      while (srcOffset < len) {
        if (this.activeSegments.length === 0 || this.currentSegWriteIndex >= this.segmentSize) {
          if (this.standbySegments.length === 0) {
            this.standbySegments.push(new Float32Array(this.segmentSize));
          }
          const nextSeg = this.standbySegments.shift();
          this.activeSegments.push(nextSeg);
          this.currentSegWriteIndex = 0;
          this.ensureStandbyCapacity();
        }

        const currentSeg = this.activeSegments[this.activeSegments.length - 1];
        const spaceLeft = this.segmentSize - this.currentSegWriteIndex;
        const copyLen = Math.min(len - srcOffset, spaceLeft);

        currentSeg.set(chunk.subarray(srcOffset, srcOffset + copyLen), this.currentSegWriteIndex);
        this.currentSegWriteIndex += copyLen;
        srcOffset += copyLen;
        this.totalSamples += copyLen;

        // Proactively allocate next buffer early when passing half segment
        if (this.currentSegWriteIndex > this.segmentSize / 2) {
          this.ensureStandbyCapacity();
        }
      }
    }

    toFlatArray(startSample = 0, endSample = null) {
      const end = (endSample !== null && endSample <= this.totalSamples) ? endSample : this.totalSamples;
      const start = Math.max(0, startSample);
      const count = Math.max(0, end - start);
      if (count === 0) return new Float32Array(0);

      const out = new Float32Array(count);
      let outOffset = 0;
      let segStartGlobal = 0;

      for (let s = 0; s < this.activeSegments.length; s++) {
        const seg = this.activeSegments[s];
        const segLen = (s === this.activeSegments.length - 1) ? this.currentSegWriteIndex : this.segmentSize;
        const segEndGlobal = segStartGlobal + segLen;

        if (segEndGlobal > start && segStartGlobal < end) {
          const segLocalStart = Math.max(0, start - segStartGlobal);
          const segLocalEnd = Math.min(segLen, end - segStartGlobal);
          const copyCount = segLocalEnd - segLocalStart;

          out.set(seg.subarray(segLocalStart, segLocalEnd), outOffset);
          outOffset += copyCount;
        }
        segStartGlobal = segEndGlobal;
        if (segStartGlobal >= end) break;
      }
      return out;
    }
  }

  const pass2AudioStore = new BatchedAudioStore();
  const pass2AudioStoreR = new BatchedAudioStore();
  let activeRecordingChannelConfig = { raw: 'mono:0', mode: 'mono', ch: 0, left: 0, right: 0, neededChannels: 1 };

  // Combine Left & Right PCM using max-signed-amplitude for sync tap detection (zero -6 dB loss, zero phase cancellation)
  function combineStereoForPeakDetection(pcmL, pcmR) {
    if (!pcmR || pcmR.length === 0) return pcmL;
    const len = Math.min(pcmL.length, pcmR.length);
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const a = pcmL[i];
      const b = pcmR[i];
      out[i] = Math.abs(a) >= Math.abs(b) ? a : b;
    }
    return out;
  }

  // NANOdaw Intelligent Transient Pop & Glitch Suppressor
  // Automatically detects and seamlessly repairs micro-glitches, CoreAudio resampler slips, chassis taps, and electrical pops
  function suppressAudioGlitches(pcm, sampleRate = 44100) {
    if (!pcm || pcm.length < 64) return pcm;
    const len = pcm.length;
    const out = new Float32Array(pcm);
    const winSize = Math.max(32, Math.round(sampleRate * 0.005));
    let i = 2;
    let repaired = 0;

    while (i < len - 32) {
      const d = Math.abs(out[i] - out[i - 1]);
      if (d > 0.18) {
        const s0 = Math.max(0, i - winSize);
        const s1 = Math.max(1, i - 4);
        let sumSq = 0;
        let count = 0;
        for (let j = s0; j < s1; j++) {
          sumSq += out[j] * out[j];
          count++;
        }
        const localRms = count > 0 ? Math.sqrt(sumSq / count) : 0.05;

        // An abnormal transient impulse / chassis click / resampler pop:
        if (d > Math.max(0.08, localRms * 3.8)) {
          const burstStart = i - 1;
          const maxBurstLen = Math.round(sampleRate * 0.0025);
          let burstEnd = Math.min(len - 1, burstStart + maxBurstLen);
          let calmCount = 0;

          for (let j = burstStart + 1; j < Math.min(len - 2, burstStart + maxBurstLen + 20); j++) {
            const dj = Math.abs(out[j] - out[j - 1]);
            if (dj < Math.max(0.06, localRms * 1.8)) {
              calmCount++;
              if (calmCount >= 5) {
                burstEnd = j - 4;
                break;
              }
            } else {
              calmCount = 0;
            }
          }

          const blen = burstEnd - burstStart;
          if (blen > 0) {
            const y0 = out[burstStart];
            const y1 = out[burstEnd];
            for (let k = 0; k < blen; k++) {
              const mu = k / blen;
              const w = 0.5 * (1 - Math.cos(Math.PI * mu));
              out[burstStart + k] = (1 - w) * y0 + w * y1;
            }
            repaired++;
            i = burstEnd + 10;
            continue;
          }
        }
      }
      i++;
    }

    if (repaired > 0) {
      console.log(`[NANOdaw Glitch Suppressor] Successfully repaired ${repaired} transient pop/glitch event(s).`);
    }
    return out;
  }

  // NANOdaw Internal Gain Control & Automatic Noise Suppression
  // Includes: 2nd-order 80Hz Low-Cut (rumble filter) + 10.5kHz High-Cut (hiss filter) + Downward Noise Expander + 75% Peak Scaling
  function processInternalGainAndNoiseSuppression(pcm, sampleRate = 44100, targetPeak = 0.75) {
    if (!pcm || pcm.length === 0) return pcm;
    const cleanPcm = suppressAudioGlitches(pcm, sampleRate);
    const len = cleanPcm.length;
    const out = new Float32Array(len);

    // 1. 2nd-order Butterworth High-Pass Filter (80 Hz Low-Cut to remove table/room rumble and mains hum)
    const f_hp = 80, q_hp = 0.7071;
    const w0_hp = 2 * Math.PI * f_hp / sampleRate;
    const cos_hp = Math.cos(w0_hp);
    const alpha_hp = Math.sin(w0_hp) / (2 * q_hp);
    const a0_hp = 1 + alpha_hp;
    const b0_hp = ((1 + cos_hp) / 2) / a0_hp;
    const b1_hp = (-(1 + cos_hp)) / a0_hp;
    const b2_hp = ((1 + cos_hp) / 2) / a0_hp;
    const a1_hp = (-2 * cos_hp) / a0_hp;
    const a2_hp = (1 - alpha_hp) / a0_hp;

    // 2. 2nd-order Butterworth Low-Pass Filter (10.5 kHz High-Cut to remove electronic high-frequency hiss)
    const f_lp = 10500, q_lp = 0.7071;
    const w0_lp = 2 * Math.PI * f_lp / sampleRate;
    const cos_lp = Math.cos(w0_lp);
    const alpha_lp = Math.sin(w0_lp) / (2 * q_lp);
    const a0_lp = 1 + alpha_lp;
    const b0_lp = ((1 - cos_lp) / 2) / a0_lp;
    const b1_lp = (1 - cos_lp) / a0_lp;
    const b2_lp = ((1 - cos_lp) / 2) / a0_lp;
    const a1_lp = (-2 * cos_lp) / a0_lp;
    const a2_lp = (1 - alpha_lp) / a0_lp;

    let x1_hp = 0, x2_hp = 0, y1_hp = 0, y2_hp = 0;
    let x1_lp = 0, x2_lp = 0, y1_lp = 0, y2_lp = 0;

    for (let i = 0; i < len; i++) {
      const inSamp = cleanPcm[i];
      const hpSamp = b0_hp * inSamp + b1_hp * x1_hp + b2_hp * x2_hp - a1_hp * y1_hp - a2_hp * y2_hp;
      x2_hp = x1_hp; x1_hp = inSamp;
      y2_hp = y1_hp; y1_hp = hpSamp;

      const lpSamp = b0_lp * hpSamp + b1_lp * x1_lp + b2_lp * x2_lp - a1_lp * y1_lp - a2_lp * y2_lp;
      x2_lp = x1_lp; x1_lp = hpSamp;
      y2_lp = y1_lp; y1_lp = lpSamp;

      out[i] = lpSamp;
    }

    // 3. Gentle Downward Expander (Noise Gate during silent intervals)
    let sumSq = 0;
    const sampleLimit = Math.min(len, sampleRate);
    for (let i = 0; i < sampleLimit; i++) sumSq += out[i] * out[i];
    const estRms = Math.sqrt(sumSq / sampleLimit);
    const gateThreshold = Math.max(0.003, estRms * 1.4);

    let currentGain = 1.0;
    const attackCoeff = Math.exp(-1 / (0.002 * sampleRate)); // 2ms fast attack to keep transients punchy
    const releaseCoeff = Math.exp(-1 / (0.080 * sampleRate)); // 80ms smooth release

    for (let i = 0; i < len; i++) {
      const absVal = Math.abs(out[i]);
      const targetGain = absVal > gateThreshold ? 1.0 : 0.20; // 14 dB attenuation during quiet intervals
      if (targetGain > currentGain) {
        currentGain = attackCoeff * currentGain + (1 - attackCoeff) * targetGain;
      } else {
        currentGain = releaseCoeff * currentGain + (1 - releaseCoeff) * targetGain;
      }
      out[i] *= currentGain;
    }

    // 4. Amplitude Scaling to targetPeak (0.75 / -2.5 dBFS)
    let maxAmp = 0;
    for (let i = 0; i < len; i++) {
      const a = Math.abs(out[i]);
      if (a > maxAmp) maxAmp = a;
    }

    if (maxAmp >= 0.003 && maxAmp < targetPeak) {
      const gain = Math.min(25.0, targetPeak / maxAmp);
      for (let i = 0; i < len; i++) {
        out[i] = Math.max(-1.0, Math.min(1.0, out[i] * gain));
      }
      console.log(`[NANOdaw Internal Gain] Filtered & boosted take by ${gain.toFixed(2)}x (+${(20 * Math.log10(gain)).toFixed(1)}dB). Peak was ${maxAmp.toFixed(4)}, now ${(maxAmp * gain).toFixed(4)} (~${Math.round(targetPeak * 100)}%).`);
    } else if (maxAmp > 0.98) {
      const gain = 0.95 / maxAmp;
      for (let i = 0; i < len; i++) {
        out[i] *= gain;
      }
    }

    return out;
  }

  // Stereo-linked Internal Gain & Noise Suppression (preserves exact L/R stereo balance without image shifting)
  function processStereoInternalGainAndNoiseSuppression(pcmL, pcmR, sampleRate = 44100, targetPeak = 0.75) {
    if (!pcmR || pcmR.length === 0) {
      return { left: processInternalGainAndNoiseSuppression(pcmL, sampleRate, targetPeak), right: null };
    }
    const cleanL = suppressAudioGlitches(pcmL, sampleRate);
    const cleanR = suppressAudioGlitches(pcmR, sampleRate);
    const len = Math.min(cleanL.length, cleanR.length);
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);

    const f_hp = 80, q_hp = 0.7071;
    const w0_hp = 2 * Math.PI * f_hp / sampleRate;
    const cos_hp = Math.cos(w0_hp);
    const alpha_hp = Math.sin(w0_hp) / (2 * q_hp);
    const a0_hp = 1 + alpha_hp;
    const b0_hp = ((1 + cos_hp) / 2) / a0_hp;
    const b1_hp = (-(1 + cos_hp)) / a0_hp;
    const b2_hp = ((1 + cos_hp) / 2) / a0_hp;
    const a1_hp = (-2 * cos_hp) / a0_hp;
    const a2_hp = (1 - alpha_hp) / a0_hp;

    const f_lp = 10500, q_lp = 0.7071;
    const w0_lp = 2 * Math.PI * f_lp / sampleRate;
    const cos_lp = Math.cos(w0_lp);
    const alpha_lp = Math.sin(w0_lp) / (2 * q_lp);
    const a0_lp = 1 + alpha_lp;
    const b0_lp = ((1 - cos_lp) / 2) / a0_lp;
    const b1_lp = (1 - cos_lp) / a0_lp;
    const b2_lp = ((1 - cos_lp) / 2) / a0_lp;
    const a1_lp = (-2 * cos_lp) / a0_lp;
    const a2_lp = (1 - alpha_lp) / a0_lp;

    function filterBiquads(src, dst) {
      let x1_h = 0, x2_h = 0, y1_h = 0, y2_h = 0;
      let x1_l = 0, x2_l = 0, y1_l = 0, y2_l = 0;
      for (let i = 0; i < len; i++) {
        const s = src[i];
        const hp = b0_hp * s + b1_hp * x1_h + b2_hp * x2_h - a1_hp * y1_h - a2_hp * y2_h;
        x2_h = x1_h; x1_h = s; y2_h = y1_h; y1_h = hp;
        const lp = b0_lp * hp + b1_lp * x1_l + b2_lp * x2_l - a1_lp * y1_l - a2_lp * y2_l;
        x2_l = x1_l; x1_l = hp; y2_l = y1_l; y2_l = lp;
        dst[i] = lp;
      }
    }
    filterBiquads(cleanL, outL);
    filterBiquads(cleanR, outR);

    let sumSq = 0;
    const sampleLimit = Math.min(len, sampleRate);
    for (let i = 0; i < sampleLimit; i++) {
      const m = Math.max(Math.abs(outL[i]), Math.abs(outR[i]));
      sumSq += m * m;
    }
    const estRms = sampleLimit > 0 ? Math.sqrt(sumSq / sampleLimit) : 0;
    const gateThreshold = Math.max(0.003, estRms * 1.4);

    let currentGain = 1.0;
    const attackCoeff = Math.exp(-1 / (0.002 * sampleRate));
    const releaseCoeff = Math.exp(-1 / (0.080 * sampleRate));
    let maxAmp = 0;

    for (let i = 0; i < len; i++) {
      const linkedAbs = Math.max(Math.abs(outL[i]), Math.abs(outR[i]));
      const targetGain = linkedAbs > gateThreshold ? 1.0 : 0.20;
      if (targetGain > currentGain) {
        currentGain = attackCoeff * currentGain + (1 - attackCoeff) * targetGain;
      } else {
        currentGain = releaseCoeff * currentGain + (1 - releaseCoeff) * targetGain;
      }
      outL[i] *= currentGain;
      outR[i] *= currentGain;
      const postMax = Math.max(Math.abs(outL[i]), Math.abs(outR[i]));
      if (postMax > maxAmp) maxAmp = postMax;
    }

    if (maxAmp >= 0.003 && maxAmp < targetPeak) {
      const gain = Math.min(25.0, targetPeak / maxAmp);
      for (let i = 0; i < len; i++) {
        outL[i] = Math.max(-1.0, Math.min(1.0, outL[i] * gain));
        outR[i] = Math.max(-1.0, Math.min(1.0, outR[i] * gain));
      }
    } else if (maxAmp > 0.98) {
      const gain = 0.95 / maxAmp;
      for (let i = 0; i < len; i++) {
        outL[i] *= gain;
        outR[i] *= gain;
      }
    }

    return { left: outL, right: outR };
  }

  function buildRecordedTakeAudioBuffer(ctx, pcmL, pcmR, isStereoTake, sampleRate) {
    const minSamples = Math.round(sampleRate * 0.1);
    let finalL = (!pcmL || pcmL.length < minSamples) ? new Float32Array(Math.round(sampleRate * 1.0)) : pcmL;
    let finalR = null;
    if (isStereoTake) {
      if (!pcmR || pcmR.length < minSamples) {
        finalR = new Float32Array(finalL.length);
      } else if (pcmR.length !== finalL.length) {
        const commonLen = Math.min(finalL.length, pcmR.length);
        finalL = finalL.subarray(0, commonLen);
        finalR = pcmR.subarray(0, commonLen);
      } else {
        finalR = pcmR;
      }
    }
    const rampSamples = Math.min(finalL.length, Math.round(sampleRate * 0.005));
    for (let i = 0; i < rampSamples; i++) {
      const g = 0.5 * (1 - Math.cos(Math.PI * (i / rampSamples)));
      finalL[i] *= g;
      if (finalR) finalR[i] *= g;
    }
    const channels = (isStereoTake && finalR) ? 2 : 1;
    const buf = ctx.createBuffer(channels, finalL.length, sampleRate);
    buf.getChannelData(0).set(finalL);
    if (channels === 2 && finalR) {
      buf.getChannelData(1).set(finalR);
    }
    return buf;
  }

  let workletInitPromise = null;
  let workletInitCtx = null;

  async function ensureRecorderWorklet(ctx) {
    if (!ctx || !ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') {
      recDiag('REC_WORKLET_UNSUPPORTED', { ctx: inspectAudioCtx(ctx) }, {
        level: 'warn',
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_WORKLET_LOAD : undefined,
        extraData: 0
      });
      return false;
    }
    if (workletInitPromise && workletInitCtx === ctx) return await workletInitPromise;

    workletInitCtx = ctx;
    workletInitPromise = (async () => {
      const t0 = performance.now();
      recDiag('REC_WORKLET_ADDMODULE_START', { url: 'js/recorder-worklet.js?v=79', ctx: inspectAudioCtx(ctx) }, {
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_WORKLET_LOAD : undefined,
        phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.START : 0,
        forcePersist: true
      });
      try {
        await ctx.audioWorklet.addModule('js/recorder-worklet.js?v=79');
        const dur = Number((performance.now() - t0).toFixed(2));
        console.log('[Recorder] AudioWorklet registered from js/recorder-worklet.js?v=79');
        recDiag('REC_WORKLET_ADDMODULE_OK', { source: 'external_file', durationMs: dur, ctxState: ctx.state }, {
          stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_WORKLET_LOAD : undefined,
          phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.END : 1,
          duration: dur,
          extraData: 1
        });
        return true;
      } catch (err1) {
        console.warn('[Recorder] External worklet file load failed, attempting Blob URL:', err1);
        recDiag('REC_WORKLET_EXTERNAL_FAILED', {
          error: err1 && err1.message ? err1.message : String(err1)
        }, { level: 'warn', forcePersist: true });
        try {
          const inlineWorkletCode = `
            class NanodawRecorderProcessor extends AudioWorkletProcessor {
              constructor() {
                super();
                this.chunkSize = 4096;
                this.bufferPool = [];
                this.bufferPoolR = [];
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
                this.channelMode = 'mono';
                this.selectedChannel = 0;
                this.stereoLeftChannel = 0;
                this.stereoRightChannel = 1;
                this.detectTransients = false;
                this.transientThreshold = 0.0631;
                this.onsetRatio = 1.65;
                this.lastTransientSample = -999999;
                this.ambientFloor = 0.003;
                this.maxTrackedChannels = 16;
                this.channelEnvs = new Float32Array(this.maxTrackedChannels);
                this.channelPeaks = new Float32Array(this.maxTrackedChannels);
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
                    if (data.buffer && data.buffer.byteLength === this.chunkSize * 4 && this.bufferPool.length < 16) {
                      this.bufferPool.push(new Float32Array(data.buffer));
                    }
                    if (data.bufferR && data.bufferR.byteLength === this.chunkSize * 4 && this.bufferPoolR.length < 16) {
                      this.bufferPoolR.push(new Float32Array(data.bufferR));
                    }
                  } else if (data.type === 'set_config') {
                    if (typeof data.channelMode === 'string' && (data.channelMode === 'mono' || data.channelMode === 'stereo' || data.channelMode === 'auto')) {
                      if (data.channelMode !== this.channelMode && this.writeIndex > 0) this.flushPartial();
                      this.channelMode = data.channelMode;
                    }
                    if (typeof data.selectedChannel === 'number' && data.selectedChannel >= 0) this.selectedChannel = data.selectedChannel | 0;
                    if (typeof data.stereoLeftChannel === 'number' && data.stereoLeftChannel >= 0) this.stereoLeftChannel = data.stereoLeftChannel | 0;
                    if (typeof data.stereoRightChannel === 'number' && data.stereoRightChannel >= 0) this.stereoRightChannel = data.stereoRightChannel | 0;
                    if (typeof data.detectTransients === 'boolean') this.detectTransients = data.detectTransients;
                    if (typeof data.transientThreshold === 'number' && data.transientThreshold > 0) this.transientThreshold = data.transientThreshold;
                    if (typeof data.onsetRatio === 'number' && data.onsetRatio > 1.0) this.onsetRatio = data.onsetRatio;
                    if (typeof data.isRecording === 'boolean') this.isRecording = data.isRecording;
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
                    for (let c = 0; c < reportedCh; c++) peaksSnap.push(this.channelPeaks[c]);
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

              process(inputs) {
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

                const len = ch0.length;
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
                    if (this.monoScratch.length < len) this.monoScratch = new Float32Array(len);
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
                  if (trackedCh > 1) {
                    let bestIdx = 0;
                    let secondIdx = 1;
                    if (this.channelEnvs[1] > this.channelEnvs[0]) { bestIdx = 1; secondIdx = 0; }
                    for (let c = 2; c < trackedCh; c++) {
                      const envC = this.channelEnvs[c];
                      if (envC > this.channelEnvs[bestIdx]) { secondIdx = bestIdx; bestIdx = c; }
                      else if (envC > this.channelEnvs[secondIdx]) { secondIdx = c; }
                    }
                    const bestEnv = this.channelEnvs[bestIdx];
                    const secondEnv = this.channelEnvs[secondIdx];
                    const chBest = (in0[bestIdx] && in0[bestIdx].length === len) ? in0[bestIdx] : ch0;
                    const chSec = (in0[secondIdx] && in0[secondIdx].length === len) ? in0[secondIdx] : ch0;
                    if (bestEnv > secondEnv * 2.4 && bestEnv > 0.0008) {
                      srcL = chBest;
                    } else {
                      if (this.monoScratch.length < len) this.monoScratch = new Float32Array(len);
                      for (let i = 0; i < len; i++) this.monoScratch[i] = 0.5 * (chBest[i] + chSec[i]);
                      srcL = this.monoScratch;
                    }
                  }
                  detectSrc = srcL;
                }

                if (this.detectTransients) {
                  let peak = 0;
                  let peakOffset = 0;
                  let maxDiff = 0;
                  let sumSq = 0;
                  for (let i = 0; i < len; i++) {
                    const val = detectSrc[i];
                    const absVal = Math.abs(val);
                    if (absVal > peak) { peak = absVal; peakOffset = i; }
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
                      this.port.postMessage({ type: 'transient', samplePos: eventSamplePos, peak: peak });
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
          `;
          const blob = new Blob([inlineWorkletCode], { type: 'application/javascript' });
          const blobUrl = URL.createObjectURL(blob);
          await ctx.audioWorklet.addModule(blobUrl);
          URL.revokeObjectURL(blobUrl);
          const dur = Number((performance.now() - t0).toFixed(2));
          console.log('[Recorder] AudioWorklet registered from inline Blob URL');
          recDiag('REC_WORKLET_ADDMODULE_OK', { source: 'inline_blob', durationMs: dur, ctxState: ctx.state }, {
            stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_WORKLET_LOAD : undefined,
            phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.END : 1,
            duration: dur,
            extraData: 2
          });
          return true;
        } catch (err2) {
          const dur = Number((performance.now() - t0).toFixed(2));
          console.warn('[Recorder] AudioWorklet unavailable, falling back to ScriptProcessor:', err2);
          recDiag('REC_WORKLET_FALLBACK_SCRIPTPROCESSOR', {
            durationMs: dur,
            error: err2 && err2.message ? err2.message : String(err2)
          }, {
            level: 'warn',
            stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_WORKLET_LOAD : undefined,
            phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.END : 1,
            duration: dur,
            extraData: 3,
            forcePersist: true
          });
          return false;
        }
      }
    })();

    return await workletInitPromise;
  }

  let activeTargetStore = pass2AudioStore;
  let activeTargetStoreR = pass2AudioStoreR;
  let activeTransientCallback = null;

  async function attachRecordingPipeline({ detectTransients = false, targetStore = pass2AudioStore, targetStoreR = pass2AudioStoreR, onTransient = null }) {
    activeTargetStore = targetStore;
    activeTargetStoreR = targetStoreR;
    activeTransientCallback = onTransient;
    recPipelineAttachPerfMs = performance.now();
    recFirstChunkLogged = false;
    const chCfg = activeRecordingChannelConfig || { mode: 'mono', ch: 0, left: 0, right: 1, neededChannels: 1 };

    recDiag('REC_PIPELINE_ATTACH_START', {
      recordingState,
      detectTransients: Boolean(detectTransients),
      channelConfig: chCfg,
      hadMicSource: Boolean(recMicSource),
      hadWorkletNode: Boolean(recWorkletNode),
      ctx: inspectAudioCtx(recAudioCtx),
      stream: inspectMediaStream(recStream)
    }, {
      stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_PIPELINE_ATTACH : undefined,
      phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.START : 0,
      forcePersist: true
    });

    if (!recMicSource && recStream && recAudioCtx) {
      recMicSource = recAudioCtx.createMediaStreamSource(recStream);
      try {
        recMicSource.channelInterpretation = 'discrete';
      } catch (_) {}
      recDiag('REC_MEDIA_STREAM_SOURCE_CREATED', {
        channelCount: recMicSource.channelCount,
        channelCountMode: recMicSource.channelCountMode,
        channelInterpretation: recMicSource.channelInterpretation,
        numberOfOutputs: recMicSource.numberOfOutputs
      });
    }
    if (!recSilentGain && recAudioCtx) {
      recSilentGain = recAudioCtx.createGain();
      recSilentGain.gain.value = 0.00001; // Avoid Chromium silent node pruning
    }

    const workletOk = await ensureRecorderWorklet(recAudioCtx);
    if (workletOk) {
      if (!recWorkletNode) {
        try {
          recWorkletNode = new AudioWorkletNode(recAudioCtx, 'nanodaw-recorder-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCountMode: 'max',
            channelInterpretation: 'discrete'
          });
        } catch (_) {
          recWorkletNode = new AudioWorkletNode(recAudioCtx, 'nanodaw-recorder-processor');
        }
        try {
          recWorkletNode.channelCountMode = 'max';
          recWorkletNode.channelInterpretation = 'discrete';
        } catch (_) {}

        recWorkletNode.onprocessorerror = (errEvt) => {
          recDiag('REC_WORKLET_PROCESSOR_ERROR', {
            message: errEvt && errEvt.message ? errEvt.message : String(errEvt),
            recordingState,
            ctx: inspectAudioCtx(recAudioCtx)
          }, {
            level: 'error',
            stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_ERROR : undefined,
            forcePersist: true
          });
        };
        recMicSource.connect(recWorkletNode);
        recWorkletNode.connect(recSilentGain);
        recSilentGain.connect(recAudioCtx.destination);
        window.__nanodaw_worklet = recWorkletNode;

        recWorkletNode.port.onmessage = (e) => {
          const data = e.data;
          if (!data) return;

          if (data.type === 'worklet_first_process') {
            if (typeof data.workletCurrentTime === 'number' && data.workletCurrentTime > 0) {
              pass2StreamStartTime = data.workletCurrentTime;
              if (activeSyncSession && activeSyncSession.mode === 'synth') {
                activeSyncSession.streamStartTime = data.workletCurrentTime;
                for (let k = 0; k < activeSyncSession.numBeats; k++) {
                  activeSyncSession.expSyncBufferSec[k] = Math.max(
                    0,
                    (activeSyncSession.beat1CtxTime - data.workletCurrentTime) + ((activeSyncSession.firstBeat - 1) + k) * activeSyncSession.dt
                  );
                }
              }
            }
            recDiag('REC_WORKLET_FIRST_PROCESS', {
              recordingState,
              sinceAttachMs: Number((performance.now() - recPipelineAttachPerfMs).toFixed(2)),
              inputCount: data.inputCount,
              channelCount: data.channelCount,
              channelMode: data.channelMode,
              selectedChannel: data.selectedChannel,
              stereoPair: data.stereoPair,
              frameLen: data.frameLen,
              workletSampleRate: data.workletSampleRate,
              workletCurrentTime: Number((data.workletCurrentTime || 0).toFixed(4))
            }, { forcePersist: true });
          } else if (data.type === 'worklet_diag') {
            lastWorkletDiagReport = {
              processCalls: data.processCalls,
              emptyInputCalls: data.emptyInputCalls,
              inputChannels: data.inputChannels,
              channelMode: data.channelMode,
              selectedChannel: data.selectedChannel,
              stereoPair: data.stereoPair,
              chunksPosted: data.chunksPosted,
              poolLen: data.poolLen,
              poolRLen: data.poolRLen,
              poolMisses: data.poolMisses,
              totalSamples: data.totalSamples,
              ch0Peak: Number((data.ch0Peak || 0).toFixed(5)),
              ch1Peak: Number((data.ch1Peak || 0).toFixed(5)),
              channelPeaks: Array.isArray(data.channelPeaks) ? data.channelPeaks.map(v => Number((v || 0).toFixed(5))) : undefined,
              transientThreshold: data.transientThreshold ? Number(data.transientThreshold.toFixed(5)) : undefined,
              workletSampleRate: data.workletSampleRate,
              workletCurrentTime: Number((data.workletCurrentTime || 0).toFixed(4))
            };
          } else if (data.type === 'transient') {
            if (activeTransientCallback) {
              const now = recAudioCtx ? recAudioCtx.currentTime : (performance.now() / 1000);
              activeTransientCallback(now, data.samplePos);
            }
          } else if (data.type === 'audio_chunk') {
            const chunk = data.buffer;
            const chunkR = data.bufferR || null;
            const len = data.length || chunk.length;
            recChunksReceivedTotal++;

            if (!recFirstChunkLogged) {
              recFirstChunkLogged = true;
              const sinceAttachMs = Number((performance.now() - recPipelineAttachPerfMs).toFixed(2));
              let firstPeak = 0;
              for (let i = 0; i < len; i += 8) {
                const a = Math.abs(chunk[i]);
                if (a > firstPeak) firstPeak = a;
                if (chunkR) {
                  const aR = Math.abs(chunkR[i]);
                  if (aR > firstPeak) firstPeak = aR;
                }
              }
              recDiag('REC_WORKLET_FIRST_CHUNK', {
                recordingState,
                sinceAttachMs,
                chunkLen: len,
                channels: data.channels || 1,
                sampleOffset: data.sampleOffset,
                firstPeak: Number(firstPeak.toFixed(5)),
                ctxTime: recAudioCtx ? Number(recAudioCtx.currentTime.toFixed(4)) : null
              }, {
                stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_WORKLET_FIRST_CHUNK : undefined,
                duration: sinceAttachMs,
                extraData: len,
                forcePersist: true
              });
            }

            if (pass2StreamStartTime === null && recAudioCtx) {
              pass2StreamStartTime = recAudioCtx.currentTime;
            }
            totalPass2Samples += len;

            if (activeTargetStore) {
              activeTargetStore.append(chunk, len);
            }
            if (chunkR && activeTargetStoreR) {
              activeTargetStoreR.append(chunkR, len);
            }

            // Zero-allocation: recycle the transferred buffer(s) back to worklet's standby pool
            try {
              if (chunkR) {
                recWorkletNode.port.postMessage(
                  { type: 'recycle_buffer', buffer: chunk, bufferR: chunkR },
                  [chunk.buffer, chunkR.buffer]
                );
              } else {
                recWorkletNode.port.postMessage(
                  { type: 'recycle_buffer', buffer: chunk },
                  [chunk.buffer]
                );
              }
            } catch (_) {}
          }
        };
      }

      recWorkletNode.port.postMessage({
        type: 'set_config',
        isRecording: true,
        channelMode: chCfg.mode,
        selectedChannel: chCfg.ch,
        stereoLeftChannel: chCfg.left,
        stereoRightChannel: chCfg.right,
        detectTransients: !!detectTransients,
        transientThreshold: getPeakThresholdLinear(),
        onsetRatio: getPeakOnsetRatio(),
        resetSampleCounter: true
      });

      const attachDur = Number((performance.now() - recPipelineAttachPerfMs).toFixed(2));
      recDiag('REC_PIPELINE_ATTACH_COMPLETE', {
        mode: 'AudioWorkletNode',
        recordingState,
        durationMs: attachDur,
        channelConfig: chCfg,
        workletChannelCount: recWorkletNode.channelCount,
        workletChannelCountMode: recWorkletNode.channelCountMode,
        workletChannelInterpretation: recWorkletNode.channelInterpretation,
        workletNumberOfInputs: recWorkletNode.numberOfInputs,
        transientThresholdDb: peakSensDb,
        ctxState: recAudioCtx ? recAudioCtx.state : null
      }, {
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_PIPELINE_ATTACH : undefined,
        phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.END : 1,
        duration: attachDur,
        extraData: 1,
        forcePersist: true
      });

    } else {
      // Robust fallback to 4096-sample discrete ScriptProcessorNode
      if (!recScriptProcessor) {
        const streamTracks = recStream && recStream.getAudioTracks ? recStream.getAudioTracks() : [];
        const trkCh = (streamTracks[0] && typeof streamTracks[0].getSettings === 'function')
          ? (streamTracks[0].getSettings().channelCount || 0)
          : 0;
        const rawInCh = Math.max(trkCh, recMicSource ? (recMicSource.channelCount || 2) : 2, chCfg.neededChannels || 1);
        // ScriptProcessorNode requires power-of-2 or valid channel counts (1, 2, 4, 6, 8)
        const spInCh = rawInCh > 4 ? 8 : (rawInCh > 2 ? 4 : Math.max(1, Math.min(2, rawInCh)));
        recScriptProcessor = recAudioCtx.createScriptProcessor(4096, spInCh, 1);
        try { recScriptProcessor.channelInterpretation = 'discrete'; } catch (_) {}
        recMicSource.connect(recScriptProcessor);
        recScriptProcessor.connect(recSilentGain);
        recSilentGain.connect(recAudioCtx.destination);
        window.__nanodaw_processor = recScriptProcessor;
      }

      const spEnvs = new Float32Array(16);
      let spLastTransientMs = 0;

      recScriptProcessor.onaudioprocess = (e) => {
        const numCh = e.inputBuffer.numberOfChannels;
        const ch0 = e.inputBuffer.getChannelData(0);
        const len = ch0.length;
        for (let c = 0; c < Math.min(16, numCh); c++) {
          const arr = e.inputBuffer.getChannelData(c);
          let env = spEnvs[c];
          for (let i = 0; i < len; i++) {
            const a = Math.abs(arr[i]);
            env = a > env ? a : env * 0.9992;
          }
          spEnvs[c] = env;
        }

        let inputL = ch0;
        let inputR = null;
        let detectArr = ch0;

        if (chCfg.mode === 'stereo') {
          const idxL = Math.min(chCfg.left, numCh - 1);
          const idxR = Math.min(chCfg.right, numCh - 1);
          inputL = e.inputBuffer.getChannelData(idxL);
          inputR = e.inputBuffer.getChannelData(idxR);
          const comp = new Float32Array(len);
          for (let i = 0; i < len; i++) {
            comp[i] = Math.abs(inputL[i]) >= Math.abs(inputR[i]) ? inputL[i] : inputR[i];
          }
          detectArr = comp;
        } else if (chCfg.mode === 'mono') {
          const idxM = Math.min(chCfg.ch, numCh - 1);
          inputL = e.inputBuffer.getChannelData(idxM);
          detectArr = inputL;
        } else if (numCh > 1) {
          let best = 0, sec = 1;
          if (spEnvs[1] > spEnvs[0]) { best = 1; sec = 0; }
          for (let c = 2; c < Math.min(16, numCh); c++) {
            if (spEnvs[c] > spEnvs[best]) { sec = best; best = c; }
            else if (spEnvs[c] > spEnvs[sec]) { sec = c; }
          }
          if (spEnvs[best] > spEnvs[sec] * 2.4 && spEnvs[best] > 0.0008) {
            inputL = e.inputBuffer.getChannelData(best);
          } else {
            const cA = e.inputBuffer.getChannelData(best);
            const cB = e.inputBuffer.getChannelData(sec);
            const mixed = new Float32Array(len);
            for (let i = 0; i < len; i++) mixed[i] = 0.5 * (cA[i] + cB[i]);
            inputL = mixed;
          }
          detectArr = inputL;
        }

        recChunksReceivedTotal++;

        if (!recFirstChunkLogged) {
          recFirstChunkLogged = true;
          const sinceAttachMs = Number((performance.now() - recPipelineAttachPerfMs).toFixed(2));
          recDiag('REC_SCRIPTPROC_FIRST_CHUNK', {
            recordingState,
            sinceAttachMs,
            chunkLen: len,
            inputChannels: numCh,
            channelConfig: chCfg,
            sampleRate: e.inputBuffer.sampleRate
          }, {
            stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_WORKLET_FIRST_CHUNK : undefined,
            duration: sinceAttachMs,
            extraData: len,
            forcePersist: true
          });
        }

        const prevSamples = totalPass2Samples;
        if (pass2StreamStartTime === null && recAudioCtx) {
          pass2StreamStartTime = recAudioCtx.currentTime;
        }
        totalPass2Samples += len;

        if (activeTargetStore) {
          activeTargetStore.append(inputL, len);
        }
        if (inputR && activeTargetStoreR) {
          activeTargetStoreR.append(inputR, len);
        }

        if (detectTransients && activeTransientCallback) {
          let peak = 0;
          let peakOff = 0;
          for (let i = 0; i < len; i++) {
            const a = Math.abs(detectArr[i]);
            if (a > peak) { peak = a; peakOff = i; }
          }
          const thresh = getPeakThresholdLinear();
          const nowMs = performance.now();
          if (peak >= thresh && nowMs - spLastTransientMs > 135) {
            spLastTransientMs = nowMs;
            const now = recAudioCtx ? recAudioCtx.currentTime : (nowMs / 1000);
            activeTransientCallback(now, prevSamples + peakOff);
          }
        }
      };

      const attachDur = Number((performance.now() - recPipelineAttachPerfMs).toFixed(2));
      recDiag('REC_PIPELINE_ATTACH_COMPLETE', {
        mode: 'ScriptProcessorNode',
        recordingState,
        channelConfig: chCfg,
        durationMs: attachDur,
        ctxState: recAudioCtx ? recAudioCtx.state : null
      }, {
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_PIPELINE_ATTACH : undefined,
        phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.END : 1,
        duration: attachDur,
        extraData: 2,
        forcePersist: true
      });
    }
  }

  // Unified Just-In-Time Live Metronome (handles both early pre-take/sync beats and optional during-take metronome)
  let liveMetronomeIntervalId = null;
  let liveMetronomeGainNode = null;
  let liveMetronomeScheduledOscs = [];

  function parseDbToLinear(dbStr, defaultDb = 0) {
    if (!dbStr) return 1.0;
    const cleaned = String(dbStr).replace(/db/i, '').trim();
    const num = parseFloat(cleaned);
    const val = isNaN(num) ? defaultDb : num;
    const clamped = Math.max(-48, Math.min(6, val));
    return Math.pow(10, clamped / 20);
  }

  function startLiveMetronome(startTime, tempo, linearVolume = 1.0, options = {}) {
    stopLiveMetronome();
    if (!recAudioCtx || recAudioCtx.state === 'closed') return;
    const dt = 60 / tempo;
    const preTakeBeats = Math.max(0, options.preTakeBeats | 0);
    const firstSyncBeatIdx = typeof options.firstSyncBeatIdx === 'number' ? options.firstSyncBeatIdx : -1;
    const takeEnabled = options.takeEnabled !== undefined ? Boolean(options.takeEnabled) : true;

    if (takeEnabled) {
      try {
        liveMetronomeGainNode = recAudioCtx.createGain();
        liveMetronomeGainNode.gain.setValueAtTime(linearVolume, recAudioCtx.currentTime);
        liveMetronomeGainNode.connect(recAudioCtx.destination);
      } catch (e) {
        console.warn('Metronome gain error:', e);
        return;
      }
    }

    let nextBeatTime = startTime;
    const scheduleAheadSec = 0.28;
    let beatIndex = 0;

    function scheduleBeats() {
      if (!isRecording || (recordingState !== 'sync_preroll' && recordingState !== 'pass2_prelude' && recordingState !== 'recording_take')) {
        stopLiveMetronome();
        return;
      }
      const now = recAudioCtx ? recAudioCtx.currentTime : 0;
      while (nextBeatTime < now - 0.1) {
        nextBeatTime += dt;
        beatIndex++;
      }
      while (nextBeatTime < now + scheduleAheadSec) {
        if (beatIndex < preTakeBeats) {
          // Early beats (count-in + sync beats up to F + N - 1) ALWAYS play the just-in-time metronome
          let freq = (beatIndex % 4 === 0) ? 1600 : 1050;
          let dur = 0.055;
          if (beatIndex === preTakeBeats - 1) {
            freq = 1850; // Crisp cue on final sync beat immediately preceding take downbeat (F + N)
            dur = 0.068;
          } else if (firstSyncBeatIdx >= 0 && beatIndex === firstSyncBeatIdx) {
            freq = 1500; // Clear cue on first sync beat (F)
            dur = 0.060;
          }
          const osc = playSynthBeep(nextBeatTime, freq, dur, null, 0.80);
          if (osc) liveMetronomeScheduledOscs.push(osc);
        } else if (takeEnabled && liveMetronomeGainNode) {
          // Take beats (from beat F + N onwards): accent every 4 beats starting on the F + N downbeat
          const takeBeatIdx = beatIndex - preTakeBeats;
          const freq = (takeBeatIdx % 4 === 0) ? 1600 : 1100;
          const osc = playSynthBeep(nextBeatTime, freq, 0.045, liveMetronomeGainNode, 0.80);
          if (osc) liveMetronomeScheduledOscs.push(osc);
        } else {
          // Metronome OFF during take: all early sync beats have been scheduled, stop polling without cutting off scheduled clicks
          if (liveMetronomeIntervalId) {
            clearInterval(liveMetronomeIntervalId);
            liveMetronomeIntervalId = null;
          }
          return;
        }
        nextBeatTime += dt;
        beatIndex++;
      }
    }

    scheduleBeats();
    if (preTakeBeats > 0 || takeEnabled) {
      liveMetronomeIntervalId = setInterval(scheduleBeats, 35);
    }
  }

  function stopLiveMetronome() {
    if (liveMetronomeIntervalId) {
      clearInterval(liveMetronomeIntervalId);
      liveMetronomeIntervalId = null;
    }
    if (liveMetronomeScheduledOscs.length > 0) {
      for (const osc of liveMetronomeScheduledOscs) {
        try { osc.stop(0); } catch (_) {}
        try { osc.disconnect(); } catch (_) {}
      }
      liveMetronomeScheduledOscs = [];
    }
    if (liveMetronomeGainNode) {
      try { liveMetronomeGainNode.disconnect(); } catch (_) {}
      liveMetronomeGainNode = null;
    }
  }

  function updateRecordModalToggles() {
    const isNanodawSync = record2PassSync ? record2PassSync.checked : true;
    if (container2PassSync) container2PassSync.style.display = isNanodawSync ? 'flex' : 'none';
    if (containerSinglePass) containerSinglePass.style.display = isNanodawSync ? 'none' : 'flex';

    if (isNanodawSync) {
      const isSynth = guideModeSynth ? guideModeSynth.checked : false;
      if (guideSynthSubOptions) guideSynthSubOptions.style.display = isSynth ? 'flex' : 'none';
      if (guideTrackSubOptions) guideTrackSubOptions.style.display = isSynth ? 'none' : 'flex';
      const takeMetroOn = syncMetronomeOn ? syncMetronomeOn.checked : true;
      if (syncMetronomeVolume) syncMetronomeVolume.disabled = !takeMetroOn;
      const volWrap = document.getElementById('syncMetronomeVolWrap');
      if (volWrap) volWrap.style.opacity = takeMetroOn ? '1' : '0.45';
    } else {
      const isSingleMetro = singleMetronomeOn ? singleMetronomeOn.checked : false;
      if (singleMetronomeSubOptions) singleMetronomeSubOptions.style.display = isSingleMetro ? 'flex' : 'none';
    }
    if (typeof refreshPeakTriangleShades === 'function') {
      refreshPeakTriangleShades();
    }
    if (typeof updatePeakSensitivityUI === 'function') {
      updatePeakSensitivityUI();
    }
  }

  function switchRecordModalTab(tab) {
    activeRecordModalTab = tab;
    if (tab === 'metronome') {
      if (tabBtnRecord) {
        tabBtnRecord.style.background = 'transparent';
        tabBtnRecord.style.color = 'var(--text-secondary)';
      }
      if (tabBtnMetronome) {
        tabBtnMetronome.style.background = '#38bdf8';
        tabBtnMetronome.style.color = '#0f172a';
      }
      if (tabContentRecord) tabContentRecord.style.display = 'none';
      if (tabContentMetronome) tabContentMetronome.style.display = 'flex';
      if (recordModalHeaderTitle) {
        recordModalHeaderTitle.innerHTML = '<span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:#38bdf8; box-shadow:0 0 8px #38bdf8;"></span> Metronome Track Generator';
      }
      if (metroTrackName) metroTrackName.value = getNextAvailableMetronomeName();
      if (metroTempo) metroTempo.value = state.project?.tempo || syncSynthTempo?.value || 90;
    } else {
      if (tabBtnRecord) {
        tabBtnRecord.style.background = '#ef4444';
        tabBtnRecord.style.color = '#fff';
      }
      if (tabBtnMetronome) {
        tabBtnMetronome.style.background = 'transparent';
        tabBtnMetronome.style.color = 'var(--text-secondary)';
      }
      if (tabContentRecord) tabContentRecord.style.display = 'flex';
      if (tabContentMetronome) tabContentMetronome.style.display = 'none';
      if (recordModalHeaderTitle) {
        recordModalHeaderTitle.innerHTML = '<span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:#ef4444; box-shadow:0 0 8px #ef4444;"></span> Record / Metronome Setup';
      }
      updateRecordModalToggles();
    }
  }

  function getNextAvailableMetronomeName() {
    const existingTracks = audio.tracks || [];
    const usedNumbers = new Set();
    const pattern = /^metronome\s*(\d+)$/i;
    for (const t of existingTracks) {
      const match = (t.name || '').trim().match(pattern);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > 0) usedNumbers.add(num);
      }
    }
    let n = 1;
    while (usedNumbers.has(n)) {
      n++;
    }
    return `Metronome ${n}`;
  }

  function parseDurationToSeconds(str) {
    if (!str) return 180;
    const s = String(str).trim();
    if (s.includes(':')) {
      const parts = s.split(':');
      const mins = parseInt(parts[0], 10) || 0;
      const secs = parseFloat(parts[1]) || 0;
      const total = mins * 60 + secs;
      return total > 0 ? total : 180;
    }
    const val = parseFloat(s);
    return (!isNaN(val) && val > 0) ? val : 180;
  }

  function generateMetronomeAudioBuffer(tempo, beatsPerMeasure, totalSeconds) {
    const tBpm = Math.max(30, Math.min(300, parseInt(tempo, 10) || 90));
    const bPerMeas = Math.max(1, Math.min(32, parseInt(beatsPerMeasure, 10) || 4));
    const durSec = Math.max(1, Math.min(3600, parseFloat(totalSeconds) || 180));
    const ctx = audio.getOrCreateAudioContext() || new (window.AudioContext || window.webkitAudioContext)();
    const sampleRate = ctx.sampleRate || 44100;
    const totalFrames = Math.ceil(durSec * sampleRate);
    const buffer = ctx.createBuffer(1, totalFrames, sampleRate);
    const pcm = buffer.getChannelData(0);

    const dt = 60 / tBpm;
    const numBeats = Math.floor(durSec / dt);

    for (let i = 0; i < numBeats; i++) {
      const isAccent = (i % bPerMeas === 0);
      const freq = isAccent ? 2200 : 1100;
      const amp = isAccent ? 0.85 : 0.60;
      const decayCoeff = isAccent ? 0.008 : 0.005;
      const s0 = Math.round(i * dt * sampleRate);
      const clickSamples = Math.min(totalFrames - s0, Math.round(0.040 * sampleRate));

      for (let s = 0; s < clickSamples; s++) {
        const timeSec = s / sampleRate;
        const env = Math.exp(-timeSec / decayCoeff);
        const phase = (timeSec * freq) % 1;
        const tri = 2 * Math.abs(2 * (phase - Math.floor(phase + 0.5))) - 1;
        const sampleVal = pcm[s0 + s] + tri * env * amp;
        pcm[s0 + s] = Math.max(-1.0, Math.min(1.0, sampleVal));
      }
    }
    return buffer;
  }

  function populateSyncGuideTracks() {
    if (!syncGuideTrackSelect) return;
    syncGuideTrackSelect.innerHTML = '<option value="">None</option>';

    const metroTracks = [];
    const otherTracks = [];

    audio.tracks.forEach((track, idx) => {
      const isMetro = /^metronome/i.test((track.name || '').trim());
      if (isMetro) {
        metroTracks.push({ track, idx });
      } else {
        otherTracks.push({ track, idx });
      }
    });

    // Metronome* tracks are prioritized at the top of the dropdown
    metroTracks.forEach(({ track, idx }) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      const trkTempo = track.tempo || state.project?.tracks?.[idx]?.tempo;
      const bpmLabel = trkTempo ? ` (${trkTempo} BPM)` : '';
      opt.textContent = `⏱️ Track ${idx + 1}: ${track.name || 'Metronome'}${bpmLabel}`;
      syncGuideTrackSelect.appendChild(opt);
    });

    // Followed by standard project tracks
    otherTracks.forEach(({ track, idx }) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = `Track ${idx + 1}: ${track.name || 'Track'}`;
      syncGuideTrackSelect.appendChild(opt);
    });

    // Auto-select first Metronome* track if present; otherwise first available track; otherwise "None"
    if (metroTracks.length > 0) {
      syncGuideTrackSelect.value = String(metroTracks[0].idx);
      const firstMetro = metroTracks[0].track;
      const mTempo = firstMetro.tempo || state.project?.tracks?.[metroTracks[0].idx]?.tempo;
      if (mTempo) {
        if (syncSynthTempo) syncSynthTempo.value = mTempo;
        if (singleMetronomeTempo) singleMetronomeTempo.value = mTempo;
        if (metroTempo) metroTempo.value = mTempo;
      }
    } else if (otherTracks.length > 0) {
      syncGuideTrackSelect.value = String(otherTracks[0].idx);
    } else {
      syncGuideTrackSelect.value = '';
      // When project has zero tracks, automatically select Metronome Synth Beats since no guide track exists yet
      if (guideModeTrack && guideModeTrack.checked && guideModeSynth) {
        guideModeSynth.checked = true;
      }
    }

    // Initialize default tempo if project has tempo
    const defaultTempo = state.project?.tempo || 90;
    if (syncSynthTempo && (!syncSynthTempo.value || syncSynthTempo.value === '90')) {
      syncSynthTempo.value = defaultTempo;
    }
    if (singleMetronomeTempo && (!singleMetronomeTempo.value || singleMetronomeTempo.value === '90')) {
      singleMetronomeTempo.value = defaultTempo;
    }
    if (metroTempo && (!metroTempo.value || metroTempo.value === '90')) {
      metroTempo.value = defaultTempo;
    }
  }

  if (syncGuideTrackSelect) {
    syncGuideTrackSelect.addEventListener('change', () => {
      const gIdx = parseInt(syncGuideTrackSelect.value, 10);
      if (!isNaN(gIdx) && audio.tracks[gIdx]) {
        const trk = audio.tracks[gIdx];
        const trkTempo = trk.tempo || state.project?.tracks?.[gIdx]?.tempo;
        if (trkTempo) {
          if (syncSynthTempo) syncSynthTempo.value = trkTempo;
          if (singleMetronomeTempo) singleMetronomeTempo.value = trkTempo;
          if (metroTempo) metroTempo.value = trkTempo;
          if (state.project) {
            state.project.tempo = trkTempo;
            state.project.bpm = trkTempo;
          }
        }
      }
    });
  }

  if (record2PassSync) record2PassSync.addEventListener('change', updateRecordModalToggles);
  if (guideModeSynth) guideModeSynth.addEventListener('change', updateRecordModalToggles);
  if (guideModeTrack) guideModeTrack.addEventListener('change', updateRecordModalToggles);
  if (syncMetronomeOn) syncMetronomeOn.addEventListener('change', updateRecordModalToggles);
  if (singleMetronomeOn) singleMetronomeOn.addEventListener('change', updateRecordModalToggles);

  // Tab Switcher and Metronome Generation Listeners
  if (tabBtnRecord) {
    tabBtnRecord.addEventListener('click', () => {
      switchRecordModalTab('record');
      startVUMonitor();
    });
  }
  if (tabBtnMetronome) tabBtnMetronome.addEventListener('click', () => switchRecordModalTab('metronome'));

  if (btnCancelMetronome && recordSetupModal) {
    btnCancelMetronome.addEventListener('click', () => {
      stopVUMonitor();
      recordSetupModal.classList.add('hidden');
      recordSetupModal.style.display = 'none';
      audio.isRecordingMode = false;
      audio.setPlaybackAudioSession();
    });
  }

  if (btnGoMetronome) {
    btnGoMetronome.addEventListener('click', () => {
      const trackName = (metroTrackName?.value || '').trim() || getNextAvailableMetronomeName();
      const tempo = parseInt(metroTempo?.value, 10) || state.project?.tempo || state.project?.bpm || 90;
      const beatsPerMeasure = parseInt(metroBeatsPerMeasure?.value, 10) || 4;
      const durSec = parseDurationToSeconds(metroDuration?.value || '03:00');

      const metroBuffer = generateMetronomeAudioBuffer(tempo, beatsPerMeasure, durSec);

      // Insert at the TOP of the project (index 0) with full metronome metadata
      const trackData = audio.addRecordedTrack(trackName, metroBuffer, 0, '#38bdf8', 0, {
        isMetronome: true,
        tempo,
        beatsPerMeasure
      });
      if (trackData) {
        trackData.tempo = tempo;
        trackData.isMetronome = true;
        trackData.beatsPerMeasure = beatsPerMeasure;
      }

      // Synchronize tempo state everywhere so Record tab and Track Sync use the identical tempo!
      if (syncSynthTempo) syncSynthTempo.value = tempo;
      if (singleMetronomeTempo) singleMetronomeTempo.value = tempo;
      if (metroTempo) metroTempo.value = tempo;
      if (state.project) {
        state.project.tempo = tempo;
        state.project.bpm = tempo;
      }

      // Re-render project in the background
      timeline.render();
      timeline.renderWaveforms();
      timeline.updateInspectorPane();

      // Refresh Guide Track list, select the newly generated metronome track, and switch back to Audio Record tab (keeping modal open!)
      populateSyncGuideTracks();
      if (guideModeTrack) {
        guideModeTrack.checked = true;
      }
      if (syncGuideTrackSelect) {
        syncGuideTrackSelect.value = '0';
      }
      if (metroTrackName) {
        metroTrackName.value = getNextAvailableMetronomeName();
      }
      resetPreRecTapTest();
      switchRecordModalTab('record');
      startVUMonitor();

      const m = Math.floor(durSec / 60);
      const s = String(Math.floor(durSec % 60)).padStart(2, '0');
      showToast(`Created "${trackName}" (${tempo} BPM, ${m}:${s}) — ready to record!`, 'success', 4000);
    });
  }

  async function refreshAudioInputDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      recDiag('REC_ENUMERATE_UNSUPPORTED', {}, { level: 'warn' });
      return;
    }
    const enumStart = performance.now();
    try {
      // Ensure iOS audioSession is in play-and-record mode BEFORE enumerating/probing
      audio.isRecordingMode = true;
      audio.setPlayAndRecordAudioSession();

      recDiag('REC_ENUMERATE_START', {
        ctx: inspectAudioCtx(audio.audioCtx)
      }, {
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_ENUMERATE_DEVICES : undefined,
        phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.START : 0
      });

      let devices = await navigator.mediaDevices.enumerateDevices();
      let audioInputs = devices.filter(d => d.kind === 'audioinput');

      // If device labels are blank, prompt briefly for mic permission
      if (audioInputs.length > 0 && !audioInputs[0].label) {
        const probeStart = performance.now();
        const useAutoGain = recordAutoGain ? recordAutoGain.checked : isIOSorIPad();
        const targetSampleRate = audio.audioCtx ? audio.audioCtx.sampleRate : undefined;
        const probeConstraints = {
          audio: {
            sampleRate: targetSampleRate ? { ideal: targetSampleRate } : undefined,
            echoCancellation: false,
            autoGainControl: useAutoGain,
            noiseSuppression: false
          }
        };
        recDiag('REC_PERMISSION_PROBE_START', { constraints: probeConstraints }, {
          stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_PERMISSION_PROBE : undefined,
          phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.START : 0,
          forcePersist: true
        });
        try {
          if (typeof navigator !== 'undefined' && navigator.audioSession) {
            try { navigator.audioSession.type = 'play-and-record'; } catch (_) {}
          }
          const tempStream = await navigator.mediaDevices.getUserMedia(probeConstraints);
          const probeSpec = inspectMediaStream(tempStream);
          tempStream.getTracks().forEach(t => t.stop());
          const probeDur = Number((performance.now() - probeStart).toFixed(2));
          recDiag('REC_PERMISSION_PROBE_OK', { durationMs: probeDur, stream: probeSpec }, {
            stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_PERMISSION_PROBE : undefined,
            phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.END : 1,
            duration: probeDur
          });
          devices = await navigator.mediaDevices.enumerateDevices();
          audioInputs = devices.filter(d => d.kind === 'audioinput');
        } catch (e1) {
          recDiag('REC_PERMISSION_PROBE_RETRY_BASIC', {
            error: e1 && e1.message ? e1.message : String(e1),
            name: e1 && e1.name ? e1.name : undefined,
            constraint: e1 && e1.constraint ? e1.constraint : undefined
          }, { level: 'warn', forcePersist: true });
          try {
            const fallbackStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const fbSpec = inspectMediaStream(fallbackStream);
            fallbackStream.getTracks().forEach(t => t.stop());
            const probeDur = Number((performance.now() - probeStart).toFixed(2));
            recDiag('REC_PERMISSION_PROBE_FALLBACK_OK', { durationMs: probeDur, stream: fbSpec }, {
              stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_PERMISSION_PROBE : undefined,
              phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.END : 1,
              duration: probeDur
            });
            devices = await navigator.mediaDevices.enumerateDevices();
            audioInputs = devices.filter(d => d.kind === 'audioinput');
          } catch (e2) {
            console.warn('Mic permission probe failed:', e2);
            recDiag('REC_PERMISSION_PROBE_FAILED', {
              error: e2 && e2.message ? e2.message : String(e2),
              name: e2 && e2.name ? e2.name : undefined
            }, { level: 'error', forcePersist: true });
          }
        }
      }

      const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

      if (recordDeviceSelect) {
        recordDeviceSelect.innerHTML = '';
        deviceRawLabelById.clear();
        if (audioInputs.length === 0) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = '📱 Built-in Phone Mic (44.1kHz CD Quality)';
          recordDeviceSelect.appendChild(opt);
          deviceRawLabelById.set('', 'Built-in Phone Mic');
          populateChannelSelectOptions({ streamChannels: 1, maxCapChannels: 1, deviceLabel: 'Built-in Phone Mic', preserveValue: true });
          recDiag('REC_ENUMERATE_COMPLETE', {
            durationMs: Number((performance.now() - enumStart).toFixed(2)),
            inputCount: 0,
            outputCount: audioOutputs.length
          }, {
            stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_ENUMERATE_DEVICES : undefined,
            phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.END : 1,
            extraData: 0
          });
        } else {
          // Identify USB Audio Interfaces (including Android Chrome's "USB headset" label for AIR 192|8 & AIR 192|14),
          // Built-in Phone Mic, Wired Headset, and Bluetooth Headset.
          let preferredDeviceId = null;

          const classified = audioInputs.map((dev, idx) => {
            const label = dev.label || `Microphone ${idx + 1}`;
            const flags = classifyInputDeviceLabel(label);
            deviceRawLabelById.set(dev.deviceId, label);
            return { dev, label, ...flags };
          });

          const usbDevice = classified.find(c => c.isUsb);
          const builtIn = classified.find(c => c.isInternal) || classified.find(c => !c.isBt && !c.isUsb) || classified[0];
          const manualStillPresent = userManuallySelectedDeviceId
            ? classified.find(c => c.dev.deviceId === userManuallySelectedDeviceId)
            : null;

          // Priority: 1) User's manual selection if still connected, 2) Connected USB Audio Interface, 3) Built-in Mic (keeps BT A2DP!)
          const chosen = manualStillPresent || usbDevice || builtIn || classified[0];
          if (chosen) {
            preferredDeviceId = chosen.dev.deviceId;
          }

          classified.forEach((item) => {
            const opt = document.createElement('option');
            opt.value = item.dev.deviceId;

            if (item.isUsb) {
              opt.textContent = `🎛️ ${item.label} (USB Audio Interface)`;
            } else if (item.isWiredHeadset) {
              opt.textContent = `🎙️ ${item.label} (Wired Headset)`;
            } else if (item.isInternal || (!usbDevice && builtIn && item.dev.deviceId === builtIn.dev.deviceId && !item.isBt)) {
              opt.textContent = `📱 ${item.label || 'Built-in Phone Mic'} (44.1kHz CD Quality — Recommended)`;
            } else if (item.isBt) {
              opt.textContent = `🎧 ${item.label} (16kHz Bluetooth Voice Mode)`;
            } else {
              opt.textContent = `🎤 ${item.label}`;
            }

            recordDeviceSelect.appendChild(opt);
          });

          if (preferredDeviceId) {
            recordDeviceSelect.value = preferredDeviceId;
          }

          // Refresh Auto Gain default based on selected device (OFF for USB interfaces & Android, ON for built-in iOS mic)
          initAutoGainDefault();

          const selRawLabel = getSelectedDeviceRawLabel();
          const selFlags = classifyInputDeviceLabel(selRawLabel);
          const savedPref = loadChannelSelectionPref(selRawLabel);
          const prefNeeded = savedPref ? parseChannelSelection(savedPref).neededChannels : 1;
          populateChannelSelectOptions({
            streamChannels: 1,
            maxCapChannels: selFlags.isUsb ? Math.max(2, prefNeeded) : 1,
            deviceLabel: selRawLabel,
            preserveValue: true
          });

          const enumDur = Number((performance.now() - enumStart).toFixed(2));
          recDiag('REC_ENUMERATE_COMPLETE', {
            durationMs: enumDur,
            inputCount: classified.length,
            outputCount: audioOutputs.length,
            inputs: classified.map(c => ({
              label: c.label,
              idPrefix: c.dev.deviceId ? String(c.dev.deviceId).slice(0, 12) : '',
              groupPrefix: c.dev.groupId ? String(c.dev.groupId).slice(0, 10) : '',
              isUsb: c.isUsb,
              isWiredHeadset: c.isWiredHeadset,
              isBt: c.isBt,
              isInternal: c.isInternal
            })),
            outputs: audioOutputs.map(o => ({
              label: o.label || '(unlabeled)',
              idPrefix: o.deviceId ? String(o.deviceId).slice(0, 12) : ''
            })),
            autoSelectedLabel: chosen ? chosen.label : null,
            autoSelectedIsUsb: chosen ? chosen.isUsb : false,
            autoSelectedIdPrefix: preferredDeviceId ? String(preferredDeviceId).slice(0, 12) : null
          }, {
            stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_ENUMERATE_DEVICES : undefined,
            phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.END : 1,
            duration: enumDur,
            extraData: classified.length,
            forcePersist: true
          });
        }
      }
    } catch (err) {
      console.warn('Failed to enumerate audio devices:', err);
      recDiag('REC_ENUMERATE_ERROR', {
        error: err && err.message ? err.message : String(err)
      }, { level: 'error', forcePersist: true });
    }
  }

  // --- Real-Time VU Meter, Pre-Recording Peak Check & Superimposed Sensitivity Slider ---
  const PEAK_SENS_STORAGE_KEY = 'nanodaw_peak_sens_db_v1';
  const VU_MIN_DB = -54;
  const SENS_MIN_DB = -50;
  const SENS_MAX_DB = -3;

  let peakSensDb = -24; // Default -24 dBFS (0.0631 linear): detects AIR taps down to ~12% amplitude while rejecting -32 dB room/handling bumps
  try {
    const savedSens = Number(localStorage.getItem(PEAK_SENS_STORAGE_KEY));
    if (Number.isFinite(savedSens) && savedSens >= SENS_MIN_DB && savedSens <= SENS_MAX_DB) {
      peakSensDb = Math.round(savedSens);
    }
  } catch (_) {}

  function isPeakSyncConfigured() {
    return Boolean(record2PassSync && record2PassSync.checked);
  }

  function getPeakThresholdLinear() {
    return Math.pow(10, peakSensDb / 20);
  }

  function getPeakOnsetRatio() {
    // Lower threshold (more eager) -> 1.45x ambient floor; higher threshold (less eager) -> 2.00x ambient floor
    const norm = (peakSensDb - SENS_MIN_DB) / (SENS_MAX_DB - SENS_MIN_DB);
    return 1.45 + Math.max(0, Math.min(1, norm)) * 0.55;
  }

  function getPeakSensitivityPercent() {
    // -50 dB = 100% sensitivity (most eager), -3 dB = 0% sensitivity (least eager), -24 dB = 55%
    return Math.round(((SENS_MAX_DB - peakSensDb) / (SENS_MAX_DB - SENS_MIN_DB)) * 100);
  }

  function updateVUMeterModeLayout() {
    const sel = parseChannelSelection(recordChannelSelect ? recordChannelSelect.value : 'mono:0');
    const isStereo = sel.mode === 'stereo';
    const vuContainer = document.getElementById('recordVUMeterContainer');
    const trackR = document.getElementById('recordVUMeterTrackR');
    const modeLabel = document.getElementById('recordVUModeLabel');
    if (vuContainer) {
      vuContainer.classList.toggle('stereo-active', isStereo);
    }
    if (trackR) {
      trackR.style.display = isStereo ? 'flex' : 'none';
    }
    if (modeLabel) {
      modeLabel.textContent = isStereo ? 'L · R' : 'VU';
    }
  }

  function updatePeakSensitivityUI() {
    const syncActive = isPeakSyncConfigured();
    const vuContainer = document.getElementById('recordVUMeterContainer');
    const peakRow = document.getElementById('vuPeakRow');
    const peakBadge = document.getElementById('recordVUPeakBadge');
    const trailEl = document.getElementById('vuPeakTriangleTrail');
    const sensZoneFill = document.getElementById('vuSensZoneFill');
    const sensZoneFillR = document.getElementById('vuSensZoneFillR');
    const sensOverlay = document.getElementById('peakSensitivityOverlay');
    const sensLine = document.getElementById('vuSensThresholdLine');
    const sensSlider = document.getElementById('peakSensitivitySlider');
    const sensReadoutWrap = document.getElementById('vuSensReadoutWrap');
    const sensReadout = document.getElementById('recordVUSensReadout');

    const pctFromBottom = Math.max(0, Math.min(100, ((peakSensDb - VU_MIN_DB) / -VU_MIN_DB) * 100));
    const sensPct = getPeakSensitivityPercent();

    updateVUMeterModeLayout();
    if (vuContainer) {
      vuContainer.classList.toggle('sync-active', syncActive);
    }
    if (peakRow) peakRow.style.display = syncActive ? 'flex' : 'none';
    if (peakBadge) peakBadge.style.display = syncActive ? 'inline-block' : 'none';
    if (trailEl) trailEl.style.display = syncActive ? 'block' : 'none';
    if (!syncActive && activePeakTriangles.length > 0) {
      resetPreRecTapTest();
    }
    if (sensZoneFill) {
      sensZoneFill.style.display = syncActive ? 'block' : 'none';
      sensZoneFill.style.bottom = `${pctFromBottom.toFixed(1)}%`;
    }
    if (sensZoneFillR) {
      sensZoneFillR.style.display = syncActive ? 'block' : 'none';
      sensZoneFillR.style.bottom = `${pctFromBottom.toFixed(1)}%`;
    }
    if (sensOverlay) {
      sensOverlay.style.display = syncActive ? 'block' : 'none';
    }
    if (sensLine) {
      sensLine.style.bottom = `${pctFromBottom.toFixed(1)}%`;
    }
    if (sensSlider) {
      sensSlider.value = String(peakSensDb);
      sensSlider.setAttribute('aria-valuetext', `${peakSensDb} dB threshold (${sensPct}% sensitivity)`);
    }
    if (sensReadoutWrap) {
      sensReadoutWrap.style.display = syncActive ? 'flex' : 'none';
    }
    if (!syncActive && typeof hideThresholdDragLabel === 'function') {
      hideThresholdDragLabel(true);
    }
    if (sensReadout) {
      sensReadout.style.display = syncActive ? 'block' : 'none';
      sensReadout.textContent = `${peakSensDb}dB`;
    }

    if (recWorkletNode) {
      try {
        recWorkletNode.port.postMessage({
          type: 'set_config',
          transientThreshold: getPeakThresholdLinear(),
          onsetRatio: getPeakOnsetRatio()
        });
      } catch (_) {}
    }
  }

  function setPeakSensitivityDb(rawDb) {
    if (!Number.isFinite(rawDb)) return;
    const clamped = Math.max(SENS_MIN_DB, Math.min(SENS_MAX_DB, Math.round(rawDb)));
    if (clamped === peakSensDb) {
      updatePeakSensitivityUI();
      return;
    }
    peakSensDb = clamped;
    clearPeakTrianglesImmediate();
    try {
      localStorage.setItem(PEAK_SENS_STORAGE_KEY, String(peakSensDb));
    } catch (_) {}
    updatePeakSensitivityUI();
  }

  const MAX_PEAK_TRIANGLES = 10;
  const PEAK_TRIANGLE_FADE_START_SLOT = 5; // 6th triangle (0-indexed slot 5) begins fading toward 0 at the 11th (slot 10)
  const PEAK_TRIANGLE_IDLE_MS = 6000;
  let vuTapTestCount = 0;
  let vuFlashTimerId = null;
  let vuTriangleIdleTimerId = null;
  let vuTriangleFadeEpoch = 0;
  let activePeakTriangles = [];

  function getPeakTriangleSlotAlpha(slotIdx) {
    if (slotIdx < PEAK_TRIANGLE_FADE_START_SLOT) return 1;
    const fadeSpan = (MAX_PEAK_TRIANGLES - PEAK_TRIANGLE_FADE_START_SLOT) + 1; // 6 equal steps: 5/6, 4/6, 3/6, 2/6, 1/6, 0
    const remaining = (MAX_PEAK_TRIANGLES - slotIdx) / fadeSpan;
    return Math.max(0, Math.min(1, remaining));
  }

  function getSyncColorCycleLength() {
    const n = syncTrackNumBeats ? parseInt(syncTrackNumBeats.value, 10) : 4;
    if (!Number.isFinite(n) || n < 1) return 4;
    return Math.min(16, Math.max(1, n));
  }

  // Generate N highly distinct shades sweeping from vivid yellow-lime through chartreuse & neon emerald to deep jade-green
  function getPeakTriangleGreenShade(stepIdx, cycleLen) {
    if (cycleLen <= 1) {
      return 'hsl(118 94% 54%)';
    }
    if (cycleLen === 2) {
      return ((((stepIdx % 2) + 2) % 2) === 0)
        ? 'hsl(58 98% 61%)'   // Bright yellow-lime
        : 'hsl(152 90% 42%)'; // Rich emerald-green
    }
    const t = (((stepIdx % cycleLen) + cycleLen) % cycleLen) / (cycleLen - 1);
    const hue = Math.round(54 + t * 120);   // 54° (bright yellow-lime) -> 94° (chartreuse) -> 134° (emerald) -> 174° (deep jade-green)
    const sat = Math.round(98 - t * 10);    // 98% -> 88%
    const light = Math.round(63 - t * 25);  // 63% -> 38% (all high contrast on dark VU strip)
    return `hsl(${hue} ${sat}% ${light}%)`;
  }

  function createPeakTriangleElement(beatSeqIdx, cycleLen) {
    const el = document.createElement('span');
    el.className = 'vu-peak-tri';
    el.dataset.peakSeq = String(beatSeqIdx);
    el.style.setProperty('--tri-color', getPeakTriangleGreenShade(beatSeqIdx, cycleLen));
    el.style.setProperty('--tri-slot', '0');
    el.style.setProperty('--tri-alpha', '1');
    el.innerHTML = '<svg viewBox="0 0 11 9" width="11" height="9" aria-hidden="true" focusable="false"><polygon points="0.8,4.5 10.2,0.7 10.2,8.3" fill="currentColor" stroke="rgba(2, 44, 34, 0.85)" stroke-width="0.85" stroke-linejoin="round"/></svg>';
    return el;
  }

  function refreshPeakTriangleShades() {
    const cycleLen = getSyncColorCycleLength();
    for (let i = 0; i < activePeakTriangles.length; i++) {
      const el = activePeakTriangles[i];
      const seq = parseInt(el.dataset.peakSeq, 10) || 0;
      el.style.setProperty('--tri-color', getPeakTriangleGreenShade(seq, cycleLen));
    }
  }

  function clearPeakTrianglesImmediate() {
    vuTapTestCount = 0;
    vuTriangleFadeEpoch++;
    if (vuTriangleIdleTimerId) {
      clearTimeout(vuTriangleIdleTimerId);
      vuTriangleIdleTimerId = null;
    }
    activePeakTriangles = [];
    const trailEl = document.getElementById('vuPeakTriangleTrail');
    if (trailEl) {
      trailEl.removeAttribute('data-closing');
      trailEl.innerHTML = '';
    }
  }

  async function removeOverflowTriangle(el) {
    if (!el || !el.isConnected) return;
    el.setAttribute('data-closing', '');
    const anims = typeof el.getAnimations === 'function' ? el.getAnimations() : [];
    if (anims.length > 0) {
      await Promise.race([
        Promise.allSettled(anims.map(a => a.finished)),
        new Promise(r => setTimeout(r, 350))
      ]);
    }
    if (el.isConnected) el.remove();
  }

  async function fadeOutAllPeakTriangles() {
    vuTriangleIdleTimerId = null;
    const trailEl = document.getElementById('vuPeakTriangleTrail');
    if (!trailEl || activePeakTriangles.length === 0) {
      vuTapTestCount = 0;
      return;
    }
    const myEpoch = ++vuTriangleFadeEpoch;
    trailEl.setAttribute('data-closing', '');
    const anims = activePeakTriangles.flatMap(el => (typeof el.getAnimations === 'function' ? el.getAnimations() : []));
    if (anims.length > 0) {
      await Promise.race([
        Promise.allSettled(anims.map(a => a.finished)),
        new Promise(r => setTimeout(r, 600))
      ]);
    }
    if (myEpoch === vuTriangleFadeEpoch) {
      trailEl.removeAttribute('data-closing');
      trailEl.innerHTML = '';
      activePeakTriangles = [];
      vuTapTestCount = 0;
    }
  }

  function resetPreRecTapTest() {
    clearPeakTrianglesImmediate();
    if (vuFlashTimerId) {
      clearTimeout(vuFlashTimerId);
      vuFlashTimerId = null;
    }
    const vuContainer = document.getElementById('recordVUMeterContainer');
    const peakBadge = document.getElementById('recordVUPeakBadge');
    const sensLine = document.getElementById('vuSensThresholdLine');
    if (vuContainer) vuContainer.classList.remove('peak-hit');
    if (peakBadge) peakBadge.classList.remove('detected');
    if (sensLine) sensLine.classList.remove('detected');
    hideThresholdDragLabel(true);
  }

  function flashPreRecPeakDetected() {
    const trailEl = document.getElementById('vuPeakTriangleTrail');
    if (trailEl && trailEl.hasAttribute('data-closing')) {
      vuTriangleFadeEpoch++;
      trailEl.removeAttribute('data-closing');
      trailEl.innerHTML = '';
      activePeakTriangles = [];
      vuTapTestCount = 0;
    }

    const beatSeqIdx = vuTapTestCount;
    vuTapTestCount++;
    const cycleLen = getSyncColorCycleLength();

    if (trailEl) {
      // Scroll existing triangles down by 1 row and taper alpha from the 6th triangle (slot 5) onwards
      for (let i = 0; i < activePeakTriangles.length; i++) {
        const nextSlot = i + 1;
        activePeakTriangles[i].style.setProperty('--tri-slot', String(nextSlot));
        activePeakTriangles[i].style.setProperty('--tri-alpha', getPeakTriangleSlotAlpha(nextSlot).toFixed(4));
      }

      // Insert new left-pointing triangle at row 0 directly to the left of [PEAK]
      const triEl = createPeakTriangleElement(beatSeqIdx, cycleLen);
      trailEl.prepend(triEl);
      activePeakTriangles.unshift(triEl);

      // Cap at maximum of 10 triangles
      while (activePeakTriangles.length > MAX_PEAK_TRIANGLES) {
        const oldest = activePeakTriangles.pop();
        removeOverflowTriangle(oldest);
      }
    }

    // Fade out & clear all triangles if no peaks are detected for 6 seconds
    if (vuTriangleIdleTimerId) {
      clearTimeout(vuTriangleIdleTimerId);
    }
    vuTriangleIdleTimerId = setTimeout(fadeOutAllPeakTriangles, PEAK_TRIANGLE_IDLE_MS);

    const vuContainer = document.getElementById('recordVUMeterContainer');
    const peakBadge = document.getElementById('recordVUPeakBadge');
    const sensLine = document.getElementById('vuSensThresholdLine');

    if (vuContainer) vuContainer.classList.add('peak-hit');
    if (peakBadge) peakBadge.classList.add('detected');
    if (sensLine) sensLine.classList.add('detected');

    if (vuFlashTimerId) clearTimeout(vuFlashTimerId);
    vuFlashTimerId = setTimeout(() => {
      if (vuContainer) vuContainer.classList.remove('peak-hit');
      if (peakBadge) peakBadge.classList.remove('detected');
      if (sensLine) sensLine.classList.remove('detected');
      vuFlashTimerId = null;
    }, 260);
  }

  let supportsDiscreteDisplayTransition;
  function canTransitionDisplay() {
    if (supportsDiscreteDisplayTransition !== undefined) return supportsDiscreteDisplayTransition;
    if (typeof window === 'undefined' || !window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) {
      return false;
    }
    const probe = document.createElement('div');
    probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
    document.body.appendChild(probe);
    getComputedStyle(probe).display;
    probe.style.display = 'none';
    supportsDiscreteDisplayTransition = getComputedStyle(probe).display === 'block';
    probe.remove();
    return supportsDiscreteDisplayTransition;
  }

  function showThresholdDragLabel() {
    const labelEl = document.getElementById('vuThresholdDragLabel');
    const readoutEl = document.getElementById('recordVUSensReadout');
    if (readoutEl) readoutEl.classList.add('dragging');
    if (!labelEl) return;
    labelEl.removeAttribute('data-closing');
    labelEl.hidden = false;
  }

  async function hideThresholdDragLabel(immediate = false) {
    const labelEl = document.getElementById('vuThresholdDragLabel');
    const readoutEl = document.getElementById('recordVUSensReadout');
    if (readoutEl) readoutEl.classList.remove('dragging');
    if (!labelEl || labelEl.hidden) return;
    if (immediate) {
      labelEl.removeAttribute('data-closing');
      labelEl.hidden = true;
      return;
    }
    if (canTransitionDisplay()) {
      labelEl.hidden = true;
    } else {
      labelEl.setAttribute('data-closing', '');
    }
    const anims = typeof labelEl.getAnimations === 'function' ? labelEl.getAnimations() : [];
    if (anims.length > 0) {
      await Promise.race([
        Promise.allSettled(anims.map(a => a.finished)),
        new Promise(r => setTimeout(r, 400))
      ]);
    }
    if (labelEl.hasAttribute('data-closing')) {
      labelEl.removeAttribute('data-closing');
      labelEl.hidden = true;
    }
  }

  // Wire superimposed Peak Detection Sensitivity Slider (pointer drag + keyboard accessible range)
  (function initPeakSensitivityControls() {
    const sensOverlay = document.getElementById('peakSensitivityOverlay');
    const sensSlider = document.getElementById('peakSensitivitySlider');
    const stackWrap = document.getElementById('vuMeterStackWrap');
    let isPointerDraggingSens = false;

    function updateFromClientY(clientY) {
      const refEl = stackWrap || sensOverlay;
      if (!refEl) return;
      const rect = refEl.getBoundingClientRect();
      if (!rect || rect.height <= 0) return;
      const fracFromBottom = 1 - ((clientY - rect.top) / rect.height);
      const rawDb = VU_MIN_DB + Math.max(0, Math.min(1, fracFromBottom)) * (-VU_MIN_DB);
      setPeakSensitivityDb(rawDb);
    }

    if (sensOverlay) {
      sensOverlay.addEventListener('pointerdown', (e) => {
        if (!isPeakSyncConfigured()) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        isPointerDraggingSens = true;
        e.preventDefault();
        try { sensOverlay.setPointerCapture(e.pointerId); } catch (_) {}
        if (sensSlider) {
          try { sensSlider.focus({ preventScroll: true }); } catch (_) {}
        }
        clearPeakTrianglesImmediate();
        showThresholdDragLabel();
        updateFromClientY(e.clientY);
      });

      sensOverlay.addEventListener('pointermove', (e) => {
        if (!isPointerDraggingSens) return;
        e.preventDefault();
        updateFromClientY(e.clientY);
      });

      const endDrag = () => {
        if (isPointerDraggingSens) {
          isPointerDraggingSens = false;
          hideThresholdDragLabel(false);
          recDiag('REC_PEAK_SENS_ADJUSTED', {
            peakSensDb,
            thresholdLinear: Number(getPeakThresholdLinear().toFixed(5)),
            sensitivityPct: getPeakSensitivityPercent()
          });
        }
      };
      sensOverlay.addEventListener('pointerup', endDrag);
      sensOverlay.addEventListener('pointercancel', endDrag);
      sensOverlay.addEventListener('lostpointercapture', endDrag);
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('blur', endDrag);
    }

    if (sensSlider) {
      sensSlider.addEventListener('input', () => {
        if (!isPointerDraggingSens) {
          setPeakSensitivityDb(Number(sensSlider.value));
        }
      });
      sensSlider.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
          e.preventDefault();
          clearPeakTrianglesImmediate();
          showThresholdDragLabel();
          setPeakSensitivityDb(peakSensDb + 1);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
          e.preventDefault();
          clearPeakTrianglesImmediate();
          showThresholdDragLabel();
          setPeakSensitivityDb(peakSensDb - 1);
        } else if (e.key === 'Home') {
          e.preventDefault();
          clearPeakTrianglesImmediate();
          showThresholdDragLabel();
          setPeakSensitivityDb(SENS_MIN_DB);
        } else if (e.key === 'End') {
          e.preventDefault();
          clearPeakTrianglesImmediate();
          showThresholdDragLabel();
          setPeakSensitivityDb(SENS_MAX_DB);
        }
      });
      sensSlider.addEventListener('keyup', () => {
        if (!isPointerDraggingSens) {
          hideThresholdDragLabel(false);
        }
      });
      sensSlider.addEventListener('blur', () => {
        if (!isPointerDraggingSens) {
          hideThresholdDragLabel(false);
        }
      });
    }

    updatePeakSensitivityUI();
  })();

  let vuStream = null;
  let vuSource = null;
  let vuSplitter = null;
  let vuAnalyser = null;
  let vuAnalysers = [];
  let vuAnimId = null;
  let vuPeakHold = 0;
  let vuPeakHoldTime = 0;
  let vuPeakHoldR = 0;
  let vuPeakHoldTimeR = 0;
  let vuClipTime = 0;
  let vuIsStarting = false;
  let vuFastEnv = 0;
  let vuFastEnvR = 0;
  let vuAmbientFloor = 0.003;
  let vuLastTransientMs = 0;
  let vuLastCtxTime = 0;
  let vuHintLastUpdateMs = 0;
  const VU_FFT_SIZE = 2048;
  const vuChannelBuffers = [new Float32Array(VU_FFT_SIZE), new Float32Array(VU_FFT_SIZE)];
  const vuChannelEnvs = new Float32Array(16);
  const vuMonoScratch = new Float32Array(VU_FFT_SIZE);

  function ensureVuChannelBuffers(count) {
    const target = Math.min(16, Math.max(2, count | 0));
    while (vuChannelBuffers.length < target) {
      vuChannelBuffers.push(new Float32Array(VU_FFT_SIZE));
    }
  }

  function getStreamActualChannels(stream) {
    if (!stream || !stream.getAudioTracks) return 1;
    const trk = stream.getAudioTracks()[0];
    if (!trk) return 1;
    try {
      if (typeof trk.getSettings === 'function') {
        const s = trk.getSettings();
        if (s && typeof s.channelCount === 'number' && s.channelCount >= 1) {
          return s.channelCount | 0;
        }
      }
    } catch (_) {}
    return 1;
  }

  function getStreamMaxCapChannels(stream, deviceLabel = '') {
    let maxCap = getStreamActualChannels(stream);
    if (stream && stream.getAudioTracks && stream.getAudioTracks()[0]) {
      const trk = stream.getAudioTracks()[0];
      try {
        if (typeof trk.getCapabilities === 'function') {
          const caps = trk.getCapabilities();
          if (caps && caps.channelCount && typeof caps.channelCount.max === 'number' && caps.channelCount.max > maxCap) {
            maxCap = caps.channelCount.max | 0;
          }
        }
      } catch (_) {}
    }
    // On iOS Safari, if a USB interface (e.g. AIR 192|8 or AIR 192|14) was probed at 1ch and WebKit omits channelCount.max,
    // expose at least 2 channels (or 4 for 192|14) so the user can select Input 2 / Stereo 1/2 / Stereo 3/4!
    if (maxCap < 2) {
      const flags = classifyInputDeviceLabel(deviceLabel);
      if (flags.isUsb) {
        maxCap = /192\s*\|\s*14|\b14\b|umc404|umc1820|18i|8pre|4\s*ch/i.test(deviceLabel) ? 4 : 2;
      }
    }
    return Math.min(16, Math.max(1, maxCap));
  }

  function computeTargetIdealChannelCount(deviceLabel, useAutoGain, channelSel) {
    const flags = classifyInputDeviceLabel(deviceLabel);
    if (useAutoGain || flags.isBt) return 1;
    const needed = (channelSel && channelSel.neededChannels) ? channelSel.neededChannels : 1;
    if (isIOSorIPad()) {
      // Hang-safe iOS mode: keep stream at 1ch by default unless user explicitly selects Input 2+ or Stereo pair
      return needed > 1 ? needed : 1;
    }
    // Android (Chrome AAudio/OpenSL & Firefox Gecko) + Desktop (Windows WASAPI, macOS CoreAudio, Linux PipeWire):
    // Request non-mandatory ideal: 8 for USB interfaces (captures 2ch on AIR 192|8 and up to 4/8ch on AIR 192|14 without OverconstrainedError)
    return flags.isUsb ? Math.max(8, needed) : Math.max(2, needed);
  }

  async function acquireMultiChannelMicStream({ deviceId = '', deviceLabel = '', useAutoGain = false, channelSel = null, targetSampleRate = undefined, exactDevice = false, diagPrefix = 'REC_GUM' } = {}) {
    const idealCh = computeTargetIdealChannelCount(deviceLabel, useAutoGain, channelSel);
    const gumStart = performance.now();

    const attempt1 = {
      audio: {
        sampleRate: targetSampleRate ? { ideal: targetSampleRate } : undefined,
        channelCount: { ideal: idealCh },
        echoCancellation: false,
        autoGainControl: Boolean(useAutoGain),
        noiseSuppression: false
      }
    };
    if (deviceId) {
      attempt1.audio.deviceId = exactDevice ? { exact: deviceId } : { ideal: deviceId };
    }

    recDiag(`${diagPrefix}_ATTEMPT_1_START`, {
      deviceLabel,
      idealChannels: idealCh,
      constraints: attempt1
    }, {
      stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_GUM_REQUEST : undefined,
      phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.START : 0,
      forcePersist: true
    });

    try {
      const s1 = await navigator.mediaDevices.getUserMedia(attempt1);
      const gumDur = Number((performance.now() - gumStart).toFixed(2));
      recDiag(`${diagPrefix}_ATTEMPT_1_OK`, {
        durationMs: gumDur,
        idealChannels: idealCh,
        stream: inspectMediaStream(s1)
      }, {
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_GUM_REQUEST : undefined,
        phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.END : 1,
        duration: gumDur,
        forcePersist: true
      });
      return s1;
    } catch (e1) {
      recDiag(`${diagPrefix}_ATTEMPT_1_FAILED`, {
        name: e1 && e1.name ? e1.name : undefined,
        message: e1 && e1.message ? e1.message : String(e1),
        constraint: e1 && e1.constraint ? e1.constraint : undefined
      }, { level: 'warn', forcePersist: true });

      try {
        const fbCh = idealCh > 2 ? 2 : 1;
        const attempt2 = {
          audio: {
            sampleRate: targetSampleRate ? { ideal: targetSampleRate } : undefined,
            channelCount: { ideal: fbCh },
            echoCancellation: false,
            autoGainControl: Boolean(useAutoGain),
            noiseSuppression: false
          }
        };
        if (deviceId) {
          attempt2.audio.deviceId = { ideal: deviceId };
        }
        recDiag(`${diagPrefix}_ATTEMPT_2_START`, { constraints: attempt2 }, { forcePersist: true });
        const s2 = await navigator.mediaDevices.getUserMedia(attempt2);
        const gumDur = Number((performance.now() - gumStart).toFixed(2));
        recDiag(`${diagPrefix}_ATTEMPT_2_OK`, {
          durationMs: gumDur,
          stream: inspectMediaStream(s2)
        }, {
          stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_GUM_REQUEST : undefined,
          phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.END : 1,
          duration: gumDur,
          forcePersist: true
        });
        return s2;
      } catch (e2) {
        recDiag(`${diagPrefix}_ATTEMPT_2_FAILED`, {
          name: e2 && e2.name ? e2.name : undefined,
          message: e2 && e2.message ? e2.message : String(e2),
          constraint: e2 && e2.constraint ? e2.constraint : undefined
        }, { level: 'warn', forcePersist: true });
        recDiag(`${diagPrefix}_ATTEMPT_3_START`, { constraints: { audio: true } }, { forcePersist: true });
        const s3 = await navigator.mediaDevices.getUserMedia({ audio: true });
        const gumDur = Number((performance.now() - gumStart).toFixed(2));
        recDiag(`${diagPrefix}_ATTEMPT_3_OK`, {
          durationMs: gumDur,
          stream: inspectMediaStream(s3)
        }, {
          stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_GUM_REQUEST : undefined,
          phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.END : 1,
          duration: gumDur,
          forcePersist: true
        });
        return s3;
      }
    }
  }

  function setVUMeterGrayedOut(isGray) {
    const vuContainer = document.getElementById('recordVUMeterContainer');
    const dbEl = document.getElementById('recordVUMeterDb');
    if (vuContainer) {
      if (isGray) {
        vuContainer.style.opacity = '0.35';
        vuContainer.style.filter = 'grayscale(1)';
        vuContainer.style.pointerEvents = 'none';
        if (dbEl) dbEl.textContent = 'INIT';
      } else {
        vuContainer.style.opacity = '1';
        vuContainer.style.filter = 'none';
        vuContainer.style.pointerEvents = 'auto';
        if (dbEl && dbEl.textContent === 'INIT') {
          dbEl.textContent = '-∞';
        }
      }
    }
  }

  async function startVUMonitor(forceRestart = false) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    const modal = document.getElementById('recordSetupModal');
    if (!modal || modal.classList.contains('hidden') || modal.style.display === 'none') return;

    const currentSel = parseChannelSelection(recordChannelSelect ? recordChannelSelect.value : 'mono:0');
    const existingStreamCh = vuStream ? getStreamActualChannels(vuStream) : 0;
    const needsMoreChannels = Boolean(
      vuStream &&
      currentSel.neededChannels > existingStreamCh &&
      vuStreamMaxCapCh >= currentSel.neededChannels
    );

    if (forceRestart || needsMoreChannels) {
      stopVUMonitor(false);
    }

    // If stream is already healthy and analyser is running with enough channels, keep it alive seamlessly
    if (!forceRestart && !needsMoreChannels && vuStream && vuStream.active && vuAnalyser && vuStream.getAudioTracks().length > 0 && vuStream.getAudioTracks()[0].readyState === 'live') {
      setVUMeterGrayedOut(false);
      updatePeakSensitivityUI();
      updateChannelStatusBadge();
      if (!vuAnimId) {
        vuAnimId = requestAnimationFrame(renderVU);
      }
      return;
    }

    if (vuIsStarting) return;
    vuIsStarting = true;
    setVUMeterGrayedOut(true);
    const vuStartPerf = performance.now();

    try {
      const selectedDeviceId = recordDeviceSelect ? recordDeviceSelect.value : '';
      const rawDeviceLabel = getSelectedDeviceRawLabel();
      const selectedOptionText = (recordDeviceSelect && recordDeviceSelect.selectedOptions && recordDeviceSelect.selectedOptions[0])
        ? recordDeviceSelect.selectedOptions[0].textContent
        : rawDeviceLabel;
      const useAutoGain = recordAutoGain ? recordAutoGain.checked : (isIOSorIPad() && !classifyInputDeviceLabel(rawDeviceLabel).isUsb);
      const vuCtx = audio.getOrCreateAudioContext();
      const targetSampleRate = vuCtx ? vuCtx.sampleRate : undefined;

      recDiag('REC_VU_GUM_START', {
        forceRestart,
        selectedOptionText,
        rawDeviceLabel,
        channelSelection: currentSel,
        selectedDeviceIdPrefix: selectedDeviceId ? String(selectedDeviceId).slice(0, 12) : '',
        ctx: inspectAudioCtx(vuCtx)
      }, {
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_VU_START : undefined,
        phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.START : 0,
        forcePersist: true
      });

      const stream = await acquireMultiChannelMicStream({
        deviceId: selectedDeviceId,
        deviceLabel: rawDeviceLabel || selectedOptionText,
        useAutoGain,
        channelSel: currentSel,
        targetSampleRate,
        exactDevice: Boolean(selectedDeviceId),
        diagPrefix: 'REC_VU_GUM'
      });
      const gumDur = Number((performance.now() - vuStartPerf).toFixed(2));
      const currentModal = document.getElementById('recordSetupModal');
      if (!currentModal || currentModal.classList.contains('hidden') || currentModal.style.display === 'none') {
        stream.getTracks().forEach(t => t.stop());
        vuIsStarting = false;
        recDiag('REC_VU_ABORTED_MODAL_CLOSED', { gumDur });
        return;
      }

      if (vuSource) {
        try { vuSource.disconnect(); } catch (_) {}
        vuSource = null;
      }
      if (vuSplitter) {
        try { vuSplitter.disconnect(); } catch (_) {}
        vuSplitter = null;
      }
      if (vuAnalysers.length > 0) {
        vuAnalysers.forEach(a => { try { a.disconnect(); } catch (_) {} });
        vuAnalysers = [];
      }
      vuAnalyser = null;
      if (vuStream && vuStream !== stream) {
        try { vuStream.getTracks().forEach(t => t.stop()); } catch (_) {}
      }

      vuStream = stream;
      const ctx = audio.getOrCreateAudioContext();
      if (!ctx) {
        vuIsStarting = false;
        recDiag('REC_VU_NO_AUDIO_CTX', {}, { level: 'error', forcePersist: true });
        return;
      }
      if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
        const resStart = performance.now();
        recDiag('REC_VU_CTX_RESUME_START', { stateBefore: ctx.state }, { forcePersist: true });
        try { await ctx.resume(); } catch (reErr) {
          recDiag('REC_VU_CTX_RESUME_ERROR', { error: reErr && reErr.message ? reErr.message : String(reErr) }, { level: 'warn', forcePersist: true });
        }
        recDiag('REC_VU_CTX_RESUME_DONE', { stateAfter: ctx.state, durationMs: Number((performance.now() - resStart).toFixed(2)) });
      }

      if (!currentModal || currentModal.classList.contains('hidden') || currentModal.style.display === 'none') {
        stream.getTracks().forEach(t => t.stop());
        vuStream = null;
        vuIsStarting = false;
        return;
      }

      vuSource = ctx.createMediaStreamSource(vuStream);
      try {
        vuSource.channelInterpretation = 'discrete';
      } catch (_) {}

      const detectedStreamCh = Math.min(16, Math.max(1, getStreamActualChannels(vuStream), vuSource.channelCount || 1));
      const maxCapCh = Math.max(detectedStreamCh, getStreamMaxCapChannels(vuStream, rawDeviceLabel || selectedOptionText));
      const splitterCh = Math.max(2, detectedStreamCh);

      vuSplitter = ctx.createChannelSplitter(splitterCh);
      try {
        vuSplitter.channelInterpretation = 'discrete';
      } catch (_) {}

      ensureVuChannelBuffers(detectedStreamCh);
      vuAnalysers = [];
      for (let c = 0; c < detectedStreamCh; c++) {
        const an = ctx.createAnalyser();
        an.fftSize = VU_FFT_SIZE;
        an.smoothingTimeConstant = 0.0;
        vuAnalysers.push(an);
      }
      vuAnalyser = vuAnalysers[0];
      vuSource.connect(vuSplitter);
      for (let c = 0; c < detectedStreamCh; c++) {
        vuSplitter.connect(vuAnalysers[c], c);
      }

      populateChannelSelectOptions({
        streamChannels: detectedStreamCh,
        maxCapChannels: maxCapCh,
        deviceLabel: rawDeviceLabel || selectedOptionText,
        preserveValue: true
      });

      // If the restored saved preference requires >1 channel on iOS (where initial probe was 1ch), upgrade stream once seamlessly
      const postPopulateSel = parseChannelSelection(recordChannelSelect ? recordChannelSelect.value : 'mono:0');
      if (isIOSorIPad() && postPopulateSel.neededChannels > detectedStreamCh && maxCapCh >= postPopulateSel.neededChannels && !forceRestart) {
        vuIsStarting = false;
        startVUMonitor(true);
        return;
      }

      vuFastEnv = 0;
      vuFastEnvR = 0;
      vuPeakHold = 0;
      vuPeakHoldR = 0;
      vuAmbientFloor = 0.003;
      vuLastTransientMs = 0;
      vuLastCtxTime = ctx.currentTime;
      vuChannelEnvs.fill(0);

      const totalVuInitMs = Number((performance.now() - vuStartPerf).toFixed(2));
      recDiag('REC_VU_READY', {
        gumDurationMs: gumDur,
        totalInitMs: totalVuInitMs,
        detectedStreamCh,
        maxCapCh,
        channelSelection: postPopulateSel,
        peakSensDb,
        stream: inspectMediaStream(vuStream),
        ctx: inspectAudioCtx(ctx)
      }, {
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_VU_START : undefined,
        phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.END : 1,
        duration: totalVuInitMs,
        forcePersist: true
      });

      // Audio stack connected: ungray the VU meter & sync sensitivity UI
      setVUMeterGrayedOut(false);
      updatePeakSensitivityUI();

      if (vuAnimId) {
        cancelAnimationFrame(vuAnimId);
        vuAnimId = null;
      }
      vuAnimId = requestAnimationFrame(renderVU);
    } catch (err) {
      console.warn('VU meter monitoring stream not available:', err);
      recDiag('REC_VU_ERROR', {
        name: err && err.name ? err.name : undefined,
        message: err && err.message ? err.message : String(err),
        constraint: err && err.constraint ? err.constraint : undefined,
        durationMs: Number((performance.now() - vuStartPerf).toFixed(2))
      }, {
        level: 'error',
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_ERROR : undefined,
        forcePersist: true
      });
      setVUMeterGrayedOut(true);
    } finally {
      vuIsStarting = false;
    }
  }

  function levelToVuPercent(linearVal) {
    if (linearVal <= 0.0001) return 0;
    const db = 20 * Math.log10(linearVal);
    if (db <= VU_MIN_DB) return 0;
    return Math.min(100, Math.max(0, ((db - VU_MIN_DB) / -VU_MIN_DB) * 100));
  }

  function renderVU() {
    const modal = document.getElementById('recordSetupModal');
    if (!vuAnalyser || vuAnalysers.length === 0 || !modal || modal.classList.contains('hidden') || modal.style.display === 'none') {
      stopVUMonitor();
      return;
    }

    if (activeRecordModalTab === 'record') {
      const ctx = audio.audioCtx;
      const sr = (ctx && ctx.sampleRate) ? ctx.sampleRate : 44100;
      const curCtxTime = ctx ? ctx.currentTime : (performance.now() / 1000);
      const elapsedSec = vuLastCtxTime > 0 ? Math.max(0.003, curCtxTime - vuLastCtxTime) : 0.020;
      vuLastCtxTime = curCtxTime;

      // Scan every newly-arrived sample since the previous rAF tick (zero dropped transients between frames)
      const inspectLen = Math.min(VU_FFT_SIZE, Math.max(256, Math.round(elapsedSec * sr)));
      const startIdx = VU_FFT_SIZE - inspectLen;
      const numAn = vuAnalysers.length;
      ensureVuChannelBuffers(numAn);

      const perChPeak = new Float32Array(numAn);
      const perChRms = new Float32Array(numAn);

      for (let c = 0; c < numAn; c++) {
        const buf = vuChannelBuffers[c];
        vuAnalysers[c].getFloatTimeDomainData(buf);
        let pk = 0;
        let sq = 0;
        let env = vuChannelEnvs[c];
        for (let i = startIdx; i < VU_FFT_SIZE; i++) {
          const a = Math.abs(buf[i]);
          if (a > pk) pk = a;
          sq += buf[i] * buf[i];
          env = a > env ? a : env * 0.9992;
        }
        perChPeak[c] = pk;
        perChRms[c] = Math.sqrt(sq / inspectLen);
        vuChannelEnvs[c] = env;
      }

      const sel = parseChannelSelection(recordChannelSelect ? recordChannelSelect.value : 'mono:0');
      const now = performance.now();

      let detectArr = vuChannelBuffers[0];
      let barPeakL = 0;
      let barRmsL = 0;
      let barPeakR = 0;
      let barRmsR = 0;
      const isStereo = sel.mode === 'stereo';

      if (isStereo) {
        const idxL = Math.min(sel.left, numAn - 1);
        const idxR = Math.min(sel.right, numAn - 1);
        const bufL = vuChannelBuffers[idxL];
        const bufR = vuChannelBuffers[idxR];
        barPeakL = perChPeak[idxL];
        barRmsL = perChRms[idxL];
        barPeakR = perChPeak[idxR];
        barRmsR = perChRms[idxR];
        for (let i = startIdx; i < VU_FFT_SIZE; i++) {
          vuMonoScratch[i] = Math.abs(bufL[i]) >= Math.abs(bufR[i]) ? bufL[i] : bufR[i];
        }
        detectArr = vuMonoScratch;
      } else if (sel.mode === 'mono') {
        const idxM = Math.min(sel.ch, numAn - 1);
        detectArr = vuChannelBuffers[idxM];
        barPeakL = perChPeak[idxM];
        barRmsL = perChRms[idxM];
      } else {
        // 'auto' mode across all active channels
        if (numAn > 1) {
          let best = 0;
          let sec = 1;
          if (vuChannelEnvs[1] > vuChannelEnvs[0]) { best = 1; sec = 0; }
          for (let c = 2; c < numAn; c++) {
            if (vuChannelEnvs[c] > vuChannelEnvs[best]) { sec = best; best = c; }
            else if (vuChannelEnvs[c] > vuChannelEnvs[sec]) { sec = c; }
          }
          if (vuChannelEnvs[best] > vuChannelEnvs[sec] * 2.4 && vuChannelEnvs[best] > 0.0008) {
            detectArr = vuChannelBuffers[best];
          } else {
            const bA = vuChannelBuffers[best];
            const bB = vuChannelBuffers[sec];
            for (let i = startIdx; i < VU_FFT_SIZE; i++) {
              vuMonoScratch[i] = 0.5 * (bA[i] + bB[i]);
            }
            detectArr = vuMonoScratch;
          }
        }
      }

      // Live hint if another unselected input channel has strong signal while selected channel is quiet
      if (numAn > 1 && now - vuHintLastUpdateMs > 220) {
        vuHintLastUpdateMs = now;
        const activeSignalPeak = isStereo ? Math.max(barPeakL, barPeakR) : (sel.mode === 'mono' ? barPeakL : Math.max(...perChPeak));
        let otherStrongCh = -1;
        let otherMax = 0;
        if (sel.mode !== 'auto' && activeSignalPeak < 0.006) {
          for (let c = 0; c < numAn; c++) {
            const isSelected = isStereo ? (c === sel.left || c === sel.right) : (c === sel.ch);
            if (!isSelected && perChPeak[c] > 0.035 && perChPeak[c] > otherMax) {
              otherMax = perChPeak[c];
              otherStrongCh = c;
            }
          }
        }
        if (otherStrongCh >= 0) {
          const hwNum = getHardwarePairBaseChannel(getSelectedDeviceRawLabel()) + otherStrongCh;
          updateChannelStatusBadge(`⚡ Signal on Input ${hwNum}`);
        } else {
          updateChannelStatusBadge(null);
        }
      }

      let peak = 0;
      let maxDiff = 0;
      let sumSq = 0;
      for (let i = startIdx; i < VU_FFT_SIZE; i++) {
        const val = detectArr[i];
        const abs = Math.abs(val);
        if (abs > peak) peak = abs;
        sumSq += val * val;
        if (i > startIdx) {
          const d = Math.abs(val - detectArr[i - 1]);
          if (d > maxDiff) maxDiff = d;
        }
      }

      const rms = Math.sqrt(sumSq / inspectLen);
      if (sel.mode === 'auto') {
        barPeakL = peak;
        barRmsL = rms;
      }

      // Left / Mono envelope & peak hold
      vuFastEnv = barPeakL >= vuFastEnv ? barPeakL : Math.max(barRmsL, vuFastEnv * 0.85);
      if (barPeakL > vuPeakHold || now - vuPeakHoldTime > 850) {
        vuPeakHold = barPeakL;
        vuPeakHoldTime = now;
      } else {
        vuPeakHold = Math.max(0, vuPeakHold * 0.94 - 0.002);
      }

      // Right envelope & peak hold (when in Stereo mode)
      if (isStereo) {
        vuFastEnvR = barPeakR >= vuFastEnvR ? barPeakR : Math.max(barRmsR, vuFastEnvR * 0.85);
        if (barPeakR > vuPeakHoldR || now - vuPeakHoldTimeR > 850) {
          vuPeakHoldR = barPeakR;
          vuPeakHoldTimeR = now;
        } else {
          vuPeakHoldR = Math.max(0, vuPeakHoldR * 0.94 - 0.002);
        }
      } else {
        vuFastEnvR = 0;
        vuPeakHoldR = 0;
      }

      // Live Pre-Recording Peak Detection Check (identical rule & threshold to NanodawRecorderProcessor)
      if (isPeakSyncConfigured()) {
        const thresh = getPeakThresholdLinear();
        const onsetRatio = getPeakOnsetRatio();
        if (peak < thresh) {
          vuAmbientFloor = 0.92 * vuAmbientFloor + 0.08 * rms;
        } else {
          vuAmbientFloor = 0.985 * vuAmbientFloor + 0.015 * Math.min(rms, thresh * 0.5);
        }
        if (peak >= thresh && (peak >= vuAmbientFloor * onsetRatio || maxDiff >= thresh * 0.16)) {
          if (now - vuLastTransientMs > 135) {
            vuLastTransientMs = now;
            flashPreRecPeakDetected(peak);
          }
        }
      }

      const vuPctL = levelToVuPercent(vuFastEnv);
      const peakPctL = levelToVuPercent(vuPeakHold);

      const barEl = document.getElementById('recordVUMeterBar');
      const peakEl = document.getElementById('recordVUMeterPeak');
      const barElR = document.getElementById('recordVUMeterBarR');
      const peakElR = document.getElementById('recordVUMeterPeakR');
      const clipEl = document.getElementById('recordVUClipIndicator');
      const dbEl = document.getElementById('recordVUMeterDb');

      if (barEl) barEl.style.height = `${vuPctL.toFixed(1)}%`;
      if (peakEl) {
        if (peakPctL > 2) {
          peakEl.style.display = 'block';
          peakEl.style.bottom = `${peakPctL.toFixed(1)}%`;
        } else {
          peakEl.style.display = 'none';
        }
      }

      if (isStereo) {
        const vuPctR = levelToVuPercent(vuFastEnvR);
        const peakPctR = levelToVuPercent(vuPeakHoldR);
        if (barElR) barElR.style.height = `${vuPctR.toFixed(1)}%`;
        if (peakElR) {
          if (peakPctR > 2) {
            peakElR.style.display = 'block';
            peakElR.style.bottom = `${peakPctR.toFixed(1)}%`;
          } else {
            peakElR.style.display = 'none';
          }
        }
      }

      const maxInstantPeak = isStereo ? Math.max(barPeakL, barPeakR) : barPeakL;
      if (maxInstantPeak >= 0.98) {
        vuClipTime = now;
      }
      if (clipEl) {
        if (now - vuClipTime < 600) {
          clipEl.style.background = '#ef4444';
          clipEl.style.boxShadow = '0 0 6px #ef4444';
        } else {
          clipEl.style.background = 'rgba(239, 68, 68, 0.25)';
          clipEl.style.boxShadow = 'none';
        }
      }

      if (dbEl) {
        const maxHold = isStereo ? Math.max(vuPeakHold, vuPeakHoldR) : vuPeakHold;
        const maxFast = isStereo ? Math.max(vuFastEnv, vuFastEnvR) : vuFastEnv;
        const refLin = maxHold > 0.0003 ? maxHold : maxFast;
        const displayDb = refLin > 0.0001 ? 20 * Math.log10(refLin) : -100;
        if (displayDb <= -50) {
          dbEl.textContent = '-∞';
        } else {
          dbEl.textContent = `${Math.round(displayDb)}`;
        }
      }
    }

    vuAnimId = requestAnimationFrame(renderVU);
  }

  function stopVUMonitor(preserveStream = false) {
    const hadStream = Boolean(vuStream);
    if (vuAnimId) {
      cancelAnimationFrame(vuAnimId);
      vuAnimId = null;
    }
    if (vuSource) {
      try { vuSource.disconnect(); } catch (_) {}
      vuSource = null;
    }
    if (vuSplitter) {
      try { vuSplitter.disconnect(); } catch (_) {}
      vuSplitter = null;
    }
    if (vuAnalysers.length > 0) {
      vuAnalysers.forEach(a => { try { a.disconnect(); } catch (_) {} });
      vuAnalysers = [];
    }
    vuAnalyser = null;
    if (!preserveStream && vuStream) {
      try {
        vuStream.getTracks().forEach(t => t.stop());
      } catch (_) {}
      vuStream = null;
    }
    if (hadStream || preserveStream) {
      recDiag('REC_VU_STOP', { preserveStream, hadStream }, {
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_VU_STOP : undefined,
        extraData: preserveStream ? 1 : 0
      });
    }
    const barEl = document.getElementById('recordVUMeterBar');
    const peakEl = document.getElementById('recordVUMeterPeak');
    const barElR = document.getElementById('recordVUMeterBarR');
    const peakElR = document.getElementById('recordVUMeterPeakR');
    const clipEl = document.getElementById('recordVUClipIndicator');
    const dbEl = document.getElementById('recordVUMeterDb');
    if (barEl) barEl.style.height = '0%';
    if (peakEl) peakEl.style.display = 'none';
    if (barElR) barElR.style.height = '0%';
    if (peakElR) peakElR.style.display = 'none';
    if (clipEl) {
      clipEl.style.background = 'rgba(239, 68, 68, 0.25)';
      clipEl.style.boxShadow = 'none';
    }
    if (dbEl) dbEl.textContent = '-∞';
    resetPreRecTapTest();
    setVUMeterGrayedOut(true);
  }

  if (recordDeviceSelect) {
    recordDeviceSelect.addEventListener('change', () => {
      userManuallySelectedDeviceId = recordDeviceSelect.value || null;
      const optText = (recordDeviceSelect.selectedOptions && recordDeviceSelect.selectedOptions[0])
        ? recordDeviceSelect.selectedOptions[0].textContent
        : '';
      const rawLabel = getSelectedDeviceRawLabel();
      initAutoGainDefault();
      populateChannelSelectOptions({
        streamChannels: 1,
        maxCapChannels: classifyInputDeviceLabel(rawLabel).isUsb ? 2 : 1,
        deviceLabel: rawLabel,
        preserveValue: false
      });
      recDiag('REC_DEVICE_SELECT_CHANGED', {
        deviceIdPrefix: recordDeviceSelect.value ? String(recordDeviceSelect.value).slice(0, 12) : '',
        rawLabel,
        optionText: optText
      }, { forcePersist: true });
      resetPreRecTapTest();
      startVUMonitor(true);
    });
  }

  if (recordChannelSelect) {
    recordChannelSelect.addEventListener('change', () => {
      const sel = parseChannelSelection(recordChannelSelect.value);
      const rawLabel = getSelectedDeviceRawLabel();
      saveChannelSelectionPref(rawLabel, sel.raw);

      // If user picks Input 2+ or a Stereo pair while OS Auto Gain was manually forced ON, disable Auto Gain so OS doesn't downmix to mono
      let mustRestartStream = false;
      if (sel.neededChannels > 1 && recordAutoGain && recordAutoGain.checked) {
        recordAutoGain.checked = false;
        if (recordAutoGainBadge) recordAutoGainBadge.textContent = 'AUTO (MULTI-CH OFF)';
        showToast('Disabled Auto Gain to preserve discrete multi-channel USB inputs.', 'info', 3500);
        mustRestartStream = true;
      }

      if (vuStream && sel.neededChannels > getStreamActualChannels(vuStream)) {
        mustRestartStream = true;
      }

      recDiag('REC_CHANNEL_SELECT_CHANGED', {
        selection: sel,
        deviceLabel: rawLabel,
        currentStreamCh: vuStream ? getStreamActualChannels(vuStream) : 0,
        mustRestartStream
      }, { forcePersist: true });

      vuFastEnv = 0;
      vuFastEnvR = 0;
      vuPeakHold = 0;
      vuPeakHoldR = 0;
      resetPreRecTapTest();
      updatePeakSensitivityUI();
      updateChannelStatusBadge();

      if (mustRestartStream) {
        startVUMonitor(true);
      }
    });
  }

  function renderHudSyncBeads(count = 4) {
    const n = Math.max(1, Math.min(16, count | 0));
    if (!hudClickBeads) return [];
    hudClickBeads.innerHTML = '';
    if (n > 8) {
      hudClickBeads.setAttribute('data-compact', 'true');
    } else {
      hudClickBeads.removeAttribute('data-compact');
    }
    const els = [];
    for (let i = 0; i < n; i++) {
      const span = document.createElement('span');
      span.className = 'click-bead';
      span.dataset.beadIndex = String(i);
      span.textContent = String(i + 1);
      hudClickBeads.appendChild(span);
      els.push(span);
    }
    return els;
  }

  function getHudBeadElements() {
    if (!hudClickBeads) return [];
    return Array.from(hudClickBeads.querySelectorAll('.click-bead'));
  }

  function clearHudSyncFeedback() {
    if (recordingHUD) {
      recordingHUD.classList.remove('sync-warning', 'sync-locked');
    }
    if (hudLiveAlert) {
      hudLiveAlert.textContent = '';
    }
  }

  function setHudSyncWarning(message, announce = false) {
    if (recordingHUD) {
      recordingHUD.classList.remove('sync-locked');
      recordingHUD.classList.add('sync-warning');
    }
    if (hudRecStatusText) {
      hudRecStatusText.textContent = '⚠️ SYNC WARNING';
    }
    if (hudInstruction && message) {
      hudInstruction.textContent = message;
    }
    if (announce && hudLiveAlert && message) {
      hudLiveAlert.textContent = message;
    }
  }

  function resetClickBeads(count = 4) {
    clearHudSyncFeedback();
    renderHudSyncBeads(count);
  }

  // High-precision transient peak finder with support for claimed beat exclusion
  function findTransientPeak(pcm, start, end, excludedRanges = []) {
    const s0 = Math.max(0, start);
    const s1 = Math.min(pcm.length, end);
    let bestIdx = -1;
    let maxMetric = -1;
    let peakAbs = 0;
    let sumSq = 0;
    let validCount = 0;

    function isExcluded(idx) {
      if (!excludedRanges || excludedRanges.length === 0) return false;
      for (let i = 0; i < excludedRanges.length; i++) {
        const r = excludedRanges[i];
        if (idx >= r.start && idx <= r.end) return true;
      }
      return false;
    }

    for (let s = s0; s < s1; s++) {
      const v = pcm[s];
      const amp = Math.abs(v);
      sumSq += v * v;
      if (isExcluded(s)) continue;
      validCount++;
      const diff = s > 0 ? Math.abs(v - pcm[s - 1]) : 0;
      const metric = amp * 0.65 + diff * 0.35;
      if (metric > maxMetric) {
        maxMetric = metric;
        bestIdx = s;
        peakAbs = amp;
      }
    }
    const rms = Math.sqrt(sumSq / Math.max(1, s1 - s0)) || 1e-9;
    return {
      idx: bestIdx >= 0 ? bestIdx : s0,
      peakAbs: bestIdx >= 0 ? peakAbs : 0,
      crest: (bestIdx >= 0 && rms > 0) ? (peakAbs / rms) : 0,
      found: bestIdx >= 0
    };
  }

  /**
   * Extracts prominent, refractory-separated transient candidates from raw PCM
   * for global multi-beat rhythmic sequence locking.
   */
  function extractTapCandidates(pcm, sampleRate, s0, s1, minPeakLinear) {
    const start = Math.max(0, Math.floor(s0));
    const end = Math.min(pcm.length, Math.ceil(s1));
    if (end - start < 32) return [];

    const blockLen = Math.max(16, Math.round(0.008 * sampleRate)); // 8ms analysis blocks
    const numBlocks = Math.ceil((end - start) / blockLen);
    const bPeaks = new Float32Array(numBlocks);
    const bPeakIdx = new Int32Array(numBlocks);
    const bRms = new Float32Array(numBlocks);
    const bDiff = new Float32Array(numBlocks);

    for (let b = 0; b < numBlocks; b++) {
      const bs = start + b * blockLen;
      const be = Math.min(end, bs + blockLen);
      let pk = 0;
      let pkIdx = bs;
      let sq = 0;
      let md = 0;
      for (let i = bs; i < be; i++) {
        const v = pcm[i];
        const a = Math.abs(v);
        if (a > pk) { pk = a; pkIdx = i; }
        sq += v * v;
        if (i > start) {
          const d = Math.abs(v - pcm[i - 1]);
          if (d > md) md = d;
        }
      }
      bPeaks[b] = pk;
      bPeakIdx[b] = pkIdx;
      bRms[b] = Math.sqrt(sq / Math.max(1, be - bs));
      bDiff[b] = md;
    }

    // Estimate ambient noise floor from lower quartile of block RMS
    const sortedRms = Array.from(bRms).sort((a, b) => a - b);
    let ambient = sortedRms[Math.floor(sortedRms.length * 0.25)] || 0.001;
    ambient = Math.max(0.0005, Math.min(ambient, minPeakLinear * 0.45));

    const onsetRatio = getPeakOnsetRatio();
    const rawHits = [];
    for (let b = 0; b < numBlocks; b++) {
      const pk = bPeaks[b];
      const md = bDiff[b];
      if (pk < minPeakLinear) {
        ambient = 0.94 * ambient + 0.06 * bRms[b];
        continue;
      }
      const prevPk = b > 0 ? bPeaks[b - 1] : 0;
      const nextPk = b + 1 < numBlocks ? bPeaks[b + 1] : 0;
      // Local maximum block or sharp rising edge above threshold
      if (pk >= prevPk && pk >= nextPk * 0.92 && (pk >= ambient * onsetRatio || md >= minPeakLinear * 0.14)) {
        const refineRadius = Math.round(0.018 * sampleRate);
        const rs = Math.max(start, bPeakIdx[b] - refineRadius);
        const re = Math.min(end, bPeakIdx[b] + refineRadius);
        let bestSample = bPeakIdx[b];
        let bestMetric = -1;
        let bestAbs = pk;
        for (let i = rs; i < re; i++) {
          const a = Math.abs(pcm[i]);
          const d = i > 0 ? Math.abs(pcm[i] - pcm[i - 1]) : 0;
          const m = a * 0.70 + d * 0.30;
          if (m > bestMetric) {
            bestMetric = m;
            bestSample = i;
            bestAbs = a;
          }
        }
        rawHits.push({
          idx: bestSample,
          sec: bestSample / sampleRate,
          peakAbs: bestAbs,
          metric: bestMetric,
          prominence: bestAbs / Math.max(0.0005, ambient)
        });
      }
    }

    // Refractory merge (135ms): keep strongest transient within each tap's physical decay
    const refractSamples = Math.round(0.135 * sampleRate);
    const merged = [];
    for (let i = 0; i < rawHits.length; i++) {
      const h = rawHits[i];
      if (merged.length === 0) {
        merged.push(h);
      } else {
        const prev = merged[merged.length - 1];
        if (h.idx - prev.idx < refractSamples) {
          if (h.metric > prev.metric) {
            merged[merged.length - 1] = h;
          }
        } else {
          merged.push(h);
        }
      }
    }

    // Cap to top 32 candidates by amplitude, then restore chronological order
    if (merged.length > 32) {
      merged.sort((a, b) => b.peakAbs - a.peakAbs);
      merged.length = 32;
      merged.sort((a, b) => a.idx - b.idx);
    }
    return merged;
  }

  /**
   * Finds the globally optimal rhythmic sequence of `numBeats` tap peaks near `expFirstSec` with beat spacing ~`dt`.
   * Immune to early room/handling bumps and greedy first-beat mislocks.
   */
  function findBestTapSequence(pcm, sampleRate, expFirstSec, dt, numBeats, thresholdLinear) {
    const winStartSec = Math.max(0, expFirstSec - 1.40 * dt);
    const winEndSec = Math.min(pcm.length / sampleRate, expFirstSec + (numBeats + 1.85) * dt);
    const s0 = Math.round(winStartSec * sampleRate);
    const s1 = Math.round(winEndSec * sampleRate);
    if (s1 - s0 < Math.round(0.1 * sampleRate)) return { peaksSec: [], peaksIdx: [], candidatesCount: 0 };

    // Try user sensitivity threshold first, then a 0.60x soft-tap fallback (still well above noise floor)
    const multipliers = [1.0, 0.60];
    for (let mIdx = 0; mIdx < multipliers.length; mIdx++) {
      const effThresh = Math.max(0.005, thresholdLinear * multipliers[mIdx]);
      const cands = extractTapCandidates(pcm, sampleRate, s0, s1, effThresh);
      if (cands.length < numBeats) continue;

      if (numBeats === 1) {
        let best = null;
        let bestScore = -1e9;
        for (const c of cands) {
          const distBeats = Math.abs(c.sec - expFirstSec) / dt;
          if (distBeats > 1.5) continue;
          const sc = Math.log10(Math.max(1e-4, c.peakAbs)) * 2.0 - distBeats * 0.35;
          if (sc > bestScore) { bestScore = sc; best = c; }
        }
        if (best) return { peaksSec: [best.sec], peaksIdx: [best.idx], candidatesCount: cands.length };
        continue;
      }

      const minStep = 0.48 * dt;
      const maxStep = 1.65 * dt;
      const firstMinSec = Math.max(0, expFirstSec - 1.35 * dt);
      const firstMaxSec = expFirstSec + 2.20 * dt;

      let bestSeq = null;
      let bestScore = -1e9;
      const seq = new Array(numBeats);

      function evaluateSeq() {
        let sumAmpDb = 0;
        let minAmp = 1e9;
        let maxAmp = 0;
        let sumStep = 0;
        const steps = [];
        for (let k = 0; k < numBeats; k++) {
          const a = seq[k].peakAbs;
          sumAmpDb += 20 * Math.log10(Math.max(1e-4, a));
          if (a < minAmp) minAmp = a;
          if (a > maxAmp) maxAmp = a;
          if (k > 0) {
            const st = seq[k].sec - seq[k - 1].sec;
            steps.push(st);
            sumStep += st;
          }
        }
        const meanStep = sumStep / steps.length;
        let stepVar = 0;
        for (let i = 0; i < steps.length; i++) {
          const diff = steps[i] - meanStep;
          stepVar += diff * diff;
        }
        const relJitter = Math.sqrt(stepVar / steps.length) / Math.max(0.05, meanStep);
        const tempoErr = Math.abs(meanStep - dt) / dt;
        const ampSpreadDb = 20 * Math.log10(Math.max(1, maxAmp / Math.max(1e-4, minAmp)));
        const meanAmpDb = sumAmpDb / numBeats; // e.g., -6 dB for strong taps vs -32 dB for handling noise
        const anchorDist = Math.abs(seq[0].sec - expFirstSec) / dt;

        // Higher amplitude, tight rhythm regularity, consistent tap strength, and proximity to expected Beat 5
        const score =
          (meanAmpDb * 0.35) -
          (relJitter * 14.0) -
          (tempoErr * 4.5) -
          (Math.max(0, ampSpreadDb - 4.0) * 0.22) -
          (anchorDist * 0.25);

        if (score > bestScore) {
          bestScore = score;
          bestSeq = seq.slice();
        }
      }

      let dfsVisits = 0;
      const maxDfsVisits = 12000;
      function dfs(depth) {
        if (dfsVisits >= maxDfsVisits) return;
        dfsVisits++;
        if (depth === numBeats) {
          evaluateSeq();
          return;
        }
        const prev = seq[depth - 1];
        const prevStep = depth >= 2 ? (seq[depth - 1].sec - seq[depth - 2].sec) : null;
        for (let i = 0; i < cands.length; i++) {
          if (dfsVisits >= maxDfsVisits) break;
          const c = cands[i];
          if (c.idx <= prev.idx) continue;
          const step = c.sec - prev.sec;
          if (step < minStep) continue;
          if (step > maxStep) break;
          if (prevStep !== null && Math.abs(step - prevStep) > 0.36 * Math.max(step, prevStep)) continue;
          seq[depth] = c;
          dfs(depth + 1);
        }
      }

      for (let i = 0; i < cands.length; i++) {
        if (dfsVisits >= maxDfsVisits) break;
        const c0 = cands[i];
        if (c0.sec < firstMinSec || c0.sec > firstMaxSec) continue;
        seq[0] = c0;
        dfs(1);
      }

      if (bestSeq && bestSeq.length === numBeats) {
        return {
          peaksSec: bestSeq.map(c => c.sec),
          peaksIdx: bestSeq.map(c => c.idx),
          candidatesCount: cands.length
        };
      }
    }

    return { peaksSec: [], peaksIdx: [], candidatesCount: 0 };
  }

  /**
   * Unified tap-peak detector shared across BOTH NANOdaw Sync modes (Track Sync & Metronome Synth Beats)
   * and across BOTH early live verification and stop-time alignment.
   */
  function detectSyncTapPeaks(pcm, sampleRate, expFirstSec, dt, numBeats, thresholdLinear) {
    const seqRes = findBestTapSequence(pcm, sampleRate, expFirstSec, dt, numBeats, thresholdLinear);
    if (seqRes.peaksSec.length === numBeats) {
      return {
        peaksSec: seqRes.peaksSec.slice(),
        candidatesCount: seqRes.candidatesCount,
        method: 'sequence_lock'
      };
    }

    // Fallback: anchored claimed-range transient search respecting user sensitivity threshold
    const peaksSec = [];
    const claimedRanges = [];
    const exclRadius = Math.round(0.25 * dt * sampleRate);
    const fallbackMinPeak = Math.max(0.006, thresholdLinear * 0.60);
    let lastPeakSample = null;

    for (let k = 0; k < numBeats; k++) {
      let s0, s1;
      if (lastPeakSample === null) {
        s0 = Math.max(0, Math.round((expFirstSec - 0.75 * dt) * sampleRate));
        s1 = Math.min(pcm.length, Math.round((expFirstSec + 1.25 * dt) * sampleRate));
      } else {
        const center = lastPeakSample + Math.round(dt * sampleRate);
        s0 = Math.max(lastPeakSample + Math.round(0.38 * dt * sampleRate), center - Math.round(0.45 * dt * sampleRate));
        s1 = Math.min(pcm.length, center + Math.round(0.45 * dt * sampleRate));
      }
      if (s0 >= s1) continue;

      const pk = findTransientPeak(pcm, s0, s1, claimedRanges);
      if (pk.found && pk.peakAbs >= fallbackMinPeak && pk.crest >= 1.75) {
        peaksSec.push(pk.idx / sampleRate);
        lastPeakSample = pk.idx;
        claimedRanges.push({
          start: Math.max(0, pk.idx - exclRadius),
          end: Math.min(pcm.length - 1, pk.idx + exclRadius)
        });
      }
    }

    return {
      peaksSec,
      candidatesCount: seqRes.candidatesCount,
      method: 'anchored_fallback'
    };
  }

  function playSynthBeep(time, freq = 900, dur = 0.08, destNode = null, volume = 0.8) {
    if (!recAudioCtx) return null;
    try {
      const osc = recAudioCtx.createOscillator();
      const g = recAudioCtx.createGain();
      osc.type = 'triangle'; // Richer harmonics than sine, clearly audible on mobile phone speakers
      const playTime = Math.max(recAudioCtx.currentTime, time);
      osc.frequency.setValueAtTime(freq, playTime);
      const startGain = Math.max(0.0001, volume);
      g.gain.setValueAtTime(startGain, playTime);
      g.gain.exponentialRampToValueAtTime(0.0001, playTime + dur);
      osc.connect(g);
      g.connect(destNode || recAudioCtx.destination);
      osc.start(playTime);
      osc.stop(playTime + dur + 0.02);
      return osc;
    } catch (e) {
      console.warn('Synth beep error:', e);
      return null;
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

  function clearActiveSyncTimers() {
    if (activeSyncSession && Array.isArray(activeSyncSession.scheduledTimerIds)) {
      for (const tid of activeSyncSession.scheduledTimerIds) {
        clearTimeout(tid);
      }
      activeSyncSession.scheduledTimerIds = [];
    }
  }

  function cleanupRecordingNodes() {
    stopRecordingWatchdog();
    stopLiveMetronome();
    clearActiveSyncTimers();
    clearHudSyncFeedback();
    if (recDiagCleanupTrackListeners) {
      try { recDiagCleanupTrackListeners(); } catch (_) {}
      recDiagCleanupTrackListeners = null;
    }
    if (hudLatencyText) {
      hudLatencyText.textContent = '';
      hudLatencyText.style.display = 'none';
    }
    if (hudTimerIntervalId) {
      clearInterval(hudTimerIntervalId);
      hudTimerIntervalId = null;
    }

    if (recWorkletNode) {
      try {
        recWorkletNode.port.postMessage({ type: 'set_config', isRecording: false, detectTransients: false });
        recWorkletNode.disconnect();
      } catch (_) {}
      recWorkletNode = null;
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
    if (btnStartRecordingAction) {
      btnStartRecordingAction.textContent = 'Start Recording';
      btnStartRecordingAction.disabled = false;
    }
    isRecording = false;
    recordingState = 'idle';
    setTransportRecordingUI(false);
    pass2StreamStartTime = null;
    pass2DownbeatScheduledTime = null;
    activeSyncSession = null;

    audio.isRecording = false;
    audio.isRecordingMode = false;
    audio.setPlaybackAudioSession();
  }

  function cancelRecording(reason = 'user_cancelled') {
    recDiag('REC_CANCELLED', {
      reason,
      recordingState,
      capturedSamples: totalPass2Samples,
      chunksTotal: recChunksReceivedTotal
    }, { level: 'warn', forcePersist: true });
    if (window.zoomProfiler && typeof window.zoomProfiler.endRecSession === 'function') {
      window.zoomProfiler.endRecSession('cancelled', { reason, capturedSamples: totalPass2Samples });
    }
    audio.isRecording = false;
    audio.isRecordingMode = false;
    audio.setPlaybackAudioSession();
    audio.stop();
    if (btnStartRecordingAction) {
      btnStartRecordingAction.textContent = 'Start Recording';
      btnStartRecordingAction.disabled = false;
    }
    cleanupRecordingNodes();
    showToast('Recording cancelled', 'info');
  }

  /**
   * Resolves the N reference sync beat timeline timestamps (in seconds) for a Guide Track.
   * Shared by both live early-warning verification and stop-time alignment.
   */
  async function resolveGuideSyncTimelinePeaks(guideIdx, firstBeat, numBeats, fallbackTempo, startPlayhead) {
    const guideTrack = audio.tracks[guideIdx];
    if (!guideTrack) {
      return { ok: false, peaksTimelineSec: [], tempo: fallbackTempo, dt: 60 / fallbackTempo, guideName: 'Guide' };
    }
    const guideName = guideTrack.name || 'Guide';
    const guideOffset = Number(guideTrack.offset) || 0;
    const guideIsMetro = Boolean(
      guideTrack.isMetronome ||
      state.project?.tracks?.[guideIdx]?.isMetronome ||
      /^metronome/i.test(guideName)
    );
    const tempo = guideTrack.tempo || state.project?.tracks?.[guideIdx]?.tempo || state.project?.tempo || state.project?.bpm || fallbackTempo || 90;
    const dt = 60 / Math.max(30, tempo);

    if (guideIsMetro) {
      const peaksTimelineSec = [];
      const startBeatIdx = Math.max(0, Math.ceil((startPlayhead - guideOffset - 0.02) / dt));
      for (let k = 0; k < numBeats; k++) {
        const beatIdx = startBeatIdx + (firstBeat - 1) + k;
        peaksTimelineSec.push(guideOffset + beatIdx * dt);
      }
      return { ok: peaksTimelineSec.length === numBeats, peaksTimelineSec, tempo, dt, guideName, guideIsMetro: true };
    }

    let guideBuffer = null;
    try {
      guideBuffer = await audio.getTrackAudioBuffer(guideIdx);
    } catch (e) {
      console.warn('Could not load guide track audio buffer for sync:', e);
    }
    if (!guideBuffer) {
      return { ok: false, peaksTimelineSec: [], tempo, dt, guideName, guideIsMetro: false };
    }

    const guidePCM = guideBuffer.numberOfChannels > 1
      ? combineStereoForPeakDetection(guideBuffer.getChannelData(0), guideBuffer.getChannelData(1))
      : guideBuffer.getChannelData(0);
    const guideSR = guideBuffer.sampleRate;
    const peaksTimelineSec = [];

    const expGuideFirstSec = Math.max(0, (startPlayhead + (firstBeat - 1) * dt) - guideOffset);
    const guideSeq = findBestTapSequence(guidePCM, guideSR, expGuideFirstSec, dt, numBeats, Math.min(0.025, getPeakThresholdLinear() * 0.6));
    if (guideSeq.peaksSec.length === numBeats) {
      for (let k = 0; k < numBeats; k++) {
        peaksTimelineSec.push(guideOffset + guideSeq.peaksSec[k]);
      }
    } else {
      const guideClaimedRanges = [];
      const exclRadiusGuide = Math.round(0.25 * dt * guideSR);
      const searchWinSecGuide = 0.70 * dt;
      let lastMetroPeakSample = null;
      for (let k = 0; k < numBeats; k++) {
        let s0, s1;
        if (lastMetroPeakSample === null) {
          const expTimelineSec = startPlayhead + (firstBeat - 1) * dt;
          const expGuideRelSec = expTimelineSec - guideOffset;
          if (expGuideRelSec < -0.2 || expGuideRelSec > guideBuffer.duration + 0.2) continue;
          s0 = Math.max(0, Math.round((expGuideRelSec - searchWinSecGuide) * guideSR));
          s1 = Math.min(guidePCM.length, Math.round((expGuideRelSec + searchWinSecGuide) * guideSR));
        } else {
          const center = lastMetroPeakSample + Math.round(dt * guideSR);
          s0 = Math.max(lastMetroPeakSample + Math.round(0.35 * dt * guideSR), center - Math.round(0.45 * dt * guideSR));
          s1 = Math.min(guidePCM.length, center + Math.round(0.45 * dt * guideSR));
        }
        if (s0 >= s1) continue;

        const pk = findTransientPeak(guidePCM, s0, s1, guideClaimedRanges);
        if (pk.found && pk.peakAbs >= 0.008 && pk.crest >= 1.2) {
          peaksTimelineSec.push(guideOffset + (pk.idx / guideSR));
          lastMetroPeakSample = pk.idx;
          guideClaimedRanges.push({
            start: Math.max(0, pk.idx - exclRadiusGuide),
            end: Math.min(guidePCM.length - 1, pk.idx + exclRadiusGuide)
          });
        }
      }
    }

    return { ok: peaksTimelineSec.length === numBeats, peaksTimelineSec, tempo, dt, guideName, guideIsMetro: false };
  }

  /**
   * Unified Single-Pass NANOdaw Sync Recording Flow.
   * Handles BOTH:
   *  - mode === 'track': Backing Track / Metronome Sync (with a Guide Track)
   *  - mode === 'synth': Metronome Synth Beats (just-in-time metronome, no guide track required;
   *    records F + N - 1 pre-take beats for peak sync, then begins real take at downbeat of F + N)
   * Includes live per-beat and post-sync-window early warnings for missed peaks.
   */
  async function startNanodawSyncRecording({ mode, guideTrackIdx = null }) {
    const firstBeat = Math.max(1, Math.min(64, parseInt(syncTrackFirstBeat?.value, 10) || 5));
    const numBeats = Math.max(1, Math.min(16, parseInt(syncTrackNumBeats?.value, 10) || 4));
    const preTakeBeats = (firstBeat - 1) + numBeats;
    const synthTempoInput = Math.max(40, Math.min(240, parseInt(syncSynthTempo?.value, 10) || state.project?.tempo || 90));

    let tempo = synthTempoInput;
    let dt = 60 / tempo;
    let guideName = 'Synth Metronome';
    let refTimelineSec = [];
    let guideMissingError = null;

    if (mode === 'track') {
      const guideRes = await resolveGuideSyncTimelinePeaks(guideTrackIdx, firstBeat, numBeats, synthTempoInput, recordingStartPlayhead);
      if (!isRecording) return;
      tempo = guideRes.tempo;
      dt = guideRes.dt;
      guideName = guideRes.guideName;
      refTimelineSec = guideRes.peaksTimelineSec;
      if (!guideRes.ok) {
        guideMissingError = `⚠️ Guide "${guideName}" has ${refTimelineSec.length}/${numBeats} beats at beats ${firstBeat}–${firstBeat + numBeats - 1}! Stop & choose a rhythmic guide.`;
      }
    } else {
      // Option 2 (Metronome Synth Beats): beat F + N coincides with recordingStartPlayhead,
      // so sync beat k (0..N-1) corresponds to virtual timeline position recordingStartPlayhead - (N - k) * dt.
      for (let k = 0; k < numBeats; k++) {
        refTimelineSec.push(recordingStartPlayhead - (numBeats - k) * dt);
      }
    }

    detectedIntervalSec = dt;

    pass2AudioStore.reset();
    pass2AudioStore.prepareAheadOfTime(4);
    pass2AudioStoreR.reset();
    if (activeRecordingChannelConfig && activeRecordingChannelConfig.mode === 'stereo') {
      pass2AudioStoreR.prepareAheadOfTime(4);
    }
    pass2ClickEvents = [];
    totalPass2Samples = 0;
    pass2StreamStartTime = recAudioCtx ? recAudioCtx.currentTime : null;
    pass2DownbeatScheduledTime = null;
    recordingState = (mode === 'synth') ? 'sync_preroll' : 'recording_take';

    const beadEls = resetClickBeads(numBeats);
    if (hudClickBeads) {
      hudClickBeads.classList.remove('hidden');
      hudClickBeads.style.display = 'flex';
    }
    if (hudLatencyText) {
      hudLatencyText.textContent = '';
      hudLatencyText.style.display = 'none';
    }

    const session = {
      mode,
      guideTrackIdx: mode === 'track' ? guideTrackIdx : null,
      guideName,
      tempo,
      dt,
      firstBeat,
      numBeats,
      preTakeBeats,
      streamStartTime: pass2StreamStartTime || 0,
      beat1CtxTime: 0,
      downbeatCtxTime: null,
      expSyncBufferSec: new Array(numBeats).fill(0),
      refTimelineSec,
      guideMissingError,
      liveTapMatched: new Array(numBeats).fill(false),
      liveTapTimesSec: [],
      warnedMissedBeat: false,
      earlyVerifiedResult: null,
      scheduledTimerIds: []
    };
    activeSyncSession = session;

    const scheduleSessionTimer = (fn, delayMs) => {
      const tid = setTimeout(() => {
        if (!isRecording || activeSyncSession !== session) return;
        fn();
      }, Math.max(0, delayMs));
      session.scheduledTimerIds.push(tid);
      return tid;
    };

    const markBeadMatched = (beatIdx) => {
      session.liveTapMatched[beatIdx] = true;
      const bEl = beadEls[beatIdx];
      if (bEl) {
        bEl.className = 'click-bead active';
        bEl.textContent = String(beatIdx + 1);
      }
    };

    const markBeadMissed = (beatIdx) => {
      const bEl = beadEls[beatIdx];
      if (bEl && !session.liveTapMatched[beatIdx]) {
        bEl.className = 'click-bead missed';
        bEl.textContent = '!';
      }
    };

    await attachRecordingPipeline({
      detectTransients: true,
      targetStore: pass2AudioStore,
      targetStoreR: pass2AudioStoreR,
      onTransient: (now, samplePos) => {
        if (!isRecording || activeSyncSession !== session) return;
        const sr = recAudioCtx ? recAudioCtx.sampleRate : 44100;
        const secInBuf = samplePos / sr;
        const firstExp = session.expSyncBufferSec[0] || 0;
        const lastExp = session.expSyncBufferSec[numBeats - 1] || (firstExp + (numBeats - 1) * dt);
        if (secInBuf < Math.max(0, firstExp - 0.65 * dt)) return;
        if (secInBuf > lastExp + 1.45 * dt + 0.35) return;

        pass2ClickEvents.push({ ctxTime: now, samplePos });
        session.liveTapTimesSec.push(secInBuf);

        // Match transient to nearest unmatched sync beat within generous hardware-latency window
        let bestK = -1;
        let bestDist = Infinity;
        for (let k = 0; k < numBeats; k++) {
          if (session.liveTapMatched[k]) continue;
          const expK = session.expSyncBufferSec[k];
          const minK = expK - 0.42 * dt;
          const maxK = expK + 0.68 * dt + 0.25;
          if (secInBuf >= minK && secInBuf <= maxK) {
            // Bias slightly toward causal (+latency) arrival after the beat
            const delta = secInBuf - expK;
            const dist = Math.abs(delta - 0.06);
            if (dist < bestDist) {
              bestDist = dist;
              bestK = k;
            }
          }
        }
        if (bestK >= 0) {
          markBeadMatched(bestK);
        }
        recDiag('REC_NANODAW_SYNC_LIVE_TAP', {
          mode,
          matchedBeatIdx: bestK,
          secInBuf: Number(secInBuf.toFixed(3)),
          samplePos
        });
      }
    });

    window.__nanodaw_stream = recStream;
    window.__nanodaw_mic = recMicSource;

    const nowAfterAttach = recAudioCtx ? recAudioCtx.currentTime : 0;
    if (pass2StreamStartTime === null) {
      pass2StreamStartTime = nowAfterAttach;
    }
    session.streamStartTime = pass2StreamStartTime;

    if (mode === 'track') {
      session.beat1CtxTime = nowAfterAttach;
      for (let k = 0; k < numBeats; k++) {
        session.expSyncBufferSec[k] = refTimelineSec[k] !== undefined
          ? Math.max(0, refTimelineSec[k] - recordingStartPlayhead)
          : ((firstBeat - 1) + k) * dt;
      }

      if (hudRecStatusText) hudRecStatusText.textContent = 'TRACK SYNC';
      if (hudInstruction) {
        hudInstruction.textContent = firstBeat > 1
          ? `Sync with "${guideName}": wait beats 1–${firstBeat - 1}, tap beats ${firstBeat}–${firstBeat + numBeats - 1}...`
          : `Sync with "${guideName}": tap beats 1–${numBeats} now!`;
      }

      if (Math.abs((audio.playheadPosition || 0) - recordingStartPlayhead) > 0.001) {
        audio.seek(recordingStartPlayhead);
      }
      recDiag('REC_NANODAW_SYNC_BEGIN', {
        mode: 'track',
        guideTrackIdx,
        guideName,
        tempo,
        firstBeat,
        numBeats,
        playhead: recordingStartPlayhead,
        channelConfig: activeRecordingChannelConfig,
        ctx: inspectAudioCtx(recAudioCtx)
      }, {
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_TAKE_START : undefined,
        extraData: guideTrackIdx,
        forcePersist: true
      });
      audio.play();
      takeStartTime = performance.now();
      startHudTimer();

      if (guideMissingError) {
        session.warnedMissedBeat = true;
        setHudSyncWarning(guideMissingError, true);
        showToast(guideMissingError, 'warning', 7000);
      }
    } else {
      // Option 2: Metronome Synth Beats (Just-In-Time Metronome, single-pass, no guide track required)
      const beat1CtxTime = nowAfterAttach + 0.12;
      const downbeatCtxTime = beat1CtxTime + preTakeBeats * dt; // Beat F + N downbeat!
      session.beat1CtxTime = beat1CtxTime;
      session.downbeatCtxTime = downbeatCtxTime;
      pass2DownbeatScheduledTime = downbeatCtxTime;

      for (let k = 0; k < numBeats; k++) {
        session.expSyncBufferSec[k] = Math.max(0, (beat1CtxTime - session.streamStartTime) + ((firstBeat - 1) + k) * dt);
      }

      const takeMetroEnabled = Boolean(syncMetronomeOn && syncMetronomeOn.checked);
      const takeMetroVol = parseDbToLinear(syncMetronomeVolume ? syncMetronomeVolume.value : '0dB');

      // Early beats (1 .. F + N - 1) ALWAYS play the just-in-time metronome;
      // from beat F + N onwards, metronome continues ONLY if takeMetroEnabled is true (at takeMetroVol).
      startLiveMetronome(beat1CtxTime, tempo, takeMetroVol, {
        preTakeBeats,
        firstSyncBeatIdx: firstBeat - 1,
        takeEnabled: takeMetroEnabled
      });

      // Start any existing project tracks right at the Beat F + N downbeat (recordingStartPlayhead)!
      if (audio.tracks && audio.tracks.length > 0) {
        if (Math.abs((audio.playheadPosition || 0) - recordingStartPlayhead) > 0.001) {
          audio.seek(recordingStartPlayhead);
        }
        audio.play(downbeatCtxTime);
      }

      if (hudRecStatusText) {
        hudRecStatusText.textContent = firstBeat > 1 ? 'SYNC COUNT-IN' : 'TAP SYNC BEATS';
      }
      if (hudTimer) {
        hudTimer.textContent = `Beat 1/${preTakeBeats}`;
      }
      if (hudInstruction) {
        hudInstruction.textContent = firstBeat > 1
          ? `Listen beats 1–${firstBeat - 1} (${tempo} BPM), tap beats ${firstBeat}–${preTakeBeats}...`
          : `Tap along on beats 1–${numBeats} (${tempo} BPM)!`;
      }

      recDiag('REC_NANODAW_SYNC_BEGIN', {
        mode: 'synth',
        tempo,
        firstBeat,
        numBeats,
        preTakeBeats,
        takeStartBeat: preTakeBeats + 1,
        takeMetroEnabled,
        playhead: recordingStartPlayhead,
        channelConfig: activeRecordingChannelConfig,
        ctx: inspectAudioCtx(recAudioCtx)
      }, {
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_TAKE_START : undefined,
        forcePersist: true
      });

      // Count-in beat HUD updates prior to First Beat to Sync (beats 1 .. F - 1)
      for (let b = 0; b < firstBeat - 1; b++) {
        const beatCtx = beat1CtxTime + b * dt;
        const delayMs = (beatCtx - (recAudioCtx ? recAudioCtx.currentTime : nowAfterAttach)) * 1000;
        scheduleSessionTimer(() => {
          if (hudTimer && recordingState === 'sync_preroll') {
            hudTimer.textContent = `Beat ${b + 1}/${preTakeBeats}`;
          }
          if (!session.warnedMissedBeat && hudInstruction) {
            hudInstruction.textContent = `Count-in beat ${b + 1} of ${firstBeat - 1} — tap on beats ${firstBeat}–${preTakeBeats}`;
          }
        }, delayMs);
      }

      // Transition to live take recording on the downbeat of Beat F + N!
      const downbeatDelayMs = (downbeatCtxTime - (recAudioCtx ? recAudioCtx.currentTime : nowAfterAttach)) * 1000;
      scheduleSessionTimer(() => {
        recordingState = 'recording_take';
        takeStartTime = performance.now();
        startHudTimer();
        if (!session.warnedMissedBeat) {
          if (hudRecStatusText) hudRecStatusText.textContent = 'RECORDING TAKE';
          if (hudInstruction) hudInstruction.textContent = `Beat ${preTakeBeats + 1} downbeat — recording take!`;
        }
        recDiag('REC_SYNTH_SYNC_TAKE_DOWNBEAT', {
          takeStartBeat: preTakeBeats + 1,
          ctxTime: recAudioCtx ? Number(recAudioCtx.currentTime.toFixed(4)) : null,
          scheduledDownbeatTime: Number(downbeatCtxTime.toFixed(4)),
          prerollSamples: pass2AudioStore.totalSamples
        }, { forcePersist: true });
      }, downbeatDelayMs);
    }

    startRecordingWatchdog();

    // --- Unified Sync Beat Cues & Per-Beat Early Missed-Peak Warnings (shared by BOTH modes) ---
    const refNowCtx = recAudioCtx ? recAudioCtx.currentTime : nowAfterAttach;
    for (let k = 0; k < numBeats; k++) {
      const beatNumber = firstBeat + k;
      const beatStreamTime = session.streamStartTime + session.expSyncBufferSec[k];
      const cueDelayMs = (beatStreamTime - refNowCtx) * 1000;

      scheduleSessionTimer(() => {
        if (mode === 'synth' && recordingState === 'sync_preroll' && hudTimer) {
          hudTimer.textContent = `Sync ${k + 1}/${numBeats}`;
        }
        if (!session.warnedMissedBeat) {
          if (hudRecStatusText && mode === 'synth') hudRecStatusText.textContent = 'TAP SYNC BEATS';
          if (hudInstruction) {
            hudInstruction.textContent = `Tap sync beat ${k + 1} of ${numBeats}! (Beat ${beatNumber})`;
          }
        }
        const bEl = beadEls[k];
        if (bEl && !session.liveTapMatched[k]) {
          bEl.classList.add('beep');
          scheduleSessionTimer(() => {
            if (bEl && !session.liveTapMatched[k] && !bEl.classList.contains('missed')) {
              bEl.classList.remove('beep');
            }
          }, dt * 450);
        }
      }, cueDelayMs);

      // Per-beat early warning check right after beat k's arrival + roundtrip latency window
      const missWindowSec = Math.min(0.88 * dt, 0.52 * dt + 0.24);
      const flushBeforeCheckMs = Math.max(0, ((beatStreamTime + missWindowSec) - refNowCtx) * 1000 - 25);
      scheduleSessionTimer(() => {
        if (!session.liveTapMatched[k] && recWorkletNode) {
          try { recWorkletNode.port.postMessage({ type: 'flush' }); } catch (_) {}
        }
      }, flushBeforeCheckMs);

      const missCheckDelayMs = ((beatStreamTime + missWindowSec) - refNowCtx) * 1000;
      scheduleSessionTimer(() => {
        if (session.guideMissingError) return;
        if (!session.liveTapMatched[k]) {
          // Double-check the actual captured PCM slice around beat k before warning (avoids false alarms)
          const sr = recAudioCtx ? recAudioCtx.sampleRate : 44100;
          const expK = session.expSyncBufferSec[k];
          const s0 = Math.max(0, Math.round((expK - 0.38 * dt) * sr));
          const s1 = Math.min(pass2AudioStore.totalSamples, Math.round((expK + 0.65 * dt + 0.24) * sr));
          if (s1 > s0 + 32) {
            const subL = pass2AudioStore.toFlatArray(s0, s1);
            const isSt = (activeRecordingChannelConfig && activeRecordingChannelConfig.mode === 'stereo' && pass2AudioStoreR.totalSamples >= s1);
            const subPCM = isSt ? combineStereoForPeakDetection(subL, pass2AudioStoreR.toFlatArray(s0, s1)) : subL;
            const minPk = Math.max(0.006, getPeakThresholdLinear() * 0.60);
            const pk = findTransientPeak(subPCM, 0, subPCM.length);
            if (pk.found && pk.peakAbs >= minPk && pk.crest >= 1.75) {
              markBeadMatched(k);
              return;
            }
          }

          markBeadMissed(k);
          const heardSoFar = session.liveTapMatched.slice(0, k + 1).filter(Boolean).length;
          const warnMsg = `⚠️ Missed peak on beat ${beatNumber} (${heardSoFar}/${k + 1} heard) — Stop to retry!`;
          const firstWarning = !session.warnedMissedBeat;
          session.warnedMissedBeat = true;
          setHudSyncWarning(warnMsg, firstWarning);
          if (firstWarning) {
            showToast(`⚠️ Missed sync tap on beat ${beatNumber}! Stop now to retry or lower threshold.`, 'warning', 5500);
          }
          recDiag('REC_SYNC_EARLY_BEAT_MISSED', {
            mode,
            missedBeatNumber: beatNumber,
            syncIndex: k,
            heardSoFar,
            peakSensDb
          }, { level: 'warn', forcePersist: true });
        }
      }, missCheckDelayMs);
    }

    // --- Authoritative Post-Sync-Window Verification on Raw Captured PCM ---
    const lastSyncStreamSec = session.streamStartTime + (session.expSyncBufferSec[numBeats - 1] || ((preTakeBeats - 1) * dt));
    const postVerifyWaitSec = Math.max(0.40, 0.68 * dt + 0.22);
    const verifyFlushDelayMs = Math.max(0, ((lastSyncStreamSec + postVerifyWaitSec) - refNowCtx) * 1000 - 30);
    scheduleSessionTimer(() => {
      if (recWorkletNode) {
        try { recWorkletNode.port.postMessage({ type: 'flush' }); } catch (_) {}
      }
    }, verifyFlushDelayMs);

    const verifyDelayMs = ((lastSyncStreamSec + postVerifyWaitSec) - refNowCtx) * 1000;
    scheduleSessionTimer(() => {
      if (recWorkletNode) {
        try { recWorkletNode.port.postMessage({ type: 'set_config', detectTransients: false }); } catch (_) {}
      }
      if (session.guideMissingError) return;

      const sr = recAudioCtx ? recAudioCtx.sampleRate : 44100;
      const expFirstSec = session.expSyncBufferSec[0] || 0;
      const maxWindowSample = Math.min(
        pass2AudioStore.totalSamples,
        Math.round((expFirstSec + (numBeats + 2.0) * dt) * sr)
      );
      const sliceL = pass2AudioStore.toFlatArray(0, maxWindowSample);
      const isSt = (activeRecordingChannelConfig && activeRecordingChannelConfig.mode === 'stereo' && pass2AudioStoreR.totalSamples > 0);
      const sliceR = isSt ? pass2AudioStoreR.toFlatArray(0, Math.min(maxWindowSample, pass2AudioStoreR.totalSamples)) : null;
      const detectPCM = sliceR ? combineStereoForPeakDetection(sliceL, sliceR) : sliceL;

      const res = detectSyncTapPeaks(detectPCM, sr, expFirstSec, dt, numBeats, getPeakThresholdLinear());
      if (res.peaksSec.length === numBeats) {
        const estLatMs = Math.round((res.peaksSec[0] - expFirstSec) * 1000);
        session.earlyVerifiedResult = {
          ok: true,
          foundCount: numBeats,
          peaksSec: res.peaksSec,
          estLatencyMs: estLatMs,
          reason: null
        };
        session.warnedMissedBeat = false;
        for (let k = 0; k < numBeats; k++) {
          markBeadMatched(k);
        }
        clearHudSyncFeedback();
        if (recordingHUD) recordingHUD.classList.add('sync-locked');
        if (hudRecStatusText) hudRecStatusText.textContent = 'RECORDING TAKE';
        if (hudInstruction) hudInstruction.textContent = `✓ Sync locked (${numBeats}/${numBeats})! Sing or play along...`;
        if (hudLatencyText) {
          hudLatencyText.textContent = `Est. Latency: ${estLatMs >= 0 ? '+' : ''}${estLatMs}ms`;
          hudLatencyText.style.display = 'block';
        }
        scheduleSessionTimer(() => {
          if (recordingHUD) recordingHUD.classList.remove('sync-locked');
          if (hudClickBeads) {
            hudClickBeads.classList.add('hidden');
            hudClickBeads.style.display = 'none';
          }
        }, 1400);
        recDiag('REC_SYNC_EARLY_VERIFY_LOCKED', {
          mode,
          numBeats,
          method: res.method,
          estLatencyMs: estLatMs,
          peaksSec: res.peaksSec.map(v => Number(v.toFixed(4)))
        }, { forcePersist: true });
      } else {
        const foundCount = res.peaksSec.length;
        const failMsg = `⚠️ Sync missed (${foundCount}/${numBeats} peaks detected) — Stop & retry!`;
        session.earlyVerifiedResult = {
          ok: false,
          foundCount,
          peaksSec: res.peaksSec,
          estLatencyMs: null,
          reason: failMsg
        };
        for (let k = 0; k < numBeats; k++) {
          if (!session.liveTapMatched[k]) markBeadMissed(k);
        }
        session.warnedMissedBeat = true;
        setHudSyncWarning(failMsg, true);
        showToast(`⚠️ Sync incomplete: only ${foundCount} of ${numBeats} tap peaks detected! Stop now to retry.`, 'warning', 8000);
        recDiag('REC_SYNC_EARLY_VERIFY_FAILED', {
          mode,
          foundCount,
          numBeats,
          peakSensDb,
          peaksSec: res.peaksSec.map(v => Number(v.toFixed(4)))
        }, { level: 'warn', forcePersist: true });
      }
    }, verifyDelayMs);
  }

  async function startRecordingFlow() {
    if (isRecording) {
      stopRecording();
      return;
    }

    const deviceId = recordDeviceSelect ? recordDeviceSelect.value : '';
    const rawDeviceLabel = getSelectedDeviceRawLabel();
    const selectedOptionText = (recordDeviceSelect && recordDeviceSelect.selectedOptions && recordDeviceSelect.selectedOptions[0])
      ? recordDeviceSelect.selectedOptions[0].textContent
      : rawDeviceLabel;
    activeRecordingChannelConfig = parseChannelSelection(recordChannelSelect ? recordChannelSelect.value : 'mono:0');
    const useNanodawSync = record2PassSync ? record2PassSync.checked : true;
    const isTrackGuide = guideModeTrack ? guideModeTrack.checked : false;
    const selectedGuideTrackIdx = syncGuideTrackSelect ? syncGuideTrackSelect.value : '';
    let useAutoGain = recordAutoGain ? recordAutoGain.checked : (isIOSorIPad() && !classifyInputDeviceLabel(rawDeviceLabel || selectedOptionText).isUsb);
    if (activeRecordingChannelConfig.neededChannels > 1 && useAutoGain) {
      // Never enable WebRTC AutoGain when capturing discrete multi-channel inputs (prevents mono downmixing on Android/Desktop)
      useAutoGain = false;
    }
    const useInternalGain = Boolean(recordInternalGain && recordInternalGain.checked);

    recChunksReceivedTotal = 0;
    recFirstChunkLogged = false;
    lastWorkletDiagReport = null;

    if (window.zoomProfiler && typeof window.zoomProfiler.beginRecSession === 'function') {
      window.zoomProfiler.beginRecSession({
        selectedDeviceIdPrefix: deviceId ? String(deviceId).slice(0, 12) : '',
        selectedDeviceLabel: rawDeviceLabel || selectedOptionText,
        channelSelection: activeRecordingChannelConfig,
        useAutoGain,
        useInternalGain,
        useNanodawSync,
        guideMode: useNanodawSync ? (isTrackGuide ? 'track_sync' : 'synth_beats_sync') : 'no_sync',
        selectedGuideTrackIdx,
        startPlayhead: Number((audio.playheadPosition || 0).toFixed(3)),
        hadPrewarmedStream: Boolean(recStream && recStream.active)
      });
    }

    try {
      // 1. Enter recording mode and switch iOS AudioSession to play-and-record
      audio.isRecordingMode = true;
      audio.isRecording = true;
      audio.setPlayAndRecordAudioSession();
      recordingStartPlayhead = audio.playheadPosition || 0;

      // Clear previous sync lines when a new recording begins
      if (timeline && timeline.clearSyncLines) {
        timeline.clearSyncLines();
      }

      // 2. Obtain master AudioContext and ensure it is active
      recAudioCtx = audio.getOrCreateAudioContext();
      recDiag('REC_FLOW_CTX_OBTAINED', inspectAudioCtx(recAudioCtx), {
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_AUDIO_CTX_INIT : undefined,
        extraData: recAudioCtx ? recAudioCtx.sampleRate : 0,
        forcePersist: true
      });

      if (recAudioCtx.state === 'suspended' || recAudioCtx.state === 'interrupted') {
        const resumeStart = performance.now();
        recDiag('REC_FLOW_CTX_RESUME_START', { stateBefore: recAudioCtx.state }, {
          stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_AUDIO_CTX_RESUME : undefined,
          phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.START : 0,
          forcePersist: true
        });
        await recAudioCtx.resume();
        const resumeDur = Number((performance.now() - resumeStart).toFixed(2));
        recDiag('REC_FLOW_CTX_RESUME_DONE', {
          durationMs: resumeDur,
          ctx: inspectAudioCtx(recAudioCtx)
        }, {
          stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_AUDIO_CTX_RESUME : undefined,
          phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.END : 1,
          duration: resumeDur,
          forcePersist: true
        });
      }
      const targetSampleRate = recAudioCtx ? recAudioCtx.sampleRate : undefined;

      // 3. Acquire mic stream: reuse pre-warmed stream transferred from VU meter monitor if active & has enough channels!
      const hasLiveStream = Boolean(recStream && recStream.active && recStream.getAudioTracks().length > 0 && recStream.getAudioTracks()[0].readyState === 'live');
      const existingCh = hasLiveStream ? getStreamActualChannels(recStream) : 0;
      const isStreamSufficient = hasLiveStream && (existingCh >= activeRecordingChannelConfig.neededChannels);
      if (hasLiveStream && !isStreamSufficient) {
        recDiag('REC_FLOW_STREAM_UPGRADE_NEEDED', {
          existingCh,
          neededChannels: activeRecordingChannelConfig.neededChannels,
          channelSelection: activeRecordingChannelConfig
        }, { forcePersist: true });
        try { recStream.getTracks().forEach(t => t.stop()); } catch (_) {}
        recStream = null;
      }

      if (isStreamSufficient) {
        const streamSpec = inspectMediaStream(recStream);
        const actualSR = streamSpec.tracks?.[0]?.settings?.sampleRate || 0;
        recDiag('REC_FLOW_STREAM_REUSED', {
          stream: streamSpec,
          channelSelection: activeRecordingChannelConfig,
          ctxSampleRate: targetSampleRate,
          sampleRateMismatch: Boolean(actualSR && targetSampleRate && actualSR !== targetSampleRate)
        }, {
          stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_STREAM_REUSED : undefined,
          extraData: actualSR,
          forcePersist: true
        });
      } else {
        recStream = await acquireMultiChannelMicStream({
          deviceId,
          deviceLabel: rawDeviceLabel || selectedOptionText,
          useAutoGain,
          channelSel: activeRecordingChannelConfig,
          targetSampleRate,
          exactDevice: false,
          diagPrefix: 'REC_FLOW_GUM'
        });
      }

      // Attach track-level mute / unmute / ended listeners for live USB disconnect / route-change tracking
      if (recDiagCleanupTrackListeners) {
        try { recDiagCleanupTrackListeners(); } catch (_) {}
      }
      recDiagCleanupTrackListeners = attachStreamTrackListeners(recStream, 'recording');

      const activeStreamSpec = inspectMediaStream(recStream);
      const firstTrackSettings = activeStreamSpec.tracks?.[0]?.settings || {};
      recDiag('REC_TRACK_SETTINGS_SNAPSHOT', {
        trackSettings: firstTrackSettings,
        channelSelection: activeRecordingChannelConfig,
        ctx: inspectAudioCtx(recAudioCtx)
      }, {
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_TRACK_SETTINGS : undefined,
        extraData: firstTrackSettings.sampleRate || 0,
        forcePersist: true
      });

      isRecording = true;
      setTransportRecordingUI(true);
      if (btnRecord) btnRecord.classList.add('recording');
      if (recordingHUD) {
        recordingHUD.classList.remove('hidden');
        recordingHUD.style.display = 'flex';
      }

      if (useNanodawSync) {
        if (isTrackGuide) {
          if (selectedGuideTrackIdx !== '') {
            await startNanodawSyncRecording({ mode: 'track', guideTrackIdx: parseInt(selectedGuideTrackIdx, 10) });
          } else {
            recDiag('REC_ABORT_NO_GUIDE_TRACK', {}, { level: 'warn', forcePersist: true });
            if (window.zoomProfiler && typeof window.zoomProfiler.endRecSession === 'function') {
              window.zoomProfiler.endRecSession('aborted', { reason: 'no_guide_track_selected' });
            }
            audio.isRecording = false;
            audio.isRecordingMode = false;
            audio.setPlaybackAudioSession();
            cleanupRecordingNodes();
            showToast('Please select a guide track, generate a Metronome track, or choose Metronome Synth Beats.', 'warning', 4500);
            return;
          }
        } else {
          await startNanodawSyncRecording({ mode: 'synth' });
        }
      } else {
        await startStandardPrelude();
      }
    } catch (err) {
      console.error('Failed to start recording:', err);
      recDiag('REC_FLOW_FATAL_ERROR', {
        name: err && err.name ? err.name : undefined,
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? String(err.stack).slice(0, 500) : undefined,
        ctx: inspectAudioCtx(recAudioCtx)
      }, {
        level: 'error',
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_ERROR : undefined,
        forcePersist: true
      });
      if (window.zoomProfiler && typeof window.zoomProfiler.endRecSession === 'function') {
        window.zoomProfiler.endRecSession('error', { error: err && err.message ? err.message : String(err) });
      }
      if (btnStartRecordingAction) {
        btnStartRecordingAction.textContent = 'Start Recording';
        btnStartRecordingAction.disabled = false;
      }
      audio.isRecording = false;
      audio.isRecordingMode = false;
      audio.setPlaybackAudioSession();
      cleanupRecordingNodes();
      showToast(`Microphone error: ${err.message}`, 'error', 4500);
    }
  }

  // --- Standard Recording Mode (Without NANOdaw Sync: 4 count-in synth clicks, system-latency placement) ---
  async function startStandardPrelude() {
    if (!recAudioCtx || recAudioCtx.state === 'closed') {
      recAudioCtx = audio.getOrCreateAudioContext();
    }
    if (recAudioCtx.state === 'suspended' || recAudioCtx.state === 'interrupted') {
      await recAudioCtx.resume();
    }

    const tempo = Math.max(40, Math.min(240, parseInt(singleMetronomeTempo?.value, 10) || state.project?.tempo || 90));
    const dt = 60 / tempo;
    detectedIntervalSec = dt;

    pass2AudioStore.reset();
    pass2AudioStore.prepareAheadOfTime(4);
    pass2AudioStoreR.reset();
    if (activeRecordingChannelConfig && activeRecordingChannelConfig.mode === 'stereo') {
      pass2AudioStoreR.prepareAheadOfTime(4);
    }
    pass2ClickEvents = [];
    totalPass2Samples = 0;
    pass2StreamStartTime = recAudioCtx ? recAudioCtx.currentTime : null;
    recordingState = 'pass2_prelude';
    const beadEls = resetClickBeads(4);

    if (hudRecStatusText) hudRecStatusText.textContent = 'COUNT-IN (4 BEATS)';
    if (hudInstruction) hudInstruction.textContent = `Count-in at ${tempo} BPM...`;
    if (hudClickBeads) {
      hudClickBeads.classList.remove('hidden');
      hudClickBeads.style.display = 'flex';
    }

    await attachRecordingPipeline({
      detectTransients: false,
      targetStore: pass2AudioStore,
      targetStoreR: pass2AudioStoreR
    });

    window.__nanodaw_stream = recStream;
    window.__nanodaw_mic = recMicSource;

    startRecordingWatchdog();

    const startPreludeTime = recAudioCtx.currentTime + 0.15;
    recDiag('REC_STD_PRELUDE_START', {
      tempoBpm: tempo,
      dtSec: Number(dt.toFixed(4)),
      startPreludeTime: Number(startPreludeTime.toFixed(4)),
      ctx: inspectAudioCtx(recAudioCtx)
    }, {
      stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_PASS2_START : undefined,
      forcePersist: true
    });
    for (let i = 0; i < 4; i++) {
      const beatTime = startPreludeTime + i * dt;
      playSynthBeep(beatTime, i === 3 ? 1800 : 900, 0.08);

      const delayMs = Math.max(0, (beatTime - recAudioCtx.currentTime) * 1000);
      setTimeout(() => {
        if (recordingState !== 'pass2_prelude') return;
        if (hudInstruction) hudInstruction.textContent = `Beep ${i + 1} of 4`;
        const bead = beadEls[i];
        if (bead) {
          bead.className = 'click-bead beep';
          setTimeout(() => { if (bead) bead.className = 'click-bead'; }, dt * 450);
        }
      }, delayMs);
    }

    const downbeatTime = startPreludeTime + 4 * dt;
    pass2DownbeatScheduledTime = downbeatTime;

    if (audio.tracks && audio.tracks.length > 0) {
      if (Math.abs((audio.playheadPosition || 0) - recordingStartPlayhead) > 0.001) {
        audio.seek(recordingStartPlayhead);
      }
      audio.play(downbeatTime);
    }

    // Live metronome during take if requested in non-sync mode
    const shouldSingleMetro = (singleMetronomeOn && singleMetronomeOn.checked);
    if (shouldSingleMetro) {
      const metroVol = parseDbToLinear(singleMetronomeVolume ? singleMetronomeVolume.value : '0dB');
      startLiveMetronome(downbeatTime, tempo, metroVol);
    }

    const downbeatDelay = Math.max(0, (downbeatTime - recAudioCtx.currentTime) * 1000);
    setTimeout(() => {
      if (recordingState !== 'pass2_prelude') return;
      recordingState = 'recording_take';
      recDiag('REC_TAKE_LIVE_DOWNBEAT', {
        mode: 'no_sync',
        ctxTime: recAudioCtx ? Number(recAudioCtx.currentTime.toFixed(4)) : null,
        scheduledDownbeatTime: Number(downbeatTime.toFixed(4)),
        preludeSamplesCaptured: pass2AudioStore.totalSamples
      }, {
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_TAKE_START : undefined,
        forcePersist: true
      });
      if (hudRecStatusText) hudRecStatusText.textContent = 'RECORDING TAKE';
      if (hudInstruction) hudInstruction.textContent = 'Recording live to new track...';
      if (hudClickBeads) {
        hudClickBeads.classList.add('hidden');
        hudClickBeads.style.display = 'none';
      }
      takeStartTime = performance.now();
      startHudTimer();

      if (shouldSingleMetro && !liveMetronomeIntervalId) {
        const metroVol = parseDbToLinear(singleMetronomeVolume ? singleMetronomeVolume.value : '0dB');
        startLiveMetronome(recAudioCtx.currentTime, tempo, metroVol);
      }
    }, downbeatDelay);
  }

  // --- Stop Recording & Add New Track ---
  async function stopRecording() {
    if (!isRecording) return;
    const stopStartPerf = performance.now();
    const stateAtStop = recordingState;
    recDiag('REC_STOP_BEGIN', {
      stateAtStop,
      pass2Samples: pass2AudioStore.totalSamples,
      pass2SamplesR: pass2AudioStoreR.totalSamples,
      channelConfig: activeRecordingChannelConfig,
      chunksReceived: recChunksReceivedTotal,
      lastWorkletDiag: lastWorkletDiagReport,
      ctx: inspectAudioCtx(recAudioCtx)
    }, {
      stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_STOP_BEGIN : undefined,
      phase: window.PROFILER_PHASE ? window.PROFILER_PHASE.START : 0,
      forcePersist: true
    });

    isRecording = false; // Immediately disable to prevent re-entrant calls
    setTransportRecordingUI(false);
    audio.isRecording = false;
    audio.isRecordingMode = false;
    audio.setPlaybackAudioSession();

    stopLiveMetronome();
    clearActiveSyncTimers();

    // 1. Immediately hide all recording overlays and stop timer
    if (recordingHUD) {
      recordingHUD.classList.add('hidden');
      recordingHUD.style.display = 'none';
    }
    if (btnRecord) btnRecord.classList.remove('recording');
    if (hudTimerIntervalId) {
      clearInterval(hudTimerIntervalId);
      hudTimerIntervalId = null;
    }

    // 2. Snapshot timing references, channel config, and unified NANOdaw Sync session BEFORE cleanupRecordingNodes()
    const scheduledDownbeatTime = pass2DownbeatScheduledTime;
    const streamStartTime = pass2StreamStartTime;
    const syncSessionSnapshot = activeSyncSession ? { ...activeSyncSession } : null;
    const recChCfg = { ...(activeRecordingChannelConfig || { raw: 'mono:0', mode: 'mono', ch: 0, left: 0, right: 0, neededChannels: 1 }) };
    const isStereoTake = (recChCfg.mode === 'stereo');

    // Flush any pending trailing audio from worklet
    if (recWorkletNode) {
      try {
        recWorkletNode.port.postMessage({ type: 'ping_diag' });
        recWorkletNode.port.postMessage({ type: 'flush' });
      } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 20));
    recDiag('REC_STOP_FLUSHED', {
      pass2SamplesAfterFlush: pass2AudioStore.totalSamples,
      pass2SamplesRAfterFlush: pass2AudioStoreR.totalSamples,
      chunksReceived: recChunksReceivedTotal,
      lastWorkletDiag: lastWorkletDiagReport
    }, { forcePersist: true });

    // 3. Stop mic stream and processing nodes cleanly
    cleanupRecordingNodes();

    // 4. Stop audio playback
    audio.stop();

    // If user stopped during Option 2's pre-take count-in/sync beats (before Beat F + N downbeat), discard cleanly
    if (syncSessionSnapshot && syncSessionSnapshot.mode === 'synth' && stateAtStop === 'sync_preroll') {
      const startBeatNum = syncSessionSnapshot.preTakeBeats + 1;
      recDiag('REC_SYNTH_STOPPED_BEFORE_TAKE_DOWNBEAT', {
        takeStartBeat: startBeatNum,
        capturedSamples: pass2AudioStore.totalSamples
      }, { level: 'info', forcePersist: true });
      if (window.zoomProfiler && typeof window.zoomProfiler.endRecSession === 'function') {
        window.zoomProfiler.endRecSession('stopped_during_preroll', { takeStartBeat: startBeatNum });
      }
      audio.seek(recordingStartPlayhead);
      showToast(`Stopped before beat ${startBeatNum} downbeat — take discarded.`, 'info', 3500);
      return;
    }

    // 5. Process audio and create the new track
    const sampleRate = recAudioCtx ? recAudioCtx.sampleRate : 44100;

    if (pass2AudioStore.totalSamples > 0) {
      // CRITICAL: Extract raw captured audio FIRST and run all sync tap peak detection BEFORE
      // suppressAudioGlitches / processInternalGainAndNoiseSuppression, which otherwise shave sharp transients!
      const rawTakeL = pass2AudioStore.toFlatArray();
      const rawTakeR = (isStereoTake && pass2AudioStoreR.totalSamples > 0) ? pass2AudioStoreR.toFlatArray() : null;

      if (syncSessionSnapshot) {
        await processNanodawSyncTake(syncSessionSnapshot, rawTakeL, rawTakeR, isStereoTake, sampleRate, stopStartPerf);
        return;
      }

      // Non-sync mode: single-pass 4-beep count-in using system-reported audio latency
      const totalSamples = rawTakeL.length;
      const dt = detectedIntervalSec > 0 ? detectedIntervalSec : (60 / (state.project?.tempo || 90));
      const sysLatency = (recAudioCtx?.baseLatency || 0.010) + (recAudioCtx?.outputLatency || 0.040);
      let projectedDownbeatSample = 0;
      if (scheduledDownbeatTime && streamStartTime && scheduledDownbeatTime > streamStartTime) {
        projectedDownbeatSample = Math.round((scheduledDownbeatTime - streamStartTime + sysLatency) * sampleRate);
      } else {
        projectedDownbeatSample = Math.round((0.150 + 4 * dt + sysLatency) * sampleRate);
      }

      const trimSamples = Math.max(0, projectedDownbeatSample);
      const doSlice = (totalSamples > trimSamples + Math.round(sampleRate * 0.05));
      const trimmedRawL = doSlice ? rawTakeL.slice(trimSamples) : rawTakeL.slice();
      const trimmedRawR = rawTakeR
        ? (doSlice ? rawTakeR.slice(Math.min(trimSamples, rawTakeR.length)) : rawTakeR.slice())
        : null;

      let takePCM = null;
      let takePCMR = null;
      if (isStereoTake && trimmedRawR) {
        if (recordInternalGain && recordInternalGain.checked) {
          const stereoProc = processStereoInternalGainAndNoiseSuppression(trimmedRawL, trimmedRawR, sampleRate, 0.75);
          takePCM = stereoProc.left;
          takePCMR = stereoProc.right;
        } else {
          takePCM = suppressAudioGlitches(trimmedRawL, sampleRate);
          takePCMR = suppressAudioGlitches(trimmedRawR, sampleRate);
        }
      } else {
        takePCM = suppressAudioGlitches(trimmedRawL, sampleRate);
        if (recordInternalGain && recordInternalGain.checked) {
          takePCM = processInternalGainAndNoiseSuppression(takePCM, sampleRate, 0.75);
        }
      }

      const ctx = audio.getOrCreateAudioContext() || recAudioCtx;
      const takeBuffer = buildRecordedTakeAudioBuffer(ctx, takePCM, takePCMR, isStereoTake, sampleRate);

      recordedTakesCount++;
      const takeName = `Recorded Take ${recordedTakesCount}`;
      audio.addRecordedTrack(takeName, takeBuffer, recordingStartPlayhead, '#ef4444');

      const totalStopDur = Number((performance.now() - stopStartPerf).toFixed(2));
      const takeDurationSec = Number((takeBuffer.length / sampleRate).toFixed(3));
      recDiag('REC_STOP_COMPLETE', {
        takeName,
        takeDurationSec,
        channels: takeBuffer.numberOfChannels,
        channelConfig: recChCfg,
        sampleRate,
        offsetSec: recordingStartPlayhead,
        stopProcessingMs: totalStopDur
      }, {
        stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_STOP_COMPLETE : undefined,
        duration: totalStopDur,
        forcePersist: true
      });
      if (window.zoomProfiler && typeof window.zoomProfiler.endRecSession === 'function') {
        window.zoomProfiler.endRecSession('completed', {
          takeName,
          takeDurationSec,
          channels: takeBuffer.numberOfChannels,
          sampleRate,
          stopProcessingMs: totalStopDur
        });
      }

      const chTag = takeBuffer.numberOfChannels === 2 ? ' · Stereo' : '';
      showToast(`Added "${takeName}" (${(takeBuffer.length / sampleRate).toFixed(1)}s${chTag}) to project!`, 'success', 4000);
      audio.seek(recordingStartPlayhead);
      timeline.render();
      timeline.renderWaveforms();
      timeline.updateInspectorPane();
      if (timeline.scrollToStart) timeline.scrollToStart();
    }
  }

  /**
   * Unified Single-Pass NANOdaw Sync Take Alignment & Post-Processing.
   * Shared by BOTH:
   *  - Option 1 ('track'): Backing Track / Metronome Sync
   *  - Option 2 ('synth'): Metronome Synth Beats (discards synchronization samples prior to beat F + N downbeat,
   *    filing the synchronized recording starting at beat F + N right onto recordingStartPlayhead)
   */
  async function processNanodawSyncTake(syncSession, fullRawL, fullRawR, isStereoTake, sampleRate, stopStartPerf = performance.now()) {
    const { mode, guideTrackIdx, firstBeat, numBeats, preTakeBeats } = syncSession;
    const isTrackMode = (mode === 'track');

    if (fullRawL.length < Math.round(sampleRate * 0.1)) {
      if (isTrackMode) {
        fallbackAddTrack(fullRawL, fullRawR, isStereoTake, sampleRate, guideTrackIdx);
      } else {
        showToast('Recording was too short to save.', 'info', 3500);
      }
      return;
    }

    let tempo = syncSession.tempo || 90;
    let dt = syncSession.dt || (60 / tempo);
    let guideName = syncSession.guideName || 'Synth Metronome';
    let refTimelineSec = [];
    let guideOk = true;

    if (isTrackMode) {
      const guideRes = await resolveGuideSyncTimelinePeaks(guideTrackIdx, firstBeat, numBeats, tempo, recordingStartPlayhead);
      tempo = guideRes.tempo;
      dt = guideRes.dt;
      guideName = guideRes.guideName;
      refTimelineSec = guideRes.peaksTimelineSec;
      guideOk = guideRes.ok;
    } else {
      // Option 2 ('synth'): beat F + N is anchored at recordingStartPlayhead,
      // so sync beat k (0..N-1) sits at recordingStartPlayhead - (N - k) * dt on the timeline.
      for (let k = 0; k < numBeats; k++) {
        refTimelineSec.push(recordingStartPlayhead - (numBeats - k) * dt);
      }
    }

    const expFirstTakeSec = isTrackMode
      ? (refTimelineSec.length > 0 ? Math.max(0, refTimelineSec[0] - recordingStartPlayhead) : ((firstBeat - 1) * dt))
      : (syncSession.expSyncBufferSec && syncSession.expSyncBufferSec.length > 0
          ? syncSession.expSyncBufferSec[0]
          : (0.12 + (firstBeat - 1) * dt));

    // Combine stereo channels via max-signed-amplitude so tapping into EITHER mic triggers peak lock,
    // and bound the sync search slice to the sync window so later musical transients never interfere.
    const combinedRaw = (isStereoTake && fullRawR && fullRawR.length > 0)
      ? combineStereoForPeakDetection(fullRawL, fullRawR)
      : fullRawL;
    const maxSyncSearchSamples = Math.min(
      combinedRaw.length,
      Math.round((expFirstTakeSec + (numBeats + 1.95) * dt) * sampleRate)
    );
    const detectSlicePCM = combinedRaw.subarray(0, maxSyncSearchSamples);
    const userThreshLinear = getPeakThresholdLinear();

    const detRes = detectSyncTapPeaks(detectSlicePCM, sampleRate, expFirstTakeSec, dt, numBeats, userThreshLinear);
    const takePeaksSec = detRes.peaksSec;
    const takeOk = (takePeaksSec.length === numBeats);

    recDiag('REC_NANODAW_SYNC_PEAKS', {
      mode,
      tempo,
      dtSec: Number(dt.toFixed(4)),
      firstBeat,
      numBeats,
      isStereoTake,
      peakSensDb,
      thresholdLinear: Number(userThreshLinear.toFixed(5)),
      expFirstTakeSec: Number(expFirstTakeSec.toFixed(3)),
      method: detRes.method,
      candidatesCount: detRes.candidatesCount,
      refTimelineSec: refTimelineSec.map(v => Number(v.toFixed(4))),
      takePeaksSec: takePeaksSec.map(v => Number(v.toFixed(4)))
    }, { forcePersist: true });

    // Failure Handling if N distinct sync peaks were not detected
    if (!guideOk || !takeOk) {
      let reason = '';
      if (isTrackMode && !guideOk && !takeOk) {
        reason = `Could not detect all ${numBeats} required sync peaks in BOTH guide track "${guideName}" (detected ${refTimelineSec.length} of ${numBeats}) and your recording (detected ${takePeaksSec.length} of ${numBeats}).`;
      } else if (isTrackMode && !guideOk) {
        reason = `Could not detect all ${numBeats} distinct peaks in guide track "${guideName}" at beats ${firstBeat}–${firstBeat + numBeats - 1} (detected ${refTimelineSec.length} of ${numBeats}). Make sure the guide track has clear beats at those positions.`;
      } else {
        reason = `Could not detect all ${numBeats} distinct tap peaks in your recording (detected ${takePeaksSec.length} of ${numBeats} around beats ${firstBeat}–${firstBeat + numBeats - 1} at ${peakSensDb} dB threshold). Try lowering the sensitivity slider on the VU meter or tapping closer to the mic.`;
      }

      if (isTrackMode) {
        const alertMsg = `NANOdaw Sync Notice:\n\n${reason}\n\nThe track has been added directly below "${guideName}" at playhead (${recordingStartPlayhead.toFixed(2)}s) without alignment shift.`;
        fallbackAddTrack(fullRawL, fullRawR, isStereoTake, sampleRate, guideTrackIdx);
        setTimeout(() => { alert(alertMsg); }, 50);
        showToast('Sync incomplete: track placed without shift', 'warning', 6000);
      } else {
        // Option 2 ('synth'): discard pre-take beats up to nominal beat F + N using system latency fallback
        const sysLatency = (recAudioCtx?.baseLatency || 0.010) + (recAudioCtx?.outputLatency || 0.040);
        const nominalDownbeatSec = (syncSession.downbeatCtxTime && syncSession.streamStartTime !== null)
          ? Math.max(0, (syncSession.downbeatCtxTime - syncSession.streamStartTime) + sysLatency)
          : ((0.12 + preTakeBeats * dt) + sysLatency);
        const fbTrim = Math.min(fullRawL.length, Math.max(0, Math.round(nominalDownbeatSec * sampleRate)));
        if (fullRawL.length <= fbTrim + Math.round(0.05 * sampleRate)) {
          showToast(`Sync missed (${takePeaksSec.length}/${numBeats}) and no audio recorded after beat ${preTakeBeats + 1}.`, 'warning', 5500);
          return;
        }
        const fbL = fullRawL.slice(fbTrim);
        const fbR = (isStereoTake && fullRawR) ? fullRawR.slice(Math.min(fbTrim, fullRawR.length)) : null;
        const alertMsg = `NANOdaw Sync Notice:\n\n${reason}\n\nPre-roll beats 1–${preTakeBeats} were trimmed using system latency and the take (from beat ${preTakeBeats + 1}) was placed at playhead (${recordingStartPlayhead.toFixed(2)}s).`;
        fallbackAddTrack(fbL, fbR, isStereoTake, sampleRate, null);
        setTimeout(() => { alert(alertMsg); }, 50);
        showToast('Sync incomplete: placed using system-latency fallback', 'warning', 6000);
      }
      return;
    }

    // Unified Success Alignment across ALL N detected sync beats:
    // targetOffset slides sample 0 of the raw recording onto the timeline so all N sync taps align with refTimelineSec[0..N-1].
    let offsetSum = 0;
    for (let k = 0; k < numBeats; k++) {
      offsetSum += (refTimelineSec[k] - takePeaksSec[k]);
    }
    const targetOffset = offsetSum / numBeats;

    let trimSamples = 0;
    let trimmedSec = 0;
    let finalOffset = 0;

    if (isTrackMode) {
      // Option 1 ('track'): trim prelude sync taps + brief decay margin so taps don't pollute the track
      const lastTapSec = takePeaksSec[numBeats - 1];
      const tapDecayMargin = Math.min(0.20, 0.35 * dt);
      const calibEndSec = lastTapSec + tapDecayMargin;
      if (fullRawL.length / sampleRate > calibEndSec + 0.1) {
        trimSamples = Math.round(calibEndSec * sampleRate);
      }
      trimmedSec = trimSamples / sampleRate;
      finalOffset = targetOffset + trimmedSec;
    } else {
      // Option 2 ('synth'): throw away all synchronization samples prior to the synchronized downbeat of beat F + N!
      // Because refTimelineSec[k] = recordingStartPlayhead - (N - k) * dt,
      // downbeatTakeSec = recordingStartPlayhead - targetOffset = mean_k(takePeaksSec[k] + (N - k) * dt).
      const downbeatTakeSec = recordingStartPlayhead - targetOffset;
      trimSamples = Math.max(0, Math.round(downbeatTakeSec * sampleRate));
      if (fullRawL.length <= trimSamples + Math.round(0.05 * sampleRate)) {
        audio.seek(recordingStartPlayhead);
        showToast(`Stopped before recording past beat ${preTakeBeats + 1} downbeat — nothing saved.`, 'info', 4000);
        return;
      }
      trimmedSec = trimSamples / sampleRate;
      finalOffset = targetOffset + trimmedSec;
      if (Math.abs(finalOffset - recordingStartPlayhead) < (1.5 / sampleRate)) {
        finalOffset = recordingStartPlayhead;
      }
    }

    let finalPCML = trimSamples > 0 ? fullRawL.slice(trimSamples) : fullRawL.slice();
    let finalPCMR = (isStereoTake && fullRawR)
      ? (trimSamples > 0 ? fullRawR.slice(Math.min(trimSamples, fullRawR.length)) : fullRawR.slice())
      : null;

    if (finalOffset < 0) {
      const extraTrim = Math.min(finalPCML.length, Math.round(-finalOffset * sampleRate));
      finalPCML = finalPCML.slice(extraTrim);
      if (finalPCMR) finalPCMR = finalPCMR.slice(Math.min(extraTrim, finalPCMR.length));
      trimmedSec += extraTrim / sampleRate;
      finalOffset = 0;
    }

    // Apply glitch suppression & optional internal gain ONLY after sync peaks have been detected & trimmed
    if (isStereoTake && finalPCMR) {
      if (recordInternalGain && recordInternalGain.checked) {
        const stereoProc = processStereoInternalGainAndNoiseSuppression(finalPCML, finalPCMR, sampleRate, 0.75);
        finalPCML = stereoProc.left;
        finalPCMR = stereoProc.right;
      } else {
        finalPCML = suppressAudioGlitches(finalPCML, sampleRate);
        finalPCMR = suppressAudioGlitches(finalPCMR, sampleRate);
      }
    } else {
      finalPCML = suppressAudioGlitches(finalPCML, sampleRate);
      if (recordInternalGain && recordInternalGain.checked) {
        finalPCML = processInternalGainAndNoiseSuppression(finalPCML, sampleRate, 0.75);
      }
    }

    const ctx = audio.getOrCreateAudioContext() || recAudioCtx;
    const takeBuffer = buildRecordedTakeAudioBuffer(ctx, finalPCML, finalPCMR, isStereoTake, sampleRate);

    recordedTakesCount++;
    const takeName = `Recorded Take ${recordedTakesCount}`;
    const insertIdx = isTrackMode ? (guideTrackIdx + 1) : null;
    audio.addRecordedTrack(takeName, takeBuffer, finalOffset, '#ef4444', insertIdx);

    audio.seek(recordingStartPlayhead);
    timeline.render();
    timeline.renderWaveforms();

    if (isTrackMode) {
      const recPeaksTimelineSec = takePeaksSec.map(tSec => finalOffset + (tSec - trimmedSec));
      timeline.setSyncLines({
        metroTrackIndex: guideTrackIdx,
        recTrackIndex: insertIdx,
        metroPeaksTimelineSec: refTimelineSec,
        recPeaksTimelineSec
      });
    } else {
      timeline.clearSyncLines();
    }

    timeline.updateInspectorPane();
    if (timeline.scrollToStart) timeline.scrollToStart();

    const chTag = takeBuffer.numberOfChannels === 2 ? ' (Stereo)' : '';
    if (isTrackMode) {
      showToast(`Sync locked! "${takeName}"${chTag} aligned with "${guideName}" (${numBeats} beats)!`, 'success', 5000);
    } else {
      showToast(`Sync locked! "${takeName}"${chTag} synchronized at beat ${preTakeBeats + 1} downbeat!`, 'success', 5000);
    }

    const takeDurationSec = Number((takeBuffer.length / sampleRate).toFixed(3));
    const totalStopDur = Number((performance.now() - stopStartPerf).toFixed(2));
    recDiag('REC_NANODAW_SYNC_COMPLETE', {
      mode,
      takeName,
      takeDurationSec,
      channels: takeBuffer.numberOfChannels,
      sampleRate,
      finalOffset: Number(finalOffset.toFixed(4)),
      trimmedSec: Number(trimmedSec.toFixed(4)),
      syncBeats: numBeats,
      stopProcessingMs: totalStopDur
    }, {
      stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_STOP_COMPLETE : undefined,
      duration: totalStopDur,
      forcePersist: true
    });
    if (window.zoomProfiler && typeof window.zoomProfiler.endRecSession === 'function') {
      window.zoomProfiler.endRecSession(`completed_${mode}_sync`, {
        takeName,
        takeDurationSec,
        channels: takeBuffer.numberOfChannels,
        sampleRate,
        finalOffset: Number(finalOffset.toFixed(4))
      });
    }
  }

  function fallbackAddTrack(rawTakePCML, rawTakePCMR, isStereoTake, sampleRate, guideIdx) {
    let pcmL = null;
    let pcmR = null;
    if (isStereoTake && rawTakePCMR && rawTakePCMR.length > 0) {
      if (recordInternalGain && recordInternalGain.checked) {
        const stereoProc = processStereoInternalGainAndNoiseSuppression(rawTakePCML.slice(), rawTakePCMR.slice(), sampleRate, 0.75);
        pcmL = stereoProc.left;
        pcmR = stereoProc.right;
      } else {
        pcmL = suppressAudioGlitches(rawTakePCML.slice(), sampleRate);
        pcmR = suppressAudioGlitches(rawTakePCMR.slice(), sampleRate);
      }
    } else {
      pcmL = suppressAudioGlitches(rawTakePCML.slice(), sampleRate);
      if (recordInternalGain && recordInternalGain.checked) {
        pcmL = processInternalGainAndNoiseSuppression(pcmL, sampleRate, 0.75);
      }
    }
    const ctx = audio.getOrCreateAudioContext() || recAudioCtx;
    const takeBuffer = buildRecordedTakeAudioBuffer(ctx, pcmL, pcmR, isStereoTake, sampleRate);

    recordedTakesCount++;
    const takeName = `Recorded Take ${recordedTakesCount}`;
    const insertIdx = (guideIdx !== null && guideIdx !== undefined) ? guideIdx + 1 : audio.tracks.length;
    audio.addRecordedTrack(takeName, takeBuffer, recordingStartPlayhead, '#ef4444', insertIdx);

    const takeDurationSec = Number((takeBuffer.length / sampleRate).toFixed(3));
    recDiag('REC_NANODAW_SYNC_FALLBACK_ADDED', {
      takeName,
      takeDurationSec,
      channels: takeBuffer.numberOfChannels,
      sampleRate,
      guideIdx
    }, {
      level: 'warn',
      stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_STOP_COMPLETE : undefined,
      forcePersist: true
    });
    if (window.zoomProfiler && typeof window.zoomProfiler.endRecSession === 'function') {
      window.zoomProfiler.endRecSession('completed_fallback_unshifted', {
        takeName,
        takeDurationSec,
        channels: takeBuffer.numberOfChannels,
        sampleRate
      });
    }

    timeline.clearSyncLines();
    audio.seek(recordingStartPlayhead);
    timeline.render();
    timeline.renderWaveforms();
    timeline.updateInspectorPane();
  }

  if (btnRecord) {
    btnRecord.addEventListener('click', () => {
      if (isRecording) {
        stopRecording();
      } else {
        recDiag('REC_MODAL_OPEN', {
          playhead: Number((audio.playheadPosition || 0).toFixed(3)),
          trackCount: audio.tracks ? audio.tracks.length : 0,
          ctx: inspectAudioCtx(audio.audioCtx)
        }, {
          stepId: window.PROFILER_STEP ? window.PROFILER_STEP.REC_MODAL_OPEN : undefined,
          forcePersist: true
        });
        audio.isRecordingMode = true;
        audio.setPlayAndRecordAudioSession();
        populateSyncGuideTracks();
        resetPreRecTapTest();
        updateRecordModalToggles();
        initAutoGainDefault();
        switchRecordModalTab('record');

        // Reset start recording button to default
        if (btnStartRecordingAction) {
          btnStartRecordingAction.textContent = 'Start Recording';
          btnStartRecordingAction.disabled = false;
        }

        // Proactively pre-allocate standby buffers and pre-warm AudioWorklet ahead of time!
        pass2AudioStore.prepareAheadOfTime(4);
        pass2AudioStoreR.prepareAheadOfTime(2);
        const preCtx = audio.getOrCreateAudioContext();
        if (preCtx) ensureRecorderWorklet(preCtx);

        // Pre-warm chunk decoding for all tracks at current playhead so multi-track playback starts instantly
        if (audio.prioritizeSeek) {
          audio.prioritizeSeek(audio.playheadPosition || 0);
        }

        if (recordSetupModal) {
          recordSetupModal.classList.remove('hidden');
          recordSetupModal.style.display = 'flex';
          setVUMeterGrayedOut(true);
          refreshAudioInputDevices().then(() => {
            startVUMonitor();
          });
        }
      }
    });
  }

  if (btnCloseRecordSetupModal && recordSetupModal) {
    btnCloseRecordSetupModal.addEventListener('click', () => {
      recDiag('REC_MODAL_CLOSED', { via: 'close_btn' });
      stopVUMonitor();
      recordSetupModal.classList.add('hidden');
      recordSetupModal.style.display = 'none';
      audio.isRecordingMode = false;
      audio.setPlaybackAudioSession();
    });
  }
  if (btnCancelRecordSetup && recordSetupModal) {
    btnCancelRecordSetup.addEventListener('click', () => {
      recDiag('REC_MODAL_CLOSED', { via: 'cancel_btn' });
      stopVUMonitor();
      recordSetupModal.classList.add('hidden');
      recordSetupModal.style.display = 'none';
      audio.isRecordingMode = false;
      audio.setPlaybackAudioSession();
    });
  }
  if (btnStartRecordingAction) {
    btnStartRecordingAction.addEventListener('click', () => {
      // 1. Immediate visual feedback on the button
      btnStartRecordingAction.textContent = '⏳ Initializing...';
      btnStartRecordingAction.disabled = true;

      // 2. Transfer active VU stream to recStream if it already satisfies the selected channel count!
      const sel = parseChannelSelection(recordChannelSelect ? recordChannelSelect.value : 'mono:0');
      const vuStreamLive = Boolean(vuStream && vuStream.active && vuStream.getAudioTracks().length > 0 && vuStream.getAudioTracks()[0].readyState === 'live');
      const canTransferVuStream = vuStreamLive && (getStreamActualChannels(vuStream) >= sel.neededChannels);
      recDiag('REC_START_BTN_CLICK', {
        channelSelection: sel,
        transferredVuStream: canTransferVuStream,
        vuStreamChannels: vuStreamLive ? getStreamActualChannels(vuStream) : 0,
        vuStreamSpec: vuStreamLive ? inspectMediaStream(vuStream) : null,
        ctx: inspectAudioCtx(audio.audioCtx)
      }, { forcePersist: true });

      if (canTransferVuStream) {
        recStream = vuStream;
        vuStream = null;
        stopVUMonitor(true);
      } else {
        stopVUMonitor(false);
      }

      // 3. Close the modal
      if (recordSetupModal) {
        recordSetupModal.classList.add('hidden');
        recordSetupModal.style.display = 'none';
      }

      // 4. Immediate visual feedback: Show recording HUD with "INIT" status & expand Stop button right away!
      setTransportRecordingUI(true);
      if (recordingHUD) {
        recordingHUD.classList.remove('hidden');
        recordingHUD.style.display = 'flex';
      }
      if (hudRecStatusText) hudRecStatusText.textContent = 'INIT';
      if (hudInstruction) hudInstruction.textContent = '⏳ Initializing recording...';
      if (hudClickBeads) {
        hudClickBeads.classList.add('hidden');
        hudClickBeads.style.display = 'none';
      }

      // 5. Kick off recording flow
      startRecordingFlow();
    });
  }
  if (recordSetupModal) {
    recordSetupModal.addEventListener('click', (e) => {
      if (e.target === recordSetupModal) {
        stopVUMonitor();
        recordSetupModal.classList.add('hidden');
        recordSetupModal.style.display = 'none';
        audio.isRecordingMode = false;
        audio.setPlaybackAudioSession();
      }
    });
  }
  if (btnStopRecordingAction) {
    btnStopRecordingAction.addEventListener('click', () => {
      stopRecording();
    });
  }

  // Auto-finish take when backing audio reaches the end (except in synth-metronome mode, where take length is unconstrained)
  audio.on('playback_stopped', () => {
    if (isRecording && recordingState === 'recording_take') {
      if (activeSyncSession && activeSyncSession.mode === 'synth') {
        return;
      }
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

  // --- Irreversible Delete Track Confirmation Controller (Native <dialog>) ---
  const deleteTrackConfirmDialog = document.getElementById('deleteTrackConfirmDialog');
  const deleteTrackConfirmDesc = document.getElementById('deleteTrackConfirmDesc');
  let pendingDeleteTrackIndex = null;

  if (deleteTrackConfirmDialog && !('closedBy' in HTMLDialogElement.prototype)) {
    const isOutsideDialog = (e, dlg) => {
      const r = dlg.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    deleteTrackConfirmDialog.addEventListener('pointerdown', (e) => {
      pressedOutside = isOutsideDialog(e, deleteTrackConfirmDialog);
    });
    deleteTrackConfirmDialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && isOutsideDialog(e, deleteTrackConfirmDialog)) {
        deleteTrackConfirmDialog.close();
      }
    });
  }

  if (deleteTrackConfirmDialog) {
    deleteTrackConfirmDialog.addEventListener('close', () => {
      const choice = deleteTrackConfirmDialog.returnValue;
      deleteTrackConfirmDialog.returnValue = '';
      const idx = pendingDeleteTrackIndex;
      pendingDeleteTrackIndex = null;

      if (timeline && typeof timeline.closeAllMobileDeleteRows === 'function') {
        timeline.closeAllMobileDeleteRows();
      }

      if (choice === 'delete' && idx !== null && idx >= 0 && idx < audio.tracks.length) {
        const removed = audio.deleteTrack(idx);
        const removedName = removed?.name || `Track ${idx + 1}`;
        showToast(`Deleted "${removedName}"`, 'info', 2500);
      }
    });
  }

  timeline.onRequestDeleteTrack = (trackIndex) => {
    if (isRecording) {
      showToast('Stop recording before deleting a track.', 'warning', 3000);
      return;
    }
    const track = state.project?.tracks?.[trackIndex] || audio.tracks?.[trackIndex];
    if (!track) return;

    pendingDeleteTrackIndex = trackIndex;
    const trackLabel = track.name || `Track ${trackIndex + 1}`;
    if (deleteTrackConfirmDesc) {
      deleteTrackConfirmDesc.textContent = `Permanently delete "${trackLabel}"? This action is irreversible and cannot be undone.`;
    }

    if (deleteTrackConfirmDialog && typeof deleteTrackConfirmDialog.showModal === 'function') {
      deleteTrackConfirmDialog.returnValue = '';
      deleteTrackConfirmDialog.showModal();
    } else if (confirm(`Permanently delete "${trackLabel}"? This action cannot be undone.`)) {
      pendingDeleteTrackIndex = null;
      if (timeline && typeof timeline.closeAllMobileDeleteRows === 'function') {
        timeline.closeAllMobileDeleteRows();
      }
      audio.deleteTrack(trackIndex);
      showToast(`Deleted "${trackLabel}"`, 'info', 2500);
    }
  };

  // --- Keyboard Shortcuts ---
  window.addEventListener('keydown', (e) => {
    // Allow native modal <dialog> controls (Esc, Enter, Space) to work without interference
    if (document.querySelector('dialog[open]')) return;
    // Ignore when typing inside an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

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
