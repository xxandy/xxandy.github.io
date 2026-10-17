/**
 * TimelineUI - Interactive multitrack timeline, responsive mobile track handles,
 * track selection, draggable markers, pinch-to-zoom, and selected track inspector.
 */
class TimelineUI {
  constructor(containerEl, stateManager, audioEngine, waveformCache) {
    this.container = containerEl;
    this.state = stateManager;
    this.audio = audioEngine;
    this.waveforms = waveformCache;

    // Viewport & Zoom settings
    this.pixelsPerSecond = this.state.zoom || 60; // Zoom level
    this.minZoomFloor = 0.1; // Supports fitting ~3+ hours on a 1200px screen
    this.minZoom = 0.1;
    this.maxZoom = 300;
    this.scrollLeft = 0;
    this.timelineWidth = 1000;
    this.followPlayhead = true;

    // DOM Elements
    this.rulerCanvas = document.getElementById('rulerCanvas');
    this.markerLayer = document.getElementById('markerLayer');
    this.tracksContainer = document.getElementById('tracksContainer');
    this.playheadLine = document.getElementById('playheadLine');
    this.playheadHandle = document.getElementById('playheadHandle');
    this.timelineScrollArea = document.getElementById('timelineScrollArea');
    this.timelineContent = document.getElementById('timelineContent');
    this.rulerWrap = document.getElementById('rulerWrap');

    // Windowed Viewport Rendering State
    this.activeWindow = null;
    this.rafWindowRenderId = null;

    // Selected Track Pane DOM
    this.paneTrackDot = document.getElementById('paneTrackDot');
    this.paneTrackName = document.getElementById('paneTrackName');
    this.paneOffsetBadge = document.getElementById('paneOffsetBadge');
    this.paneBtnMute = document.getElementById('paneBtnMute');
    this.paneBtnSolo = document.getElementById('paneBtnSolo');
    this.paneVolSlider = document.getElementById('paneVolSlider');
    this.paneVolLabel = document.getElementById('paneVolLabel');
    this.paneVuMeter = document.getElementById('paneVuMeter');
    this.panePrevTrack = document.getElementById('panePrevTrack');
    this.paneNextTrack = document.getElementById('paneNextTrack');

    // Dragging / Touch Interaction State
    this.isDraggingPlayhead = false;
    this.draggingMarkerId = null;
    this.touchPinchInitialDist = null;
    this.touchPinchInitialZoom = null;
    this.touchPinchMidX = null;
    this.isPinching = false;
    this.pinchTargetZoom = null;
    this.pinchFocalTime = 0;
    this.pinchAnchorScreenX = 0;
    this.pinchCanvasFocalX = 0;
    this.pinchTracksOverlay = null;

    // Runtime flag for Option C (hardware-stretched waveform) vs Option A (dots only, waveform suppressed)
    let storedStretch = null;
    try {
      storedStretch = localStorage.getItem('nanodaw_pinch_stretch');
    } catch (_) {}
    this.pinchStretchWaveform = storedStretch !== null ? storedStretch === 'true' : true;

    // Canvas resize observer
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    if (this.timelineScrollArea) {
      this.resizeObserver.observe(this.timelineScrollArea);
    }

    this.initEvents();
    this.initInspectorEvents();
    this.render();
  }

  isMobile() {
    return window.innerWidth <= 768;
  }

  getTrackHeaderWidth() {
    return this.isMobile() ? 44 : 240;
  }

  getTrackHeight() {
    return this.isMobile() ? 64 : 72;
  }

  getRulerHeight() {
    return this.isMobile() ? 28 : 34;
  }

