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

  const recordingHUD = document.getElementById('recordingHUD');
  const hudInstructionBox = document.getElementById('hudInstructionBox');
  const hudRecStatusText = document.getElementById('hudRecStatusText');
  const hudTimer = document.getElementById('hudTimer');
  const hudInstruction = document.getElementById('hudInstruction');
  const hudLatencyText = document.getElementById('hudLatencyText');
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
  let pass2ClickEvents = [];
  let pass1TimeoutId = null;
  let pass1PostWaitTimeoutId = null;
  let hudTimerIntervalId = null;
  let takeStartTime = 0;
  let recordedTakesCount = 0;
  let detectedIntervalSec = 0;
  let userClickBuffers = [];
  let totalPass1Samples = 0;
  let totalPass2Samples = 0;
  let pass1StreamStartTime = null;
  let pass1GuideStartTime = 0;
  let pass2StreamStartTime = null;
  let pass2DownbeatScheduledTime = null;
  let recordingStartPlayhead = 0;

  // Realtime Live Metronome
  let liveMetronomeIntervalId = null;
  let liveMetronomeGainNode = null;

  function parseDbToLinear(dbStr, defaultDb = 0) {
    if (!dbStr) return 1.0;
    const cleaned = String(dbStr).replace(/db/i, '').trim();
    const num = parseFloat(cleaned);
    const val = isNaN(num) ? defaultDb : num;
    const clamped = Math.max(-48, Math.min(6, val));
    return Math.pow(10, clamped / 20);
  }

  function startLiveMetronome(startTime, tempo, linearVolume) {
    stopLiveMetronome();
    if (!recAudioCtx || recAudioCtx.state === 'closed') return;
    const dt = 60 / tempo;

    try {
      liveMetronomeGainNode = recAudioCtx.createGain();
      liveMetronomeGainNode.gain.setValueAtTime(linearVolume, recAudioCtx.currentTime);
      liveMetronomeGainNode.connect(recAudioCtx.destination);
    } catch (e) {
      console.warn('Metronome gain error:', e);
      return;
    }

    let nextBeatTime = startTime;
    const scheduleAheadSec = 0.30;
    let beatIndex = 0;

    function scheduleBeats() {
      // Keep metronome running through both Pass 2 count-in and live recording
      if (!isRecording || (recordingState !== 'pass2_prelude' && recordingState !== 'recording_take')) {
        stopLiveMetronome();
        return;
      }
      const now = recAudioCtx ? recAudioCtx.currentTime : 0;
      while (nextBeatTime < now - 0.1) {
        nextBeatTime += dt;
        beatIndex++;
      }
      while (nextBeatTime < now + scheduleAheadSec) {
        // High crisp click with measure accent on beat 1
        const freq = (beatIndex % 4 === 0) ? 1600 : 1100;
        playSynthBeep(nextBeatTime, freq, 0.045, liveMetronomeGainNode);
        nextBeatTime += dt;
        beatIndex++;
      }
    }

    console.log(`[Live Metronome] Started for take at ${startTime.toFixed(3)}s, tempo: ${tempo} BPM (${dt.toFixed(3)}s), vol: ${linearVolume.toFixed(2)}`);
    scheduleBeats();
    liveMetronomeIntervalId = setInterval(scheduleBeats, 35);
  }

  function stopLiveMetronome() {
    if (liveMetronomeIntervalId) {
      clearInterval(liveMetronomeIntervalId);
      liveMetronomeIntervalId = null;
    }
    if (liveMetronomeGainNode) {
      try { liveMetronomeGainNode.disconnect(); } catch (_) {}
      liveMetronomeGainNode = null;
    }
  }

  function updateRecordModalToggles() {
    const is2Pass = record2PassSync ? record2PassSync.checked : true;
    if (container2PassSync) container2PassSync.style.display = is2Pass ? 'flex' : 'none';
    if (containerSinglePass) containerSinglePass.style.display = is2Pass ? 'none' : 'flex';

    if (is2Pass) {
      const isSynth = guideModeSynth ? guideModeSynth.checked : true;
      if (guideSynthSubOptions) guideSynthSubOptions.style.display = isSynth ? 'flex' : 'none';
      if (guideTrackSubOptions) guideTrackSubOptions.style.display = isSynth ? 'none' : 'flex';
    } else {
      const isSingleMetro = singleMetronomeOn ? singleMetronomeOn.checked : false;
      if (singleMetronomeSubOptions) singleMetronomeSubOptions.style.display = isSingleMetro ? 'flex' : 'none';
    }
  }

  function populateSyncGuideTracks() {
    if (!syncGuideTrackSelect) return;
    syncGuideTrackSelect.innerHTML = '<option value="">None</option>';
    audio.tracks.forEach((track, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = `Track ${idx + 1}: ${track.name || 'Track'}`;
      syncGuideTrackSelect.appendChild(opt);
    });
    // Default is "None"
    syncGuideTrackSelect.value = '';

    // Initialize default tempo if project has tempo
    const defaultTempo = state.project?.tempo || 90;
    if (syncSynthTempo && (!syncSynthTempo.value || syncSynthTempo.value === '90')) {
      syncSynthTempo.value = defaultTempo;
    }
    if (singleMetronomeTempo && (!singleMetronomeTempo.value || singleMetronomeTempo.value === '90')) {
      singleMetronomeTempo.value = defaultTempo;
    }
  }

  if (record2PassSync) record2PassSync.addEventListener('change', updateRecordModalToggles);
  if (guideModeSynth) guideModeSynth.addEventListener('change', updateRecordModalToggles);
  if (guideModeTrack) guideModeTrack.addEventListener('change', updateRecordModalToggles);
  if (singleMetronomeOn) singleMetronomeOn.addEventListener('change', updateRecordModalToggles);

  async function refreshAudioInputDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      // Ensure iOS audioSession is in play-and-record mode BEFORE enumerating/probing
      audio.isRecordingMode = true;
      audio.setPlayAndRecordAudioSession();

      let devices = await navigator.mediaDevices.enumerateDevices();
      let audioInputs = devices.filter(d => d.kind === 'audioinput');

      // If device labels are blank, prompt briefly for mic permission
      if (audioInputs.length > 0 && !audioInputs[0].label) {
        try {
          if (typeof navigator !== 'undefined' && navigator.audioSession) {
            try { navigator.audioSession.type = 'play-and-record'; } catch (_) {}
          }
          const tempStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              sampleRate: { ideal: 44100 },
              echoCancellation: false,
              autoGainControl: false,
              noiseSuppression: false
            }
          });
          tempStream.getTracks().forEach(t => t.stop());
          devices = await navigator.mediaDevices.enumerateDevices();
          audioInputs = devices.filter(d => d.kind === 'audioinput');
        } catch (_) {
          try {
            const fallbackStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            fallbackStream.getTracks().forEach(t => t.stop());
            devices = await navigator.mediaDevices.enumerateDevices();
            audioInputs = devices.filter(d => d.kind === 'audioinput');
          } catch (e2) {
            console.warn('Mic permission probe failed:', e2);
          }
        }
      }

      if (recordDeviceSelect) {
        recordDeviceSelect.innerHTML = '';
        if (audioInputs.length === 0) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = '📱 Built-in Phone Mic (44.1kHz CD Quality)';
          recordDeviceSelect.appendChild(opt);
        } else {
          // Identify devices:
          // Distinguish Bluetooth headset vs Built-in phone mic
          let preferredDeviceId = null;

          const classified = audioInputs.map((dev, idx) => {
            const label = dev.label || `Microphone ${idx + 1}`;
            const isBt = /bluetooth|headset|hands-free|sco|powerbeat|airpod|galaxy\s*buds|pixel\s*buds|wh-|wf-|bose|wireless/i.test(label);
            const isInternal = /built-in|internal|phone|default|iphone|front|back|microphone$/i.test(label) && !isBt;
            return { dev, label, isBt, isInternal };
          });

          // Preferred mic is internal phone mic, or first non-bluetooth mic
          const builtIn = classified.find(c => c.isInternal) || classified.find(c => !c.isBt) || classified[0];
          if (builtIn) {
            preferredDeviceId = builtIn.dev.deviceId;
          }

          classified.forEach((item) => {
            const opt = document.createElement('option');
            opt.value = item.dev.deviceId;

            if (item.isInternal || (builtIn && item.dev.deviceId === builtIn.dev.deviceId)) {
              opt.textContent = `📱 ${item.label || 'Built-in Phone Mic'} (44.1kHz CD Quality — Recommended)`;
            } else if (item.isBt) {
              opt.textContent = `🎧 ${item.label} (16kHz Bluetooth Voice Mode)`;
            } else {
              opt.textContent = `🎤 ${item.label}`;
            }

            recordDeviceSelect.appendChild(opt);
          });

          // Default to the Built-in Phone Mic:
          // Keeps Bluetooth headphones in A2DP stereo (44.1kHz CD quality music playback) without dropping to SCO!
          if (preferredDeviceId) {
            recordDeviceSelect.value = preferredDeviceId;
          }
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

  // High-precision transient peak finder
  function findTransientPeak(pcm, start, end) {
    const s0 = Math.max(0, start);
    const s1 = Math.min(pcm.length, end);
    let bestIdx = s0;
    let maxMetric = -1;
    let peakAbs = 0;
    let sumSq = 0;
    for (let s = s0; s < s1; s++) {
      const v = pcm[s];
      const amp = Math.abs(v);
      sumSq += v * v;
      const diff = s > 0 ? Math.abs(v - pcm[s - 1]) : 0;
      const metric = amp * 0.65 + diff * 0.35;
      if (metric > maxMetric) {
        maxMetric = metric;
        bestIdx = s;
        peakAbs = amp;
      }
    }
    const n = Math.max(1, s1 - s0);
    const rms = Math.sqrt(sumSq / n) || 1e-9;
    return { idx: bestIdx, peakAbs: peakAbs, crest: peakAbs / rms };
  }

  // Linear interpolation segment resampler for time-fitting user calibration taps
  function resampleSegment(src, srcStart, srcEnd, targetLen) {
    const out = new Float32Array(targetLen);
    const srcLen = srcEnd - srcStart;
    if (srcLen <= 0 || targetLen <= 0) return out;
    const step = (srcLen - 1) / Math.max(1, targetLen - 1);
    for (let i = 0; i < targetLen; i++) {
      const pos = srcStart + i * step;
      const i0 = Math.floor(pos);
      const i1 = Math.min(src.length - 1, i0 + 1);
      const frac = pos - i0;
      out[i] = src[i0] * (1 - frac) + src[i1] * frac;
    }
    return out;
  }

  function playSynthBeep(time, freq = 900, dur = 0.08, destNode = null, volume = 0.8) {
    if (!recAudioCtx) return;
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
    stopLiveMetronome();
    if (hudLatencyText) {
      hudLatencyText.textContent = '';
      hudLatencyText.style.display = 'none';
    }
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
    pass2StreamStartTime = null;
    pass2DownbeatScheduledTime = null;

    audio.isRecording = false;
    audio.isRecordingMode = false;
    audio.setPlaybackAudioSession();
  }

  function cancelRecording() {
    audio.isRecording = false;
    audio.isRecordingMode = false;
    audio.setPlaybackAudioSession();
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
    const use2PassSync = record2PassSync ? record2PassSync.checked : true;

    try {
      // 1. Enter recording mode and switch iOS AudioSession to play-and-record
      audio.isRecordingMode = true;
      audio.isRecording = true;
      audio.setPlayAndRecordAudioSession();
      recordingStartPlayhead = audio.playheadPosition || 0;

      // 2. Acquire mic stream without browser audio DSP filters for pure transient response & 44.1kHz CD quality
      const audioConstraints = {
        sampleRate: { ideal: 44100 },
        channelCount: { ideal: 1 },
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
        console.warn('Initial constraints with deviceId failed, retrying ideal 44100:', e1);
        try {
          recStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              sampleRate: { ideal: 44100 },
              echoCancellation: false,
              autoGainControl: false,
              noiseSuppression: false
            }
          });
        } catch (e2) {
          console.warn('Retrying basic audio getUserMedia:', e2);
          recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
      }

      // 3. Obtain master AudioContext and ensure it is active
      recAudioCtx = audio.getOrCreateAudioContext();
      if (recAudioCtx.state === 'suspended' || recAudioCtx.state === 'interrupted') {
        await recAudioCtx.resume();
      }

      isRecording = true;
      if (btnRecord) btnRecord.classList.add('recording');
      if (recordingHUD) {
        recordingHUD.classList.remove('hidden');
        recordingHUD.style.display = 'flex';
      }

      if (use2PassSync) {
        startPass1Calibration();
      } else {
        await startStandardPrelude();
      }
    } catch (err) {
      console.error('Failed to start recording:', err);
      audio.isRecording = false;
      audio.isRecordingMode = false;
      audio.setPlaybackAudioSession();
      cleanupRecordingNodes();
      showToast(`Microphone error: ${err.message}`, 'error', 4500);
    }
  }

  // --- Pass 1: Guide Beat & Calibration (Synth Beeps or Backing Track) ---
  function startPass1Calibration() {
    recordingState = 'pass1';
    pass1AudioChunks = [];
    pass1ClickEvents = [];
    totalPass1Samples = 0;
    pass1StreamStartTime = null;
    resetClickBeads();

    if (hudLatencyText) {
      hudLatencyText.textContent = '';
      hudLatencyText.style.display = 'none';
    }

    const isSynthGuide = guideModeSynth ? guideModeSynth.checked : true;

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
      // In synth guide mode, ignore speaker audio during count-in beeps (Beeps 1 to 4)
      if (isSynthGuide && pass1GuideStartTime && now < pass1GuideStartTime + (3.75 * (detectedIntervalSec || 0.5))) return;
      lastTransientTime = now;
      pass1ClickEvents.push({ ctxTime: now, samplePos: samplePos });

      const count = pass1ClickEvents.length;
      if (count >= 1 && bead1) bead1.classList.add('active');
      if (count >= 2 && bead2) bead2.classList.add('active');
      if (count >= 3 && bead3) bead3.classList.add('active');
      if (count >= 4 && bead4) bead4.classList.add('active');

      if (!isSynthGuide && count === 4) {
        recordingState = 'pass1_done';
        if (pass1TimeoutId) {
          clearTimeout(pass1TimeoutId);
          pass1TimeoutId = null;
        }
        if (hudInstruction) hudInstruction.textContent = '4 clicks calibrated! Starting count-in...';

        // Wait ~1.5 beats after 4th click to ensure full ringout is recorded, then stop backing music and finish Pass 1
        const waitTailMs = Math.max(900, Math.round(1.5 * (detectedIntervalSec || 0.67) * 1000));
        pass1PostWaitTimeoutId = setTimeout(async () => {
          audio.stop();
          await finishPass1TrackGuide();
        }, waitTailMs);
      }
    }

    recScriptProcessor.onaudioprocess = (e) => {
      if (pass1StreamStartTime === null && recAudioCtx) {
        pass1StreamStartTime = recAudioCtx.currentTime;
      }
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
      if (recordingState !== 'pass1' && recordingState !== 'pass2_prelude') return;
      if (evt.target.closest('#btnStopRecordingAction')) return;
      evt.preventDefault();
      evt.stopPropagation();
      const now = recAudioCtx ? recAudioCtx.currentTime : (performance.now() / 1000);
      if (now - lastTransientTime > minRefractorySec) {
        if (recordingState === 'pass1') {
          registerClick(now, totalPass1Samples);
        } else if (recordingState === 'pass2_prelude') {
          pass2ClickEvents.push({ ctxTime: now, samplePos: totalPass2Samples });
        }
      }
    };
    if (hudInstructionBox) {
      hudInstructionBox.addEventListener('pointerdown', onHudTap);
    }

    recMicSource.connect(recScriptProcessor);
    recScriptProcessor.connect(recSilentGain);
    recSilentGain.connect(recAudioCtx.destination);

    if (pass1StreamStartTime === null) {
      pass1StreamStartTime = recAudioCtx.currentTime;
    }

    if (isSynthGuide) {
      // --- Option 1: Metronome Synth Beeps Mode ---
      const tempo = Math.max(40, Math.min(240, parseInt(syncSynthTempo?.value, 10) || 90));
      const dt = 60 / tempo;
      detectedIntervalSec = dt; // Authoritative tempo, do NOT guess/estimate!

      if (hudRecStatusText) hudRecStatusText.textContent = 'PASS 1: COUNT-IN';
      if (hudInstruction) hudInstruction.textContent = `Get ready: 4 count-in beeps at ${tempo} BPM...`;
      if (hudClickBeads) {
        hudClickBeads.classList.remove('hidden');
        hudClickBeads.style.display = 'flex';
      }
      if (hudTimer) hudTimer.textContent = 'Pass 1 Guide';

      pass1GuideStartTime = recAudioCtx.currentTime + 0.150;

      // Schedule 8 beeps: 4 count-in + 4 user tap-along
      for (let i = 0; i < 8; i++) {
        const beatTime = pass1GuideStartTime + i * dt;
        const isCountIn = i < 4;
        const freq = isCountIn ? (i === 3 ? 1800 : 900) : (i === 7 ? 1800 : 1000);
        playSynthBeep(beatTime, freq, 0.08);

        const delayMs = Math.max(0, (beatTime - recAudioCtx.currentTime) * 1000);
        setTimeout(() => {
          if (recordingState !== 'pass1') return;
          if (isCountIn) {
            if (hudInstruction) hudInstruction.textContent = `Count-in beep ${i + 1} of 4 (${tempo} BPM)`;
            const bead = [bead1, bead2, bead3, bead4][i];
            if (bead) {
              bead.className = 'click-bead beep';
              setTimeout(() => { if (bead) bead.className = 'click-bead'; }, dt * 450);
            }
          } else {
            const tapIdx = i - 4;
            if (hudRecStatusText) hudRecStatusText.textContent = 'PASS 1: TAP 4 CLICKS';
            if (hudInstruction) hudInstruction.textContent = `Tap along with beeps! Click ${tapIdx + 1} of 4`;
            const bead = [bead1, bead2, bead3, bead4][tapIdx];
            if (bead) {
              bead.className = 'click-bead beep';
              setTimeout(() => {
                if (bead && !bead.classList.contains('active')) bead.className = 'click-bead';
              }, dt * 450);
            }
          }
        }, delayMs);
      }

      // Schedule completion of Pass 1 after Beep 8 finishes + extra recording buffer so 4th tap decay is never cut off
      const pass1EndTime = pass1GuideStartTime + (9.2 * dt) + 0.350;
      const finishDelayMs = Math.max(0, (pass1EndTime - recAudioCtx.currentTime) * 1000);

      pass1PostWaitTimeoutId = setTimeout(async () => {
        if (recordingState !== 'pass1') return;
        recordingState = 'pass1_done';
        if (hudInstruction) hudInstruction.textContent = 'Pass 1 complete! Preparing Pass 2 count-in...';
        await finishPass1SynthGuide(dt);
      }, finishDelayMs);

    } else {
      // --- Option 2: Backing Track Mode ---
      if (hudRecStatusText) hudRecStatusText.textContent = 'PASS 1: TAP 4 CLICKS';
      if (hudInstruction) hudInstruction.textContent = 'Tap 4 sharp clicks / snaps with the rhythm...';
      if (hudClickBeads) {
        hudClickBeads.classList.remove('hidden');
        hudClickBeads.style.display = 'flex';
      }
      if (hudTimer) hudTimer.textContent = '15s limit';

      // Start music playback from recordingStartPlayhead
      audio.seek(recordingStartPlayhead);
      audio.play();

      // 15-second safety timeout
      pass1TimeoutId = setTimeout(() => {
        if (recordingState === 'pass1' && pass1ClickEvents.length < 4) {
          cancelRecording();
          showToast('4 clicks were not detected within 15 seconds. You can tap screen or tap louder.', 'error', 4500);
        }
      }, 15000);
    }
  }

  // --- Finish Pass 1: Metronome Synth Guide Mode ---
  async function finishPass1SynthGuide(dt) {
    if (!isRecording) return;
    const sampleRate = recAudioCtx ? recAudioCtx.sampleRate : 44100;
    const dtSamples = Math.round(dt * sampleRate);

    // Concatenate all Pass 1 recorded PCM
    const totalP1 = pass1AudioChunks.reduce((acc, c) => acc + c.length, 0);
    const p1Full = new Float32Array(totalP1);
    let p1Offset = 0;
    for (const chunk of pass1AudioChunks) {
      p1Full.set(chunk, p1Offset);
      p1Offset += chunk.length;
    }

    const searchWin = Math.round(0.20 * dtSamples);
    const detectedTapPeaks = [];

    // Nominal arrival of Beep 5 in mic recording (assuming 0 latency from stream start)
    const streamStart = pass1StreamStartTime ?? (pass1GuideStartTime - 0.150);
    const nominalBeep5Sec = (pass1GuideStartTime - streamStart) + 4 * dt;
    const nominalBeep5Sample = Math.round(nominalBeep5Sec * sampleRate);

    // 1. Locate User Tap 1 peak (on Beep 5)
    let roughTap1 = nominalBeep5Sample;
    if (pass1ClickEvents.length > 0) {
      roughTap1 = pass1ClickEvents[0].samplePos;
    }
    let pk1 = findTransientPeak(p1Full, roughTap1 - searchWin, roughTap1 + searchWin);
    if (pk1.peakAbs < 0.010 && pass1ClickEvents.length === 0) {
      // If no click event registered, search wider forward window (accounting for hardware roundtrip latency)
      pk1 = findTransientPeak(p1Full, nominalBeep5Sample - Math.round(0.05 * sampleRate), nominalBeep5Sample + Math.round(1.10 * dtSamples));
    }
    const tap1Peak = (pk1.peakAbs >= 0.008) ? pk1.idx : roughTap1;
    detectedTapPeaks.push(tap1Peak);

    // 2. Locate User Taps 2, 3, 4 peaks (on Beeps 6, 7, 8)
    for (let k = 1; k < 4; k++) {
      const expectedK = tap1Peak + k * dtSamples;
      let roughK = expectedK;
      if (pass1ClickEvents[k] && Math.abs(pass1ClickEvents[k].samplePos - expectedK) < 0.35 * dtSamples) {
        roughK = pass1ClickEvents[k].samplePos;
      }
      const pkK = findTransientPeak(p1Full, roughK - searchWin, roughK + searchWin);
      const tapKPeak = (pkK.peakAbs >= 0.008) ? pkK.idx : roughK;
      detectedTapPeaks.push(tapKPeak);
    }

    // Ensure strictly ascending peaks with valid intervals
    for (let k = 1; k < 4; k++) {
      if (detectedTapPeaks[k] <= detectedTapPeaks[k - 1] + Math.round(0.20 * dtSamples)) {
        detectedTapPeaks[k] = detectedTapPeaks[k - 1] + dtSamples;
      }
    }

    // Estimated roundtrip latency readout (informational)
    const estLatencyMs = Math.round(((tap1Peak / sampleRate) - nominalBeep5Sec) * 1000);
    if (hudLatencyText) {
      hudLatencyText.textContent = `Est. Latency: ${estLatencyMs >= 0 ? '+' : ''}${estLatencyMs}ms`;
      hudLatencyText.style.display = 'block';
    }
    console.log(`[Pass 1 Synth Guide] Authoritative tempo: ${dt.toFixed(4)}s (${Math.round(60 / dt)} BPM), Est. Latency: ${estLatencyMs}ms, Tap peaks: [${detectedTapPeaks.join(', ')}]`);

    // 3. Construct TIME-FITTED user calibration audio:
    // Distance between Tap 1 and Tap 2 is exactly 1 beat (dtSamples).
    // Distance between Tap 2 and Tap 3 is exactly 1 beat (dtSamples).
    // Distance between Tap 3 and Tap 4 is exactly 1 beat (dtSamples).
    // User Tap 1 peak is placed at exact index preLeadSamples.
    const preLeadSamples = Math.min(detectedTapPeaks[0], Math.round(0.040 * sampleRate));
    const postRingoutSamples = Math.min(totalP1 - detectedTapPeaks[3], Math.round(1.50 * dtSamples));

    const calibLen = preLeadSamples + (3 * dtSamples) + postRingoutSamples;
    const calibPCM = new Float32Array(calibLen);

    // Attack leading up to Tap 1
    calibPCM.set(p1Full.subarray(detectedTapPeaks[0] - preLeadSamples, detectedTapPeaks[0]), 0);

    // Resample Beat 1 (Tap 1 peak to Tap 2 peak) to exact dtSamples
    calibPCM.set(resampleSegment(p1Full, detectedTapPeaks[0], detectedTapPeaks[1], dtSamples), preLeadSamples);

    // Resample Beat 2 (Tap 2 peak to Tap 3 peak) to exact dtSamples
    calibPCM.set(resampleSegment(p1Full, detectedTapPeaks[1], detectedTapPeaks[2], dtSamples), preLeadSamples + dtSamples);

    // Resample Beat 3 (Tap 3 peak to Tap 4 peak) to exact dtSamples
    calibPCM.set(resampleSegment(p1Full, detectedTapPeaks[2], detectedTapPeaks[3], dtSamples), preLeadSamples + 2 * dtSamples);

    // Full natural ringout after Tap 4
    if (postRingoutSamples > 0) {
      calibPCM.set(p1Full.subarray(detectedTapPeaks[3], detectedTapPeaks[3] + postRingoutSamples), preLeadSamples + 3 * dtSamples);
    }

    // Apply gentle 3ms cosine fade-in and 25ms fade-out
    const fadeInSamples = Math.min(calibPCM.length, Math.round(sampleRate * 0.003));
    for (let i = 0; i < fadeInSamples; i++) {
      calibPCM[i] *= 0.5 * (1 - Math.cos(Math.PI * (i / fadeInSamples)));
    }
    const fadeOutSamples = Math.min(calibPCM.length, Math.round(sampleRate * 0.025));
    for (let i = 0; i < fadeOutSamples; i++) {
      const idx = calibPCM.length - 1 - i;
      calibPCM[idx] *= 0.5 * (1 - Math.cos(Math.PI * (i / fadeOutSamples)));
    }

    // Normalize calibration audio
    let maxCalibAmp = 0;
    for (let i = 0; i < calibPCM.length; i++) {
      const a = Math.abs(calibPCM[i]);
      if (a > maxCalibAmp) maxCalibAmp = a;
    }
    const calibGainVal = maxCalibAmp > 0.01 ? Math.min(3.0, 0.90 / maxCalibAmp) : 2.0;
    for (let i = 0; i < calibPCM.length; i++) {
      calibPCM[i] *= calibGainVal;
    }

    const calibBuffer = recAudioCtx.createBuffer(1, calibPCM.length, sampleRate);
    calibBuffer.getChannelData(0).set(calibPCM);

    await startPass2Flow(calibBuffer, dt, preLeadSamples);
  }

  // --- Finish Pass 1: Backing Track Guide Mode ---
  async function finishPass1TrackGuide() {
    if (!isRecording) return;
    const sampleRate = recAudioCtx ? recAudioCtx.sampleRate : 44100;

    // 1. Gather all recorded PCM from Pass 1
    const totalP1 = pass1AudioChunks.reduce((acc, c) => acc + c.length, 0);
    const p1Full = new Float32Array(totalP1);
    let p1Offset = 0;
    for (const chunk of pass1AudioChunks) {
      p1Full.set(chunk, p1Offset);
      p1Offset += chunk.length;
    }

    // 2. High-precision transient peak detection for all 4 taps in p1Full
    const exactPeaks = [];
    const searchWindowSamples = Math.round(0.12 * sampleRate);

    for (let k = 0; k < 4; k++) {
      const roughPos = pass1ClickEvents[k]?.samplePos ?? Math.round(k * (totalP1 / 4));
      const peakInfo = findTransientPeak(p1Full, roughPos - searchWindowSamples, roughPos + searchWindowSamples);
      exactPeaks.push(peakInfo.idx);
    }

    // 3. Compute tempo using all 4 taps via linear regression & robust outlier-rejected median
    const intervals = [
      (exactPeaks[1] - exactPeaks[0]) / sampleRate,
      (exactPeaks[2] - exactPeaks[1]) / sampleRate,
      (exactPeaks[3] - exactPeaks[2]) / sampleRate
    ];

    const slopeSamples = (3 * (exactPeaks[3] - exactPeaks[0]) + (exactPeaks[2] - exactPeaks[1])) / 10;
    const dtReg = slopeSamples / sampleRate;

    const sortedInts = [...intervals].sort((a, b) => a - b);
    const medianInt = sortedInts[1];
    const consistentInts = intervals.filter(v => Math.abs(v - medianInt) / medianInt < 0.30);
    const avgConsistent = consistentInts.length > 0
      ? (consistentInts.reduce((a, b) => a + b, 0) / consistentInts.length)
      : dtReg;

    let dt = 0.60 * avgConsistent + 0.40 * dtReg;
    if (isNaN(dt) || dt < 0.25 || dt > 1.8) {
      dt = 60 / (state.project?.tempo || 78);
    }
    detectedIntervalSec = dt;
    console.log(`[Pass 1 Track Guide] Detected tempo: ${dt.toFixed(4)}s (${(60 / dt).toFixed(1)} BPM), Tap intervals: ${intervals.map(v => v.toFixed(3)).join(', ')}s`);

    // Latency readout if guide track is selected and not "None"
    const selectedGuideTrackIdx = syncGuideTrackSelect ? syncGuideTrackSelect.value : '';
    if (selectedGuideTrackIdx !== '') {
      try {
        const guideTrack = audio.tracks[parseInt(selectedGuideTrackIdx, 10)];
        if (guideTrack && guideTrack.audioBuffer) {
          const trackChan = guideTrack.audioBuffer.getChannelData(0);
          const trackSR = guideTrack.audioBuffer.sampleRate;
          const latencies = [];
          for (let k = 0; k < 4; k++) {
            const clickTimelineSec = recordingStartPlayhead + (exactPeaks[k] / sampleRate);
            const clickTrackSample = Math.round((clickTimelineSec - (guideTrack.offset || 0)) * trackSR);
            const searchWin = Math.round(0.25 * dt * trackSR);
            const pk = findTransientPeak(trackChan, clickTrackSample - searchWin, clickTrackSample + searchWin);
            if (pk.peakAbs > 0.01) {
              const peakTimelineSec = (pk.idx / trackSR) + (guideTrack.offset || 0);
              latencies.push((clickTimelineSec - peakTimelineSec) * 1000);
            }
          }
          if (latencies.length > 0) {
            const avgLat = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
            if (hudLatencyText) {
              hudLatencyText.textContent = `Est. Latency: ${avgLat >= 0 ? '+' : ''}${avgLat}ms`;
              hudLatencyText.style.display = 'block';
            }
          }
        }
      } catch (err) {
        console.warn('Track guide latency diffing failed:', err);
      }
    } else {
      if (hudLatencyText) {
        hudLatencyText.textContent = '';
        hudLatencyText.style.display = 'none';
      }
    }

    // 4. Extract continuous user calibration audio slice
    const preLeadSamples = Math.min(exactPeaks[0], Math.round(0.040 * sampleRate));
    const startSlice = exactPeaks[0] - preLeadSamples;
    const postRingoutSamples = Math.min(totalP1 - exactPeaks[3], Math.round(1.50 * dt * sampleRate));
    const endSlice = Math.min(totalP1, exactPeaks[3] + postRingoutSamples);

    const calibPCM = p1Full.slice(startSlice, endSlice);

    const fadeInSamples = Math.min(calibPCM.length, Math.round(sampleRate * 0.003));
    for (let i = 0; i < fadeInSamples; i++) {
      calibPCM[i] *= 0.5 * (1 - Math.cos(Math.PI * (i / fadeInSamples)));
    }
    const fadeOutSamples = Math.min(calibPCM.length, Math.round(sampleRate * 0.025));
    for (let i = 0; i < fadeOutSamples; i++) {
      const idx = calibPCM.length - 1 - i;
      calibPCM[idx] *= 0.5 * (1 - Math.cos(Math.PI * (i / fadeOutSamples)));
    }

    let maxCalibAmp = 0;
    for (let i = 0; i < calibPCM.length; i++) {
      const a = Math.abs(calibPCM[i]);
      if (a > maxCalibAmp) maxCalibAmp = a;
    }
    const calibGainVal = maxCalibAmp > 0.01 ? Math.min(3.0, 0.90 / maxCalibAmp) : 2.0;
    for (let i = 0; i < calibPCM.length; i++) {
      calibPCM[i] *= calibGainVal;
    }

    const calibBuffer = recAudioCtx.createBuffer(1, calibPCM.length, sampleRate);
    calibBuffer.getChannelData(0).set(calibPCM);

    await startPass2Flow(calibBuffer, dt, preLeadSamples);
  }

  // --- Pass 2: 8-Click Prelude & Live Recording ---
  async function startPass2Flow(calibBuffer, dt, preLeadSamples) {
    if (!isRecording) return;

    // CRITICAL: Ensure audio context is running and NOT suspended!
    if (!recAudioCtx || recAudioCtx.state === 'closed') {
      recAudioCtx = audio.getOrCreateAudioContext();
    }
    if (recAudioCtx.state === 'suspended' || recAudioCtx.state === 'interrupted') {
      await recAudioCtx.resume();
    }

    const sampleRate = recAudioCtx.sampleRate;

    // Prepare Pass 2 recording pipeline
    pass2AudioChunks = [];
    pass2ClickEvents = [];
    totalPass2Samples = 0;
    pass2StreamStartTime = recAudioCtx ? recAudioCtx.currentTime : null;
    recordingState = 'pass2_prelude';
    resetClickBeads();

    if (hudRecStatusText) hudRecStatusText.textContent = 'PASS 2: COUNT-IN (8 BEATS)';
    if (hudInstruction) hudInstruction.textContent = 'Count-in: 4 beeps + 4 of your clicks...';
    if (hudClickBeads) {
      hudClickBeads.classList.remove('hidden');
      hudClickBeads.style.display = 'flex';
    }

    let p2LastTransientTime = 0;
    let p2AmbientFloor = 0.005;

    recScriptProcessor.onaudioprocess = (e) => {
      if (pass2StreamStartTime === null && recAudioCtx) {
        pass2StreamStartTime = recAudioCtx.currentTime;
      }
      const input = e.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      pass2AudioChunks.push(copy);
      const currentOffset = totalPass2Samples;
      totalPass2Samples += input.length;

      // Real-time transient tracking during Pass 2 prelude
      if (recordingState === 'pass2_prelude') {
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
        p2AmbientFloor = 0.95 * p2AmbientFloor + 0.05 * rms;

        const now = recAudioCtx ? recAudioCtx.currentTime : (performance.now() / 1000);
        if (peak > 0.020 && (peak > p2AmbientFloor * 1.5 || hfMetric > 0.006) && (now - p2LastTransientTime > 0.14)) {
          p2LastTransientTime = now;
          pass2ClickEvents.push({ ctxTime: now, samplePos: currentOffset });
        }
      }
    };

    // Schedule the 8-beat prelude in Web Audio
    const startPreludeTime = recAudioCtx.currentTime + 0.15;

    // Beats 1 to 4: Synthesized beeps
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

    // Beats 5 to 8: Continuous user calibration audio (time-fitted)
    const preLeadSec = preLeadSamples / sampleRate;
    const userAudioStartTime = (startPreludeTime + 4 * dt) - preLeadSec;

    try {
      const calibSrc = recAudioCtx.createBufferSource();
      calibSrc.buffer = calibBuffer;
      const calibGainNode = recAudioCtx.createGain();
      calibGainNode.gain.setValueAtTime(1.2, userAudioStartTime);
      calibSrc.connect(calibGainNode);
      calibGainNode.connect(recAudioCtx.destination);
      calibSrc.start(userAudioStartTime);
    } catch (e) {
      console.warn('Error playing calibration buffer:', e);
    }

    // In 2-pass-mode with synth beeps: MIX Guide 1 beeps 5-8 at -4dB softly in background of user taps
    const isSynthGuide = guideModeSynth ? guideModeSynth.checked : true;
    if (isSynthGuide) {
      const softBeepVol = 0.8 * Math.pow(10, -4 / 20); // 4dB lower than standard beep volume 0.8
      for (let i = 0; i < 4; i++) {
        const beatTime = startPreludeTime + (4 + i) * dt;
        const freq = (i === 3 ? 1800 : 1000); // 1800 Hz on 8th beat before downbeat
        playSynthBeep(beatTime, freq, 0.08, null, softBeepVol);
      }
    }

    // UI bead feedback for Beats 5 to 8
    for (let i = 0; i < 4; i++) {
      const beatTime = startPreludeTime + (4 + i) * dt;
      const delayMs = Math.max(0, (beatTime - recAudioCtx.currentTime) * 1000);
      setTimeout(() => {
        if (recordingState !== 'pass2_prelude') return;
        if (hudInstruction) hudInstruction.textContent = isSynthGuide
          ? `Your Tap ${i + 1} of 4 (with guide beep)`
          : `Your Click ${i + 1} of 4 (calibrating...)`;
        const bead = [bead1, bead2, bead3, bead4][i];
        if (bead) {
          bead.className = 'click-bead active';
          setTimeout(() => { if (bead) bead.className = 'click-bead'; }, dt * 450);
        }
      }, delayMs);
    }

    // Beat 9: DOWNBEAT!
    // Backing music starts playback from recordingStartPlayhead at exact downbeat timestamp
    const downbeatTime = startPreludeTime + 8 * dt;
    pass2DownbeatScheduledTime = downbeatTime;

    audio.seek(recordingStartPlayhead);
    audio.play(downbeatTime);

    // Live metronome during take if requested
    const shouldMetronome = (syncMetronomeOn && syncMetronomeOn.checked);
    if (shouldMetronome) {
      const metroVol = parseDbToLinear(syncMetronomeVolume ? syncMetronomeVolume.value : '0dB');
      const metroTempo = Math.round(60 / dt);
      startLiveMetronome(downbeatTime, metroTempo, metroVol);
    }

    // UI update when downbeat arrives
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

      // Ensure live metronome is actively running if enabled
      if (shouldMetronome && !liveMetronomeIntervalId) {
        const metroVol = parseDbToLinear(syncMetronomeVolume ? syncMetronomeVolume.value : '0dB');
        const metroTempo = Math.round(60 / dt);
        startLiveMetronome(recAudioCtx.currentTime, metroTempo, metroVol);
      }
    }, downbeatDelay);
  }

  // --- Standard Recording Mode (Single-Pass with 4 synth beeps) ---
  async function startStandardPrelude() {
    if (!recAudioCtx || recAudioCtx.state === 'closed') {
      recAudioCtx = audio.getOrCreateAudioContext();
    }
    if (recAudioCtx.state === 'suspended' || recAudioCtx.state === 'interrupted') {
      await recAudioCtx.resume();
    }

    const sampleRate = recAudioCtx.sampleRate;
    const tempo = Math.max(40, Math.min(240, parseInt(singleMetronomeTempo?.value, 10) || state.project?.tempo || 90));
    const dt = 60 / tempo;
    detectedIntervalSec = dt;

    pass2AudioChunks = [];
    pass2ClickEvents = [];
    totalPass2Samples = 0;
    pass2StreamStartTime = recAudioCtx ? recAudioCtx.currentTime : null;
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
      if (pass2StreamStartTime === null && recAudioCtx) {
        pass2StreamStartTime = recAudioCtx.currentTime;
      }
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
    pass2DownbeatScheduledTime = downbeatTime;

    audio.seek(recordingStartPlayhead);
    audio.play(downbeatTime);

    // Live metronome during take if requested in single-pass mode
    const shouldSingleMetro = (singleMetronomeOn && singleMetronomeOn.checked);
    if (shouldSingleMetro) {
      const metroVol = parseDbToLinear(singleMetronomeVolume ? singleMetronomeVolume.value : '0dB');
      startLiveMetronome(downbeatTime, tempo, metroVol);
    }

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

      if (shouldSingleMetro && !liveMetronomeIntervalId) {
        const metroVol = parseDbToLinear(singleMetronomeVolume ? singleMetronomeVolume.value : '0dB');
        startLiveMetronome(recAudioCtx.currentTime, tempo, metroVol);
      }
    }, downbeatDelay);
  }

  // --- Stop Recording & Add New Track ---
  function stopRecording() {
    if (!isRecording) return;
    isRecording = false; // Immediately disable to prevent re-entrant calls
    audio.isRecording = false;
    audio.isRecordingMode = false;
    audio.setPlaybackAudioSession();

    stopLiveMetronome();

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

    // 2. Snapshot timing references BEFORE calling cleanupRecordingNodes()
    const scheduledDownbeatTime = pass2DownbeatScheduledTime;
    const streamStartTime = pass2StreamStartTime;

    // 3. Stop mic stream and processing nodes cleanly
    cleanupRecordingNodes();

    // 4. Stop audio playback
    audio.stop();

    // 5. Process audio and create the new track
    const sampleRate = recAudioCtx ? recAudioCtx.sampleRate : 44100;

    let takePCM = null;

    if (pass2AudioChunks.length > 0) {
      const totalSamples = pass2AudioChunks.reduce((acc, c) => acc + c.length, 0);
      const fullPass2 = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of pass2AudioChunks) {
        fullPass2.set(chunk, offset);
        offset += chunk.length;
      }

      const is2Pass = record2PassSync ? record2PassSync.checked : true;
      const dt = detectedIntervalSec > 0 ? detectedIntervalSec : (60 / (state.project?.tempo || 78));
      const dtSamples = Math.round(dt * sampleRate);

      let projected5thTapSample = 0;

      if (is2Pass) {
        // Alignment specification:
        // The projected location for the peak of the 9th tap (which is the projected location
        // of the 5th user tap in the 2nd recording, preceded by the calibration taps) must coincide
        // exactly with the location of the playhead on the timeline (at the start of recording).
        // This projected location for the 5th tap on the 2nd recording must be the first sample
        // of the newly-recorded track. Timing fit is completely independent of system latency.

        let expectedUser1Sample = 0;
        if (scheduledDownbeatTime && streamStartTime && scheduledDownbeatTime > streamStartTime) {
          expectedUser1Sample = Math.round((scheduledDownbeatTime - (4 * dt) - streamStartTime) * sampleRate);
        } else {
          expectedUser1Sample = Math.round((0.150 + 4 * dt) * sampleRate);
        }

        // Search for the 4 user calibration tap peaks (Beats 5, 6, 7, 8)
        const detectedPeaks = [];
        const winSamples = Math.round(Math.min(0.200 * sampleRate, 0.40 * dtSamples));

        // Use pass2ClickEvents during the calibration window if available:
        const preludeClicks = pass2ClickEvents.filter(ev => {
          const s = ev.samplePos;
          return s >= expectedUser1Sample - winSamples && s < expectedUser1Sample + 4.5 * dtSamples;
        });

        let rough1 = expectedUser1Sample;
        if (preludeClicks.length > 0) {
          rough1 = preludeClicks[0].samplePos;
        }
        const p1 = findTransientPeak(fullPass2, rough1 - winSamples, rough1 + winSamples);

        if (p1.peakAbs >= 0.015 && p1.crest >= 2.0) {
          detectedPeaks.push(p1.idx);

          // Track Taps 2, 3, 4 adaptively spaced by ~dtSamples from previous peak
          for (let k = 1; k < 4; k++) {
            const roughK = detectedPeaks[k - 1] + dtSamples;
            const pk = findTransientPeak(fullPass2, roughK - winSamples, roughK + winSamples);
            if (pk.peakAbs >= 0.012 && pk.crest >= 1.8) {
              detectedPeaks.push(pk.idx);
            } else {
              detectedPeaks.push(roughK);
            }
          }
        } else if (preludeClicks.length >= 3) {
          for (let k = 0; k < Math.min(4, preludeClicks.length); k++) {
            detectedPeaks.push(preludeClicks[k].samplePos);
          }
          while (detectedPeaks.length < 4) {
            detectedPeaks.push(detectedPeaks[detectedPeaks.length - 1] + dtSamples);
          }
        }

        if (detectedPeaks.length === 4) {
          // Linear regression across the 4 calibration taps in the 2nd recording:
          const slope = (3 * (detectedPeaks[3] - detectedPeaks[0]) + (detectedPeaks[2] - detectedPeaks[1])) / 10;
          const centroid = (detectedPeaks[0] + detectedPeaks[1] + detectedPeaks[2] + detectedPeaks[3]) / 4;
          // Projected 5th user tap (Beat 9 downbeat):
          projected5thTapSample = Math.round(centroid + 2.5 * slope);
          console.log(`[nanodaw-2-pass-sync] Calib peaks in Pass 2: [${detectedPeaks.join(', ')}], slope: ${slope.toFixed(1)}, projected 5th tap (Beat 9): ${projected5thTapSample}`);
        } else {
          // Nominal projection from prelude start time
          if (scheduledDownbeatTime && streamStartTime && scheduledDownbeatTime > streamStartTime) {
            projected5thTapSample = Math.round((scheduledDownbeatTime - streamStartTime) * sampleRate);
          } else {
            projected5thTapSample = Math.round((0.150 + 8 * dt) * sampleRate);
          }
          console.log(`[nanodaw-2-pass-sync] Nominal projected 5th tap (Beat 9): ${projected5thTapSample}`);
        }
      } else {
        // Single-pass count-in (4 synth beeps): downbeat is Beat 5
        // Relies on system-reported audio latency for placement
        const sysLatency = (recAudioCtx?.baseLatency || 0.010) + (recAudioCtx?.outputLatency || 0.040);
        if (scheduledDownbeatTime && streamStartTime && scheduledDownbeatTime > streamStartTime) {
          projected5thTapSample = Math.round((scheduledDownbeatTime - streamStartTime + sysLatency) * sampleRate);
        } else {
          projected5thTapSample = Math.round((0.150 + 4 * dt + sysLatency) * sampleRate);
        }
        console.log(`[Single-Pass] Downbeat trim with sysLatency ${(sysLatency * 1000).toFixed(1)}ms: sample ${projected5thTapSample}`);
      }

      const trimSamples = projected5thTapSample;
      console.log(`[Recording Trim] total: ${totalSamples}, projected5thTapSample: ${projected5thTapSample}, trimSamples: ${trimSamples}`);

      if (totalSamples > trimSamples + Math.round(sampleRate * 0.05)) {
        // The projected 5th tap on the 2nd recording becomes the first sample of the newly-recorded track!
        takePCM = fullPass2.subarray(trimSamples);
      } else {
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
    // The first sample of takeBuffer corresponds to the projected 5th tap,
    // which coincides exactly with the playhead at the start of recording!
    audio.addRecordedTrack(takeName, takeBuffer, recordingStartPlayhead, '#ef4444');

    showToast(`Added "${takeName}" (${(takePCM.length / sampleRate).toFixed(1)}s) to project!`, 'success', 4000);
    audio.seek(recordingStartPlayhead);
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
        audio.isRecordingMode = true;
        audio.setPlayAndRecordAudioSession();
        populateSyncGuideTracks();
        updateRecordModalToggles();
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
      audio.isRecordingMode = false;
      audio.setPlaybackAudioSession();
    });
  }
  if (btnCancelRecordSetup && recordSetupModal) {
    btnCancelRecordSetup.addEventListener('click', () => {
      recordSetupModal.classList.add('hidden');
      recordSetupModal.style.display = 'none';
      audio.isRecordingMode = false;
      audio.setPlaybackAudioSession();
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