  initEvents() {
    // Scroll event on timeline
    this.timelineScrollArea.addEventListener('scroll', () => {
      this.scrollLeft = this.timelineScrollArea.scrollLeft;
      this.updatePlayheadPosition();
      this.checkWindowedScroll();
    }, { passive: true });

    // Middle mouse button "hand scroll" (drag horizontally) in desktop mode
    this.timelineScrollArea.addEventListener('mousedown', (e) => {
      if (e.button === 1) { // Middle click / wheel button
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startScrollLeft = this.timelineScrollArea.scrollLeft;
        this.isMiddlePanning = true;
        document.body.classList.add('is-middle-panning');

        const onMouseMove = (moveEvent) => {
          if (!this.isMiddlePanning) return;
          moveEvent.preventDefault();
          const dx = moveEvent.clientX - startX;
          // Drag right -> reveal left content (scrollLeft decreases)
          this.timelineScrollArea.scrollLeft = startScrollLeft - dx;
          this.scrollLeft = this.timelineScrollArea.scrollLeft;
        };

        const onMouseUp = (upEvent) => {
          if (upEvent.button === 1 || (upEvent.buttons & 4) === 0) {
            this.isMiddlePanning = false;
            document.body.classList.remove('is-middle-panning');
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            window.removeEventListener('pointerup', onMouseUp);
          }
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        window.addEventListener('pointerup', onMouseUp);
      }
    });

    // Prevent default browser autoscroll indicator on middle click
    this.timelineScrollArea.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    // Zoom via Ctrl + Wheel or trackpad pinch
    this.timelineScrollArea.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // Exponential zoom scaling for smooth micro & macro control
        const zoomFactor = e.deltaY < 0 ? 1.15 : (1 / 1.15);
        if (window.zoomProfiler && window.ZOOM_OP) {
          window.zoomProfiler.startOp(e.deltaY < 0 ? window.ZOOM_OP.ZOOM_IN : window.ZOOM_OP.ZOOM_OUT);
        }
        this.applyZoom(this.pixelsPerSecond * zoomFactor, e.clientX);
        if (window.zoomProfiler) {
          window.zoomProfiler.endOp();
        }
      } else if (e.shiftKey) {
        e.preventDefault();
        // Adaptive horizontal scroll step scaled by zoom density
        const scrollFactor = Math.min(2.0, Math.max(0.3, Math.sqrt(this.pixelsPerSecond / 40)));
        this.timelineScrollArea.scrollLeft += e.deltaY * scrollFactor;
      }
    }, { passive: false });

    // Touch events for mobile pinch-to-zoom
    this.timelineScrollArea.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        this.startPinch(e);
      }
    }, { passive: true });

    this.timelineScrollArea.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault(); // Prevent iOS Safari from interfering with page zoom
        this.updatePinch(e);
      }
    }, { passive: false });

    this.timelineScrollArea.addEventListener('touchend', (e) => {
      if (e.touches.length < 2 && this.isPinching) {
        this.endPinch();
      }
    });

    this.timelineScrollArea.addEventListener('touchcancel', () => {
      if (this.isPinching) {
        this.endPinch();
      }
    });

    // Ruler click / drag for playhead scrub
    const rulerTarget = this.rulerWrap || this.rulerCanvas;
    if (rulerTarget) {
      rulerTarget.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const rect = rulerTarget.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const time = Math.max(0, clickX / this.pixelsPerSecond);
        
        this.isDraggingPlayhead = true;
        this.audio.seek(time);
        
        let rafScrubId = null;
        const onMouseMove = (moveEvent) => {
          if (!this.isDraggingPlayhead) return;
          if (rafScrubId) return;
          rafScrubId = requestAnimationFrame(() => {
            rafScrubId = null;
            if (!this.isDraggingPlayhead) return;
            const currentRect = rulerTarget.getBoundingClientRect();
            const moveX = moveEvent.clientX - currentRect.left;
            const scrubTime = Math.max(0, moveX / this.pixelsPerSecond);
            this.audio.seek(scrubTime);
          });
        };

        const onMouseUp = () => {
          this.isDraggingPlayhead = false;
          if (rafScrubId) {
            cancelAnimationFrame(rafScrubId);
            rafScrubId = null;
          }
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });

      // Double click ruler to add marker
      rulerTarget.addEventListener('dblclick', (e) => {
        const rect = rulerTarget.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const time = Math.max(0, clickX / this.pixelsPerSecond);
        const markerName = prompt('Enter name for new marker:', `Marker ${this.state.markers.length + 1}`);
        if (markerName !== null) {
          this.state.addMarker(markerName, time);
        }
      });
    }

    // Playhead line / handle dragging
    if (this.playheadHandle) {
      this.playheadHandle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        this.isDraggingPlayhead = true;
        const startX = e.clientX;
        const startTime = this.audio.playheadPosition;

        let rafScrubId = null;
        const onMouseMove = (moveEvent) => {
          if (!this.isDraggingPlayhead) return;
          if (rafScrubId) return;
          rafScrubId = requestAnimationFrame(() => {
            rafScrubId = null;
            if (!this.isDraggingPlayhead) return;
            const deltaX = moveEvent.clientX - startX;
            const newTime = Math.max(0, startTime + (deltaX / this.pixelsPerSecond));
            this.audio.seek(newTime);
          });
        };

        const onMouseUp = () => {
          this.isDraggingPlayhead = false;
          if (rafScrubId) {
            cancelAnimationFrame(rafScrubId);
            rafScrubId = null;
          }
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });
    }

    // Audio Engine time updates
    this.audio.on('time_update', ({ time }) => {
      this.updatePlayheadPosition();
      this.checkAutoScroll(time);
    });

    this.audio.on('playback_started', () => this.updatePlayheadPosition());
    this.audio.on('playback_paused', () => this.updatePlayheadPosition());
    this.audio.on('playback_stopped', () => this.updatePlayheadPosition());

    // Chunk-based streaming & progressive decoding events
    this.audio.on('tracks_initialized', () => {
      this.render();
    });

    this.audio.on('chunk_loading', ({ trackIndex }) => {
      this.renderWaveformForTrack(trackIndex);
      this.updateTrackStatus(trackIndex);
    });

    this.audio.on('chunk_decoded', ({ trackIndex }) => {
      this.renderWaveformForTrack(trackIndex);
      this.updateTrackStatus(trackIndex);
    });

    this.audio.on('chunk_error', ({ trackIndex }) => {
      this.renderWaveformForTrack(trackIndex);
      this.updateTrackStatus(trackIndex);
    });

    this.audio.on('track_duration_updated', () => {
      this.updateTimelineDimensions();
      this.renderRuler();
      this.renderWaveforms();
    });

    this.audio.on('track_added', () => {
      this.updateTimelineDimensions();
      this.render();
      this.renderRuler();
      this.renderWaveforms();
      this.updateInspectorPane();
    });

    // State changes
    this.state.subscribe((type, payload) => {
      if (type === 'project_loaded') {
        if (this.state.zoom && this.state.zoom !== this.pixelsPerSecond) {
          this.pixelsPerSecond = this.state.zoom;
          this.updateTimelineDimensions();
        }
        this.render();
        this.updateInspectorPane();
      } else if (type === 'track_volume') {
        const { index, volume } = payload;
        const slider = this.tracksContainer?.querySelector(`.track-vol-slider[data-index="${index}"]`);
        if (slider && parseFloat(slider.value) !== volume) {
          slider.value = volume;
        }
        const label = slider?.parentElement?.querySelector('.vol-label');
        if (label) {
          label.textContent = this.formatGainDb(volume);
        }
        if (index === this.state.selectedTrackIndex) {
          this.updateInspectorPane();
        }
      } else if (type === 'track_mute' || type === 'track_solo' || type === 'all_unmuted' || type === 'solos_cleared') {
        this.updateTrackControlStates();
        this.renderWaveforms();
        this.updateInspectorPane();
      } else if (type === 'track_selected') {
        if (this.tracksContainer) {
          this.tracksContainer.querySelectorAll('.track-row').forEach(row => {
            const idx = parseInt(row.dataset.index, 10);
            row.classList.toggle('track-selected', idx === this.state.selectedTrackIndex);
          });
        }
        this.renderWaveforms();
        this.updateInspectorPane();
      } else if (type === 'zoom_changed') {
        if (payload.zoom && payload.zoom !== this.pixelsPerSecond) {
          this.applyZoom(payload.zoom);
        }
      } else if (type === 'marker_added' || type === 'marker_updated' || type === 'marker_deleted') {
        this.renderMarkerElements();
        this.renderRuler();
      }
    });
  }

  initInspectorEvents() {
    if (this.paneBtnMute) {
      this.paneBtnMute.addEventListener('click', () => {
        this.state.toggleTrackMute(this.state.selectedTrackIndex);
      });
    }
    if (this.paneBtnSolo) {
      this.paneBtnSolo.addEventListener('click', () => {
        this.state.toggleTrackSolo(this.state.selectedTrackIndex);
      });
    }
    if (this.paneVolSlider) {
      this.paneVolSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this.state.setTrackVolume(this.state.selectedTrackIndex, val);
        if (this.paneVolLabel) {
          this.paneVolLabel.textContent = this.formatGainDb(val);
        }
      });
    }
    if (this.panePrevTrack) {
      this.panePrevTrack.addEventListener('click', () => {
        const current = this.state.selectedTrackIndex;
        const total = this.state.project?.tracks?.length || 1;
        this.state.selectTrack((current - 1 + total) % total);
      });
    }
    if (this.paneNextTrack) {
      this.paneNextTrack.addEventListener('click', () => {
        const current = this.state.selectedTrackIndex;
        const total = this.state.project?.tracks?.length || 1;
        this.state.selectTrack((current + 1) % total);
      });
    }
  }

  updateInspectorPane() {
    const idx = this.state.selectedTrackIndex;
    const tracks = this.state.project?.tracks || [];
    const track = tracks[idx];
    const trackState = this.state.tracksState[idx] || { volume: 1.0, mute: false, solo: false };

    if (!track) return;

    if (this.paneTrackDot) {
      this.paneTrackDot.style.background = track.color || '#00f2fe';
      this.paneTrackDot.style.boxShadow = `0 0 6px ${track.color || '#00f2fe'}`;
    }
    if (this.paneTrackName) {
      this.paneTrackName.textContent = track.name || `Track ${idx + 1}`;
    }
    if (this.paneOffsetBadge) {
      const offset = Number(track.offset) || 0;
      this.paneOffsetBadge.textContent = offset > 0 ? `+${offset.toFixed(2)}s` : 't0 (0.0s)';
    }
    if (this.paneBtnMute) {
      this.paneBtnMute.classList.toggle('active', trackState.mute);
    }
    if (this.paneBtnSolo) {
      this.paneBtnSolo.classList.toggle('active', trackState.solo);
    }
    if (this.paneVolSlider) {
      this.paneVolSlider.value = trackState.volume;
    }
    if (this.paneVolLabel) {
      this.paneVolLabel.textContent = this.formatGainDb(trackState.volume);
    }
  }

  handleResize() {
    this.maxZoom = this.computeProjectMaxZoom();
    this.minZoom = this.computeProjectMinZoom();

    // If current zoom exceeds the newly recomputed maxZoom (e.g. switching from desktop to mobile),
    // automatically zoom out to respect the new safe memory limit.
    if (this.pixelsPerSecond > this.maxZoom) {
      this.applyZoom(this.maxZoom);
      return;
    }
    if (this.pixelsPerSecond < this.minZoom) {
      this.applyZoom(this.minZoom);
      return;
    }

    this.updateTimelineDimensions();
    this.renderRuler();
    this.renderWaveforms();
    this.updatePlayheadPosition();
    this.renderMarkerElements();
  }

  computeProjectMinZoom() {
    const totalDur = Math.max(this.audio.getTotalDuration(), 5);
    const headerWidth = this.getTrackHeaderWidth();
    const visibleW = Math.max(100, this.timelineScrollArea.clientWidth - headerWidth - 30);
    const fitLevel = visibleW / totalDur;
    return Math.max(this.minZoomFloor, fitLevel);
  }

  computeProjectMaxZoom() {
    // With windowed viewport rendering, memory is strictly O(1) (<1MB per track)
    // and canvas dimensions never exceed ~2500px, so we can support deep audio inspection (300 px/s)
    const minZoomLevel = this.computeProjectMinZoom();
    return Math.max(minZoomLevel, 300);
  }

  getViewportWindow() {
    const scrollLeft = this.timelineScrollArea ? this.timelineScrollArea.scrollLeft : 0;
    const clientWidth = this.timelineScrollArea ? this.timelineScrollArea.clientWidth : 1200;
    const headerWidth = this.getTrackHeaderWidth();
    const visibleWaveWidth = Math.max(100, clientWidth - headerWidth);

    // If project fits within visible wave area, full timeline is visible without overscan
    if (this.timelineWidth <= visibleWaveWidth + 100) {
      return {
        startX: 0,
        width: this.timelineWidth,
        startSec: 0,
        endSec: Math.max(10, this.audio.getTotalDuration()),
        overscan: 0,
        visibleWaveWidth
      };
    }

    // Overscan margin: 50% of visible waveform width on either side (minimum 300px)
    const overscan = Math.max(300, Math.round(visibleWaveWidth * 0.5));
    const startX = Math.max(0, Math.floor(scrollLeft - overscan));
    const endX = Math.min(this.timelineWidth, Math.ceil(scrollLeft + visibleWaveWidth + overscan));
    const width = Math.max(100, endX - startX);

    const startSec = Math.max(0, startX / this.pixelsPerSecond);
    const endSec = Math.min(Math.max(10, this.audio.getTotalDuration()), endX / this.pixelsPerSecond);

    return { startX, width, startSec, endSec, overscan, visibleWaveWidth };
  }

  updateViewportWindow() {
    this.activeWindow = this.getViewportWindow();
    return this.activeWindow;
  }

  checkWindowedScroll() {
    if (!this.activeWindow || !this.timelineScrollArea) return;

    const scrollLeft = this.timelineScrollArea.scrollLeft;
    const headerWidth = this.getTrackHeaderWidth();
    const visibleWaveWidth = Math.max(100, this.timelineScrollArea.clientWidth - headerWidth);

    const distToLeft = scrollLeft - this.activeWindow.startX;
    const distToRight = (this.activeWindow.startX + this.activeWindow.width) - (scrollLeft + visibleWaveWidth);
    const threshold = Math.max(80, this.activeWindow.overscan * 0.25);

    if (distToLeft < threshold || distToRight < threshold) {
      if (this.rafWindowRenderId) return;
      this.rafWindowRenderId = requestAnimationFrame(() => {
        this.rafWindowRenderId = null;
        if (window.zoomProfiler && window.zoomProfiler.logEvent && window.PROFILER_STEP) {
          window.zoomProfiler.logEvent(window.PROFILER_STEP.WINDOW_SCROLL, {
            opType: window.PROFILER_OP ? window.PROFILER_OP.SCROLL : 9,
            extraData: Math.round(this.timelineScrollArea ? this.timelineScrollArea.scrollLeft : 0)
          });
        }
        this.updateViewportWindow();
        this.renderRuler();
        this.renderWaveforms();
      });
    }
  }

  updateTimelineDimensions() {
    this.maxZoom = this.computeProjectMaxZoom();
    this.minZoom = this.computeProjectMinZoom();

    // Safety clamp zoom level within dynamic bounds
    if (this.pixelsPerSecond > this.maxZoom) {
      this.pixelsPerSecond = this.maxZoom;
      this.state.setZoom(this.pixelsPerSecond);
    } else if (this.pixelsPerSecond < this.minZoom) {
      this.pixelsPerSecond = this.minZoom;
      this.state.setZoom(this.pixelsPerSecond);
    }

    const headerWidth = this.getTrackHeaderWidth();
    const totalDuration = Math.max(this.audio.getTotalDuration(), 10);
    const availableW = Math.max(100, this.timelineScrollArea.clientWidth - headerWidth - 10);
    const projectContentW = totalDuration * this.pixelsPerSecond;
    const visibleWaveAreaW = projectContentW <= availableW ? availableW : (projectContentW + 100);

    this.timelineWidth = Math.round(Math.max(100, visibleWaveAreaW));

    if (this.timelineContent) {
      this.timelineContent.style.setProperty('--timeline-width', `${this.timelineWidth}px`);
    }

    if (this.markerLayer) {
      this.markerLayer.style.width = `${this.timelineWidth}px`;
    }
  }

  setPinchStretchWaveform(enabled) {
    this.pinchStretchWaveform = !!enabled;
    try {
      localStorage.setItem('nanodaw_pinch_stretch', this.pinchStretchWaveform ? 'true' : 'false');
    } catch (_) {}
    return this.pinchStretchWaveform;
  }

  startPinch(e) {
    if (e.touches.length !== 2) return;
    const t1 = e.touches[0];
    const t2 = e.touches[1];
    this.touchPinchInitialDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
    this.touchPinchInitialZoom = this.pixelsPerSecond;
    this.touchPinchMidX = (t1.clientX + t2.clientX) / 2;
    this.isPinching = true;

    // In pinch mode, do not display full marker elements/labels
    if (this.markerLayer) {
      this.markerLayer.style.display = 'none';
    }

    const rect = this.timelineScrollArea.getBoundingClientRect();
    const headerWidth = this.getTrackHeaderWidth();
    const originX = this.touchPinchMidX - rect.left;

    if (originX <= headerWidth) {
      this.pinchFocalTime = 0;
      this.pinchAnchorScreenX = headerWidth;
    } else {
      this.pinchFocalTime = Math.max(0, (this.scrollLeft + originX - headerWidth) / this.pixelsPerSecond);
      this.pinchAnchorScreenX = originX;
    }

    const win = this.activeWindow || this.getViewportWindow();
    const canvasCssStartX = win ? win.startX : 0;
    const canvasCssWidth = win ? win.width : this.timelineWidth;
    this.pinchCanvasFocalX = (this.pinchFocalTime * this.pixelsPerSecond) - canvasCssStartX;

    // Do NOT apply GPU stretching to ruler canvas - it recomputes in realtime
    if (this.rulerCanvas) {
      this.rulerCanvas.style.transform = 'none';
      this.rulerCanvas.style.transformOrigin = '';
    }

    this.ensurePinchTracksOverlay(canvasCssStartX, canvasCssWidth);

    if (window.zoomProfiler && window.ZOOM_OP) {
      window.zoomProfiler.startOp(window.ZOOM_OP.PINCH);
      if (window.zoomProfiler.logEvent && window.PROFILER_STEP) {
        window.zoomProfiler.logEvent(window.PROFILER_STEP.PINCH_START, {
          opType: window.PROFILER_OP ? window.PROFILER_OP.PINCH : 4,
          extraData: Math.round(this.pixelsPerSecond)
        });
      }
    }
  }

  updatePinch(e) {
    if (!this.isPinching || e.touches.length !== 2 || !this.touchPinchInitialDist) return;
    const t1 = e.touches[0];
    const t2 = e.touches[1];
    const currentDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
    if (currentDist <= 0) return;

    const ratio = currentDist / this.touchPinchInitialDist;
    this.maxZoom = this.computeProjectMaxZoom();
    this.minZoom = this.computeProjectMinZoom();
    const clampedZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.touchPinchInitialZoom * ratio));
    const effectiveRatio = clampedZoom / this.touchPinchInitialZoom;
    this.pinchTargetZoom = clampedZoom;

    // 1. Hardware CSS transform on waveform tracks (Option C vs Option A)
    const canvases = this.tracksContainer ? this.tracksContainer.querySelectorAll('.track-canvas') : [];
    if (this.pinchStretchWaveform) {
      canvases.forEach(c => {
        c.style.transformOrigin = `${this.pinchCanvasFocalX}px 0`;
        c.style.transform = `scaleX(${effectiveRatio})`;
        c.style.opacity = '1';
      });
    } else {
      // Option A: Waveforms dimmed/suppressed, cue dots on ruler are the primary visual
      canvases.forEach(c => {
        c.style.transform = 'none';
        c.style.opacity = '0.12';
      });
    }

    // 2. Timeline ruler recomputes timestamps and draws cue dots in realtime (NO GPU stretching)
    if (this.rulerCanvas) {
      this.rulerCanvas.style.transform = 'none';
    }
    this.renderRuler(clampedZoom, true);
  }

  endPinch() {
    if (!this.isPinching) return;
    this.isPinching = false;

    // Hide uncached tracks cue overlay
    if (this.pinchTracksOverlay) {
      this.pinchTracksOverlay.style.display = 'none';
      const ctx = this.pinchTracksOverlay.getContext('2d');
      ctx.clearRect(0, 0, this.pinchTracksOverlay.width, this.pinchTracksOverlay.height);
    }

    // Restore marker elements layer
    if (this.markerLayer) {
      this.markerLayer.style.display = '';
    }

    // Reset all CSS transforms & opacities on track canvases
    const canvases = this.tracksContainer ? this.tracksContainer.querySelectorAll('.track-canvas') : [];
    canvases.forEach(c => {
      c.style.transform = '';
      c.style.transformOrigin = '';
      c.style.opacity = '';
    });
    if (this.rulerCanvas) {
      this.rulerCanvas.style.transform = '';
      this.rulerCanvas.style.transformOrigin = '';
    }

    // Execute single clean rasterization at the final zoom (renders final waveforms & clean ruler)
    if (this.pinchTargetZoom && Math.abs(this.pinchTargetZoom - this.touchPinchInitialZoom) > 0.05) {
      this.applyZoom(this.pinchTargetZoom, this.touchPinchMidX);
    } else {
      this.renderRuler(); // Clean up cue dots if zoom did not change significantly
      this.renderMarkerElements();
    }

    if (window.zoomProfiler) {
      if (window.zoomProfiler.logEvent && window.PROFILER_STEP) {
        window.zoomProfiler.logEvent(window.PROFILER_STEP.PINCH_END, {
          opType: window.PROFILER_OP ? window.PROFILER_OP.PINCH : 4,
          extraData: Math.round(this.pixelsPerSecond)
        });
      }
      window.zoomProfiler.endOp();
    }

    this.touchPinchInitialDist = null;
    this.touchPinchInitialZoom = null;
    this.touchPinchMidX = null;
    this.pinchTargetZoom = null;
  }

  ensurePinchTracksOverlay(canvasCssStartX, canvasCssWidth) {
    if (!this.pinchTracksOverlay) {
      this.pinchTracksOverlay = document.createElement('canvas');
      this.pinchTracksOverlay.id = 'pinchTracksOverlay';
      this.pinchTracksOverlay.className = 'pinch-tracks-overlay';
      if (this.timelineContent) {
        this.timelineContent.appendChild(this.pinchTracksOverlay);
      }
    }
    const headerWidth = this.getTrackHeaderWidth();
    const tracksH = this.tracksContainer ? this.tracksContainer.offsetHeight : 0;
    const tracksTop = this.tracksContainer ? this.tracksContainer.offsetTop : 0;
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.min(32768, Math.round(canvasCssWidth * dpr));
    const targetH = Math.min(32768, Math.round(tracksH * dpr));

    if (this.pinchTracksOverlay.width !== targetW || this.pinchTracksOverlay.height !== targetH) {
      this.pinchTracksOverlay.width = targetW;
      this.pinchTracksOverlay.height = targetH;
    }
    this.pinchTracksOverlay.style.position = 'absolute';
    this.pinchTracksOverlay.style.top = `${tracksTop}px`;
    this.pinchTracksOverlay.style.left = `${headerWidth + canvasCssStartX}px`;
    this.pinchTracksOverlay.style.width = `${canvasCssWidth}px`;
    this.pinchTracksOverlay.style.height = `${tracksH}px`;
    this.pinchTracksOverlay.style.pointerEvents = 'none';
    this.pinchTracksOverlay.style.zIndex = '20';
    this.pinchTracksOverlay.style.display = 'block';

    const ctx = this.pinchTracksOverlay.getContext('2d');
    ctx.clearRect(0, 0, this.pinchTracksOverlay.width, this.pinchTracksOverlay.height);
  }

  renderPinchTracksOverlay({ zoom, timeToX, stepSec, startTick, endTick, canvasCssStartX, canvasCssWidth }) {
    const isZoomOut = this.isPinching && this.touchPinchInitialZoom && zoom < this.touchPinchInitialZoom;
    if (!isZoomOut) {
      if (this.pinchTracksOverlay) {
        this.pinchTracksOverlay.style.display = 'none';
        const ctx = this.pinchTracksOverlay.getContext('2d');
        ctx.clearRect(0, 0, this.pinchTracksOverlay.width, this.pinchTracksOverlay.height);
      }
      return;
    }

    this.ensurePinchTracksOverlay(canvasCssStartX, canvasCssWidth);

    const rows = this.tracksContainer ? this.tracksContainer.querySelectorAll('.track-row') : [];
    if (rows.length === 0) return;

    const containerRect = this.tracksContainer.getBoundingClientRect();
    const centerYs = [];
    for (let i = 0; i < rows.length; i++) {
      const rowRect = rows[i].getBoundingClientRect();
      centerYs.push((rowRect.top - containerRect.top) + (rowRect.height / 2));
    }

    const dpr = window.devicePixelRatio || 1;
    const tracksH = this.tracksContainer.offsetHeight;
    const ctx = this.pinchTracksOverlay.getContext('2d');

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, canvasCssWidth, tracksH);
    ctx.translate(-canvasCssStartX, 0);

    const effectiveRatio = zoom / this.touchPinchInitialZoom;
    const focalX = this.pinchCanvasFocalX || 0;
    const scaledCanvasLeft = canvasCssStartX + focalX * (1 - effectiveRatio);
    const scaledCanvasRight = canvasCssStartX + focalX + (canvasCssWidth - focalX) * effectiveRatio;

    ctx.fillStyle = '#38bdf8';
    ctx.shadowColor = 'rgba(56, 189, 248, 0.9)';
    ctx.shadowBlur = 5;

    for (let t = startTick; t <= endTick; t += stepSec) {
      const x = timeToX(t);
      if (x < canvasCssStartX - 10 || x > canvasCssStartX + canvasCssWidth + 10) continue;

      // Draw blue circles ONLY on portions where waveforms aren't cached
      const isUncached = !this.pinchStretchWaveform || (x < scaledCanvasLeft - 2 || x > scaledCanvasRight + 2);
      if (!isUncached) continue;

      for (let j = 0; j < centerYs.length; j++) {
        ctx.beginPath();
        ctx.arc(x, centerYs[j], 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.shadowBlur = 0;
    ctx.restore();
  }

  applyZoom(newZoom, originClientX = null) {
    const profiler = window.zoomProfiler;
    const STEP = window.ZOOM_STEP;
    const OP = window.ZOOM_OP;

    let autoStartedOp = false;
    if (profiler && (!profiler.activeStepStarts || profiler.activeStepStarts.size === 0)) {
      profiler.startOp(OP ? OP.ZOOM_IN : 1);
      autoStartedOp = true;
    }

    if (profiler && STEP) profiler.startStep(STEP.COMPUTE_BOUNDS);
    this.maxZoom = this.computeProjectMaxZoom();
    this.minZoom = this.computeProjectMinZoom();

    const clampedZoom = Math.max(this.minZoom, Math.min(this.maxZoom, newZoom));
    if (clampedZoom === this.pixelsPerSecond) {
      if (profiler && STEP) profiler.endStep(STEP.COMPUTE_BOUNDS);
      if (autoStartedOp && profiler) profiler.endOp();
      return;
    }
    if (profiler && STEP) profiler.endStep(STEP.COMPUTE_BOUNDS);

    if (profiler && STEP) profiler.startStep(STEP.CALC_FOCAL_ANCHOR);
    const headerWidth = this.getTrackHeaderWidth();
    const clientWidth = this.timelineScrollArea.clientWidth;
    const visibleWaveW = Math.max(10, clientWidth - headerWidth);

    let focalTime;
    let anchorScreenX;

    if (originClientX !== null) {
      const rect = this.timelineScrollArea.getBoundingClientRect();
      const originX = originClientX - rect.left;

      if (originX <= headerWidth) {
        // Pointer is over the left sticky track headers or margin.
        // Pin the focal point strictly to Time 0:00 at the left bound of the waveform lane.
        focalTime = 0;
        anchorScreenX = headerWidth;
      } else {
        // Pointer is over the waveform timeline.
        focalTime = Math.max(0, (this.scrollLeft + originX - headerWidth) / this.pixelsPerSecond);
        anchorScreenX = originX;
      }
    } else {
      // Zoom via button or shortcut.
      // If the timeline is at the left bound (scrollLeft <= 2) or the project fits within the visible wave area:
      // anchor at Time 0:00 so the project start never expands/scrolls into or behind the track headers.
      if (this.scrollLeft <= 2) {
        focalTime = 0;
        anchorScreenX = headerWidth;
      } else {
        // Anchor to the visual center of the visible waveform lane
        anchorScreenX = headerWidth + (visibleWaveW / 2);
        focalTime = Math.max(0, (this.scrollLeft + anchorScreenX - headerWidth) / this.pixelsPerSecond);
      }
    }
    if (profiler && STEP) profiler.endStep(STEP.CALC_FOCAL_ANCHOR);

    if (profiler && STEP) profiler.startStep(STEP.UPDATE_DIMENSIONS);
    this.pixelsPerSecond = clampedZoom;
    this.state.setZoom(this.pixelsPerSecond);
    this.updateTimelineDimensions();
    if (profiler && STEP) profiler.endStep(STEP.UPDATE_DIMENSIONS);

    if (profiler && STEP) profiler.startStep(STEP.DOM_SCROLL_UPDATE);
    const targetScrollLeft = (focalTime * this.pixelsPerSecond) + headerWidth - anchorScreenX;
    this.timelineScrollArea.scrollLeft = Math.max(0, targetScrollLeft);
    this.scrollLeft = this.timelineScrollArea.scrollLeft;
    if (profiler && STEP) profiler.endStep(STEP.DOM_SCROLL_UPDATE);

    if (profiler && STEP) profiler.startStep(STEP.UPDATE_VIEWPORT_WIN);
    this.updateViewportWindow();
    if (profiler && STEP) profiler.endStep(STEP.UPDATE_VIEWPORT_WIN);

    if (profiler && STEP) profiler.startStep(STEP.RENDER_RULER_TOTAL);
    this.renderRuler();
    if (profiler && STEP) profiler.endStep(STEP.RENDER_RULER_TOTAL);

    if (profiler && STEP) profiler.startStep(STEP.RENDER_WAVEFORMS_TOTAL);
    this.renderWaveforms();
    if (profiler && STEP) profiler.endStep(STEP.RENDER_WAVEFORMS_TOTAL);

    if (profiler && STEP) profiler.startStep(STEP.UPDATE_PLAYHEAD);
    this.updatePlayheadPosition();
    this.renderMarkerElements();
    if (profiler && STEP) profiler.endStep(STEP.UPDATE_PLAYHEAD);

    if (autoStartedOp && profiler) {
      profiler.endOp();
    }
  }

  checkAutoScroll(time) {
    if (!this.followPlayhead || !this.audio.isPlaying || this.isMiddlePanning) return;

    const headerWidth = this.getTrackHeaderWidth();
    const playheadX = headerWidth + (time * this.pixelsPerSecond);
    const viewLeft = this.scrollLeft;
    const viewWidth = this.timelineScrollArea.clientWidth;
    const viewRight = viewLeft + viewWidth;

    if (playheadX > viewRight - 80) {
      this.timelineScrollArea.scrollLeft = Math.max(0, playheadX - 120);
    } else if (playheadX < viewLeft + headerWidth) {
      this.timelineScrollArea.scrollLeft = Math.max(0, playheadX - headerWidth - 40);
    }
  }

  scrollToStart() {
    if (!this.timelineScrollArea) return;
    this.timelineScrollArea.scrollLeft = 0;
    this.scrollLeft = 0;
    this.updateViewportWindow();
    this.renderRuler();
    this.renderWaveforms();
    this.updatePlayheadPosition();
  }

  scrollToTime(time) {
    if (!this.timelineScrollArea) return;
    const headerWidth = this.getTrackHeaderWidth();
    const playheadX = headerWidth + (time * this.pixelsPerSecond);
    const viewWidth = this.timelineScrollArea.clientWidth;
    if (playheadX > viewWidth - 80 || playheadX < headerWidth + 40) {
      this.timelineScrollArea.scrollLeft = Math.max(0, playheadX - (viewWidth / 2));
      this.scrollLeft = this.timelineScrollArea.scrollLeft;
      this.updateViewportWindow();
      this.renderRuler();
      this.renderWaveforms();
    }
  }

  scrollToMarker(time) {
    if (!this.timelineScrollArea) return;
    const markerCanvasX = time * this.pixelsPerSecond;
    // Lead pixels: enough margin before the marker pin so that the entire tag label shows
    const leadPaddingPixels = 90;
    const targetScrollLeft = Math.max(0, markerCanvasX - leadPaddingPixels);
    this.timelineScrollArea.scrollLeft = targetScrollLeft;
    this.scrollLeft = targetScrollLeft;
    this.updateViewportWindow();
    this.renderRuler();
    this.renderWaveforms();
    this.updatePlayheadPosition();
  }

  renderRuler(overrideZoom = null, isPinching = false) {
    if (!this.rulerCanvas) return;

    const zoom = overrideZoom || this.pixelsPerSecond;
    const profiler = window.zoomProfiler;
    const STEP = window.ZOOM_STEP;

    const win = this.activeWindow || this.getViewportWindow();
    const dpr = window.devicePixelRatio || 1;
    const canvasCssWidth = win ? win.width : this.timelineWidth;
    const canvasCssStartX = win ? win.startX : 0;
    const height = this.getRulerHeight();

    const maxDim = 32768;
    const targetW = Math.min(maxDim, Math.round(canvasCssWidth * dpr));
    const targetH = Math.min(maxDim, Math.round(height * dpr));

    // Do NOT resize canvas backing store during pinch to prevent Metal texture stalls
    if (!isPinching) {
      if (profiler && STEP) profiler.startStep(STEP.RULER_CANVAS_RESIZE, 255, targetW);
      if (this.rulerCanvas.width !== targetW || this.rulerCanvas.height !== targetH) {
        this.rulerCanvas.width = targetW;
        this.rulerCanvas.height = targetH;
      }

      this.rulerCanvas.style.width = `${canvasCssWidth}px`;
      this.rulerCanvas.style.height = `${height}px`;
      this.rulerCanvas.style.left = `${canvasCssStartX}px`;
      if (profiler && STEP) profiler.endStep(STEP.RULER_CANVAS_RESIZE, 255, targetW);
    }

    if (profiler && STEP) profiler.startStep(STEP.RULER_CANVAS_PAINT);
    const ctx = this.rulerCanvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, canvasCssWidth, height);

    // Ruler Background
    ctx.fillStyle = 'rgba(14, 18, 26, 0.98)';
    ctx.fillRect(0, 0, canvasCssWidth, height);

    if (win) {
      ctx.translate(-canvasCssStartX, 0);
    }

    // Bottom border line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(canvasCssStartX, height - 0.5);
    ctx.lineTo(canvasCssStartX + canvasCssWidth, height - 0.5);
    ctx.stroke();

    // Adaptive Step Interval Ladder:
    // Ensures ticks always maintain between ~70px and 160px gap across all zoom levels
    const TIME_INTERVALS = [
      0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, // seconds
      60, 120, 300, 600, 900, 1800, 3600       // 1m, 2m, 5m, 10m, 15m, 30m, 1h
    ];
    const minPixelGap = 80;
    const minTimeGap = minPixelGap / zoom;
    let stepSec = TIME_INTERVALS.find(intv => intv >= minTimeGap) || 3600;

    let startSec, endSec, timeToX;

    if (isPinching && this.isPinching) {
      // Anchored strictly to pinch focal point in realtime
      const headerWidth = this.getTrackHeaderWidth();
      const focalScreenX = this.pinchAnchorScreenX;
      const focalTime = this.pinchFocalTime;
      const focalTimelineX = (focalScreenX - headerWidth) + this.scrollLeft;

      timeToX = (t) => focalTimelineX + ((t - focalTime) * zoom);
      startSec = Math.max(0, focalTime - ((focalTimelineX - canvasCssStartX) / zoom));
      endSec = focalTime + ((canvasCssWidth - (focalTimelineX - canvasCssStartX)) / zoom);
    } else {
      const totalSeconds = this.timelineWidth / zoom;
      startSec = win ? win.startSec : 0;
      endSec = win ? win.endSec : totalSeconds;
      timeToX = (t) => t * zoom;
    }

    const startTick = Math.max(0, Math.floor(startSec / stepSec) * stepSec);
    const endTick = Math.ceil(endSec / stepSec) * stepSec;

    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';

    for (let t = startTick; t <= endTick; t += stepSec) {
      const x = timeToX(t);
      if (x < canvasCssStartX - 10 || x > canvasCssStartX + canvasCssWidth + 10) continue;

      const isMajor = Math.abs(t % (stepSec * 5)) < 0.001 || t === 0 || stepSec >= 300;

      ctx.beginPath();
      ctx.moveTo(x, height);
      ctx.lineTo(x, isMajor ? height - 10 : height - 5);
      ctx.stroke();

      // Format time label adaptively:
      let timeLabel = '';
      if (stepSec >= 3600) {
        const hrs = Math.floor(t / 3600);
        const mins = Math.floor((t % 3600) / 60);
        timeLabel = `${hrs}h${mins > 0 ? ` ${mins}m` : ''}`;
      } else if (stepSec >= 60) {
        const mins = Math.floor(t / 60);
        const secs = Math.floor(t % 60);
        timeLabel = secs === 0 ? `${mins}m` : `${mins}:${secs.toString().padStart(2, '0')}`;
      } else if (stepSec >= 1) {
        const mins = Math.floor(t / 60);
        const secs = Math.floor(t % 60);
        timeLabel = `${mins}:${secs.toString().padStart(2, '0')}`;
      } else {
        const mins = Math.floor(t / 60);
        const secs = Math.floor(t % 60);
        const millis = Math.floor((t % 1) * 10);
        timeLabel = `${mins}:${secs.toString().padStart(2, '0')}.${millis}`;
      }

      ctx.fillText(timeLabel, x + 3, 12);

      // Visual cue dots only on the time ruler at the top during pinch
      if (isPinching) {
        ctx.beginPath();
        ctx.arc(x, height - 13, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#38bdf8';
        ctx.shadowColor = 'rgba(56, 189, 248, 0.9)';
        ctx.shadowBlur = 5;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    // Simplified marker indicators on ruler during pinch mode:
    // A circle (slightly larger than scroll indicator) with a thin line pointing down,
    // both colored the same color as the marker.
    if (isPinching && this.state.markers && this.state.markers.length > 0) {
      const markerRadius = 4.5;
      const circleY = height - 13;

      this.state.markers.forEach(marker => {
        const mx = timeToX(marker.time);
        if (mx < canvasCssStartX - 15 || mx > canvasCssStartX + canvasCssWidth + 15) return;

        const markerColor = marker.color || '#38bdf8';

        // Thin line pointing down to the bottom of the ruler bar
        ctx.beginPath();
        ctx.strokeStyle = markerColor;
        ctx.lineWidth = 1;
        ctx.moveTo(mx, circleY);
        ctx.lineTo(mx, height);
        ctx.stroke();

        // Circle colored the same color as the marker
        ctx.beginPath();
        ctx.arc(mx, circleY, markerRadius, 0, Math.PI * 2);
        ctx.fillStyle = markerColor;
        ctx.shadowColor = markerColor;
        ctx.shadowBlur = 4;
        ctx.fill();
        ctx.shadowBlur = 0;
      });
    }

    ctx.restore();
    if (profiler && STEP) profiler.endStep(STEP.RULER_CANVAS_PAINT);

    // Render blue circles on uncached portions of tracks during pinch-to-zoom-out
    if (isPinching && this.isPinching) {
      this.renderPinchTracksOverlay({
        zoom,
        timeToX,
        stepSec,
        startTick,
        endTick,
        canvasCssStartX,
        canvasCssWidth
      });
    } else if (this.pinchTracksOverlay) {
      this.pinchTracksOverlay.style.display = 'none';
      const pctx = this.pinchTracksOverlay.getContext('2d');
      pctx.clearRect(0, 0, this.pinchTracksOverlay.width, this.pinchTracksOverlay.height);
    }
  }

  renderMarkerElements() {
    if (!this.markerLayer || this.isPinching) return;
    this.markerLayer.innerHTML = '';

    const markers = this.state.markers;
    markers.forEach((marker) => {
      const markerX = (marker.time * this.pixelsPerSecond);

      const el = document.createElement('div');
      el.className = 'marker-flag';
      el.dataset.id = marker.id;
      el.style.left = `${markerX}px`;
      el.style.borderColor = marker.color;

      if (markerX < 60) {
        el.classList.add('marker-align-left');
      } else if (markerX > this.timelineWidth - 120) {
        el.classList.add('marker-align-right');
      } else {
        el.classList.add('marker-align-center');
      }

      const mins = Math.floor(marker.time / 60);
      const secs = (marker.time % 60).toFixed(1).padStart(4, '0');

      el.innerHTML = `
        <div class="marker-tag" style="background: ${marker.color}22; border-color: ${marker.color}">
          <span class="marker-dot" style="background: ${marker.color}"></span>
          <span class="marker-name">${this.escapeHtml(marker.name)}</span>
          <span class="marker-time">${mins}:${secs}</span>
          <button class="marker-del-btn" title="Delete Marker" data-del="${marker.id}">&times;</button>
        </div>
        <div class="marker-guide-line" style="border-color: ${marker.color}55"></div>
      `;

      el.addEventListener('click', (e) => {
        if (e.target.closest('.marker-del-btn')) {
          e.stopPropagation();
          const delId = e.target.closest('.marker-del-btn').dataset.del;
          if (confirm(`Delete marker "${marker.name}"?`)) {
            this.state.deleteMarker(delId);
          }
          return;
        }

        this.audio.seek(marker.time);
        this.scrollToMarker(marker.time);
      });

      const tag = el.querySelector('.marker-tag');
      tag.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const newName = prompt('Rename marker:', marker.name);
        if (newName !== null) {
          this.state.updateMarker(marker.id, { name: newName });
        }
      });

      tag.addEventListener('mousedown', (e) => {
        if (e.target.closest('.marker-del-btn')) return;
        e.stopPropagation();

        this.draggingMarkerId = marker.id;
        const startClientX = e.clientX;
        const originalTime = marker.time;

        const onMouseMove = (moveEvent) => {
          if (this.draggingMarkerId !== marker.id) return;
          const deltaX = moveEvent.clientX - startClientX;
          const newTime = Math.max(0, originalTime + (deltaX / this.pixelsPerSecond));
          const currentX = newTime * this.pixelsPerSecond;
          el.style.left = `${currentX}px`;
          el.classList.toggle('marker-align-left', currentX < 60);
          el.classList.toggle('marker-align-right', currentX > this.timelineWidth - 120);
          el.classList.toggle('marker-align-center', currentX >= 60 && currentX <= this.timelineWidth - 120);
          this.state.updateMarker(marker.id, { time: newTime });
        };

        const onMouseUp = () => {
          this.draggingMarkerId = null;
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });

      this.markerLayer.appendChild(el);
    });

    this.updateMarkerPillBar();
  }

  updateMarkerPillBar() {
    const navBar = document.querySelector('.marker-nav-bar');
    const pillContainer = document.getElementById('markerPillList');
    const markers = this.state.markers;

    if (!markers || markers.length === 0) {
      if (navBar) navBar.classList.add('hidden');
      if (pillContainer) pillContainer.innerHTML = '';
      return;
    }

    if (navBar) navBar.classList.remove('hidden');
    if (!pillContainer) return;

    pillContainer.innerHTML = '';

    markers.forEach(m => {
      const pill = document.createElement('button');
      pill.className = 'marker-pill';
      const mins = Math.floor(m.time / 60);
      const secs = Math.floor(m.time % 60).toString().padStart(2, '0');
      
      pill.innerHTML = `
        <span class="pill-dot" style="background:${m.color}"></span>
        <span class="pill-title">${this.escapeHtml(m.name)}</span>
        <span class="pill-time">${mins}:${secs}</span>
      `;

      pill.addEventListener('click', () => {
        this.audio.seek(m.time);
        this.scrollToMarker(m.time);
      });

      pillContainer.appendChild(pill);
    });
  }

  /**
   * Render all track rows, sidebar cells (desktop controls + mobile handles), and wave canvases
   */
  render() {
    if (!this.tracksContainer) return;

    this.updateTimelineDimensions();
    this.tracksContainer.innerHTML = '';

    const tracks = this.state.project?.tracks || [];
    const hasAnySolo = this.state.tracksState.some(s => s && s.solo);
    const selectedIdx = this.state.selectedTrackIndex;
    const trackHeight = this.getTrackHeight();

    tracks.forEach((t, index) => {
      const trackState = this.state.tracksState[index] || { volume: 1.0, mute: false, solo: false };
      const loadedTrack = this.audio.tracks[index];
      const color = t.color || '#00f2fe';
      const offset = Number(t.offset) || 0;
      const isSelected = index === selectedIdx;

      const isDimmed = hasAnySolo ? !trackState.solo : trackState.mute;

      const row = document.createElement('div');
      row.className = `track-row ${isDimmed ? 'track-dimmed' : ''} ${isSelected ? 'track-selected' : ''}`;
      row.dataset.index = index;

      // Handle track selection when row is clicked
      row.addEventListener('click', () => {
        if (this.state.selectedTrackIndex !== index) {
          this.state.selectTrack(index);
        }
      });

      // Sticky Sidebar Cell (contains Desktop Header AND Mobile Handle - toggled via CSS)
      const sidebarCell = document.createElement('div');
      sidebarCell.className = 'track-sidebar-cell';
      sidebarCell.style.borderLeft = `4px solid ${color}`;

      // In mobile mode only: first click selects track; when already selected, next click toggles mute
      sidebarCell.addEventListener('click', (e) => {
        if (this.isMobile()) {
          e.stopPropagation();
          if (this.state.selectedTrackIndex === index) {
            this.state.toggleTrackMute(index);
          } else {
            this.state.selectTrack(index);
          }
        }
      });

      const offsetStr = offset > 0 ? `+${offset.toFixed(2)}s` : 't0 (0.0s)';

      // Determine initial status text
      let statusText = 'Loading...';
      let isChunkLoading = false;
      if (loadedTrack?.chunks && loadedTrack.chunks.length > 0) {
        const total = loadedTrack.chunks.length;
        const decoded = loadedTrack.chunks.filter(c => c.status === 'decoded').length;
        if (decoded === total) {
          statusText = `${loadedTrack.duration.toFixed(1)}s`;
        } else {
          const decodedSec = Math.min(loadedTrack.duration, decoded * 20);
          statusText = `${Math.round(decodedSec)}s / ${Math.round(loadedTrack.duration)}s`;
          isChunkLoading = loadedTrack.chunks.some(c => c.status === 'loading');
        }
      } else if (loadedTrack?.buffer) {
        statusText = `${loadedTrack.duration.toFixed(1)}s`;
      }

      // 1. Desktop Track Header content
      const desktopHeader = document.createElement('div');
      desktopHeader.className = 'desktop-track-header';
      desktopHeader.innerHTML = `
        <div class="track-info">
          <div class="track-title-row">
            <span class="track-name" title="${this.escapeHtml(t.name)}">${this.escapeHtml(t.name)}</span>
            <span class="track-offset-badge" title="Start Offset from t0">${offsetStr}</span>
          </div>
          <div class="track-sub-info">
            <span class="track-status ${isChunkLoading ? 'loading-pulse' : ''}" id="track_status_${index}">${statusText}</span>
            <span class="track-vu-meter" id="vu_${index}">
              <span class="vu-led"></span>
              <span class="vu-led"></span>
              <span class="vu-led"></span>
              <span class="vu-led"></span>
              <span class="vu-led"></span>
            </span>
          </div>
        </div>
        <div class="track-controls">
          <div class="btn-group">
            <button class="btn-ctrl btn-mute ${trackState.mute ? 'active' : ''}" data-action="mute" data-index="${index}" title="Mute Track (M)">M</button>
            <button class="btn-ctrl btn-solo ${trackState.solo ? 'active' : ''}" data-action="solo" data-index="${index}" title="Solo Track (S)">S</button>
          </div>
          <div class="fader-group">
            <input type="range" class="track-vol-slider" min="0" max="1.5" step="0.01" value="${trackState.volume}" data-index="${index}" title="Volume: ${Math.round(trackState.volume * 100)}%">
            <span class="vol-label">${this.formatGainDb(trackState.volume)}</span>
          </div>
        </div>
      `;

      // 2. Mobile Track Handle content
      const mobileHandle = document.createElement('div');
      mobileHandle.className = 'mobile-track-handle';
      mobileHandle.innerHTML = `
        <span class="track-handle-dot ${trackState.mute ? 'muted' : ''}" style="background: ${color}; color: ${color};" title="Track ${index + 1}: ${trackState.mute ? 'Muted' : 'Active'}"></span>
        <span class="track-handle-num">${index + 1}</span>
      `;

      sidebarCell.appendChild(desktopHeader);
      sidebarCell.appendChild(mobileHandle);
      row.appendChild(sidebarCell);

      // Right Track Waveform Canvas Lane
      const lane = document.createElement('div');
      lane.className = 'track-lane';

      const canvas = document.createElement('canvas');
      canvas.className = 'track-canvas';
      canvas.dataset.index = index;
      lane.appendChild(canvas);

      row.appendChild(lane);
      this.tracksContainer.appendChild(row);
    });

    this.bindTrackControlEvents();
    this.renderWaveforms();
    this.renderRuler();
    this.renderMarkerElements();
    this.updatePlayheadPosition();
    this.updateInspectorPane();
  }

  bindTrackControlEvents() {
    this.tracksContainer.querySelectorAll('.btn-mute').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        this.state.toggleTrackMute(idx);
      });
    });

    this.tracksContainer.querySelectorAll('.btn-solo').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        this.state.toggleTrackSolo(idx);
      });
    });

    this.tracksContainer.querySelectorAll('.track-vol-slider').forEach(slider => {
      ['mousedown', 'pointerdown', 'touchstart', 'click'].forEach(evt => {
        slider.addEventListener(evt, (e) => e.stopPropagation());
      });

      slider.addEventListener('input', (e) => {
        const idx = parseInt(slider.dataset.index, 10);
        const val = parseFloat(slider.value);
        this.state.setTrackVolume(idx, val);
        const label = slider.parentElement.querySelector('.vol-label');
        if (label) label.textContent = this.formatGainDb(val);
      });
    });
  }

  updateTrackControlStates() {
    if (!this.tracksContainer) return;
    const hasAnySolo = this.state.tracksState.some(s => s && s.solo);

    this.tracksContainer.querySelectorAll('.track-row').forEach(row => {
      const idx = parseInt(row.dataset.index, 10);
      const trackState = this.state.tracksState[idx] || { volume: 1.0, mute: false, solo: false };
      const isDimmed = hasAnySolo ? !trackState.solo : trackState.mute;

      row.classList.toggle('track-dimmed', isDimmed);

      const btnMute = row.querySelector('.btn-mute');
      if (btnMute) btnMute.classList.toggle('active', trackState.mute);

      const btnSolo = row.querySelector('.btn-solo');
      if (btnSolo) btnSolo.classList.toggle('active', trackState.solo);

      const handleDot = row.querySelector('.track-handle-dot');
      if (handleDot) handleDot.classList.toggle('muted', trackState.mute);
    });
  }

  renderWaveforms() {
    if (!this.tracksContainer) return;

    const win = this.getViewportWindow();
    this.activeWindow = win;

    const canvases = this.tracksContainer.querySelectorAll('.track-canvas');
    const hasAnySolo = this.state.tracksState.some(s => s && s.solo);
    const selectedIdx = this.state.selectedTrackIndex;
    const trackHeight = this.getTrackHeight();

    canvases.forEach(canvas => {
      const idx = parseInt(canvas.dataset.index, 10);
      const loadedTrack = this.audio.tracks[idx];
      const trackState = this.state.tracksState[idx] || { volume: 1.0, mute: false, solo: false };
      const isDimmed = hasAnySolo ? !trackState.solo : trackState.mute;
      const isSelected = idx === selectedIdx;

      this.waveforms.renderTrackCanvas(
        canvas,
        loadedTrack,
        this.pixelsPerSecond,
        this.timelineWidth,
        trackHeight,
        {
          isMuted: trackState.mute,
          isSoloed: trackState.solo,
          isDimmed,
          isSelected,
          window: win
        }
      );
    });
  }

  renderWaveformForTrack(trackIndex) {
    if (!this.tracksContainer) return;
    const canvas = this.tracksContainer.querySelector(`.track-canvas[data-index="${trackIndex}"]`);
    if (!canvas) return;

    const win = this.activeWindow || this.getViewportWindow();
    const loadedTrack = this.audio.tracks[trackIndex];
    const trackState = this.state.tracksState[trackIndex] || { volume: 1.0, mute: false, solo: false };
    const hasAnySolo = this.state.tracksState.some(s => s && s.solo);
    const isDimmed = hasAnySolo ? !trackState.solo : trackState.mute;
    const isSelected = trackIndex === this.state.selectedTrackIndex;
    const trackHeight = this.getTrackHeight();

    this.waveforms.renderTrackCanvas(
      canvas,
      loadedTrack,
      this.pixelsPerSecond,
      this.timelineWidth,
      trackHeight,
      {
        isMuted: trackState.mute,
        isSoloed: trackState.solo,
        isDimmed,
        isSelected,
        window: win
      }
    );
  }

  updateTrackStatus(trackIndex) {
    const statusEl = document.getElementById(`track_status_${trackIndex}`);
    if (!statusEl) return;
    const loadedTrack = this.audio.tracks[trackIndex];
    if (!loadedTrack) return;

    if (loadedTrack.chunks && loadedTrack.chunks.length > 0) {
      const total = loadedTrack.chunks.length;
      const decoded = loadedTrack.chunks.filter(c => c.status === 'decoded').length;
      if (decoded === total) {
        statusEl.textContent = `${loadedTrack.duration.toFixed(1)}s`;
        statusEl.classList.remove('loading-pulse');
      } else {
        const decodedSec = Math.min(loadedTrack.duration, decoded * 20);
        statusEl.textContent = `${Math.round(decodedSec)}s / ${Math.round(loadedTrack.duration)}s`;
        if (loadedTrack.chunks.some(c => c.status === 'loading')) {
          statusEl.classList.add('loading-pulse');
        } else {
          statusEl.classList.remove('loading-pulse');
        }
      }
    } else if (loadedTrack.buffer) {
      statusEl.textContent = `${loadedTrack.duration.toFixed(1)}s`;
      statusEl.classList.remove('loading-pulse');
    } else {
      statusEl.textContent = 'Loading...';
    }
  }

  updatePlayheadPosition() {
    const time = (this.audio && this.audio.playheadPosition !== undefined && this.audio.playheadPosition > 0)
      ? this.audio.playheadPosition
      : (this.state.currentTime || 0);
    const headerWidth = this.getTrackHeaderWidth();
    const playheadX = headerWidth + (time * this.pixelsPerSecond);

    if (this.playheadLine) {
      this.playheadLine.style.transform = `translateX(${playheadX}px)`;
      const isBehindSidebar = playheadX < (this.scrollLeft + headerWidth - 1);
      this.playheadLine.style.display = isBehindSidebar ? 'none' : 'block';
    }

    const timeDisplay = document.getElementById('timeDisplay');
    if (timeDisplay) {
      timeDisplay.textContent = this.formatTimecode(time);
    }

    this.updateVUMeters();
  }

  updateVUMeters() {
    if (!this.audio.isPlaying) {
      document.querySelectorAll('.vu-led.lit').forEach(led => led.classList.remove('lit'));
      return;
    }

    // Update track VU meters on desktop
    this.audio.tracks.forEach((track, idx) => {
      const peak = this.audio.getTrackPeak(idx);
      const vuMeter = document.getElementById(`vu_${idx}`);
      if (vuMeter) {
        const leds = vuMeter.querySelectorAll('.vu-led');
        const litCount = Math.floor(peak * (leds.length + 1));
        leds.forEach((led, i) => {
          if (i < litCount) led.classList.add('lit');
          else led.classList.remove('lit');
        });
      }
    });

    // Update Selected Track Inspector Pane VU meter
    const selectedIdx = this.state.selectedTrackIndex;
    const selectedPeak = this.audio.getTrackPeak(selectedIdx);
    if (this.paneVuMeter) {
      const paneLeds = this.paneVuMeter.querySelectorAll('.vu-led');
      const litCount = Math.floor(selectedPeak * (paneLeds.length + 1));
      paneLeds.forEach((led, i) => {
        if (i < litCount) led.classList.add('lit');
        else led.classList.remove('lit');
      });
    }
  }

  formatTimecode(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.floor((seconds % 1) * 1000);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
  }

  formatGainDb(gain) {
    if (gain <= 0.001) return '-inf dB';
    const db = 20 * Math.log10(gain);
    return (db >= 0 ? '+' : '') + db.toFixed(1) + ' dB';
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }
}
