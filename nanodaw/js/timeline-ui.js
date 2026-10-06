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
    this.pixelsPerSecond = 60; // Zoom level
    this.minZoom = 15;
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
    return this.isMobile() ? 36 : 250;
  }

  initEvents() {
    // Scroll event on timeline
    this.timelineScrollArea.addEventListener('scroll', () => {
      this.scrollLeft = this.timelineScrollArea.scrollLeft;
      this.updatePlayheadPosition();
    });

    // Zoom via Ctrl + Wheel or trackpad pinch
    this.timelineScrollArea.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const zoomDelta = -e.deltaY * 0.15;
        this.applyZoom(this.pixelsPerSecond + zoomDelta, e.clientX);
      } else if (e.shiftKey) {
        e.preventDefault();
        this.timelineScrollArea.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    // Touch events for mobile pinch-to-zoom
    this.timelineScrollArea.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        this.touchPinchInitialDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        this.touchPinchInitialZoom = this.pixelsPerSecond;
        this.touchPinchMidX = (t1.clientX + t2.clientX) / 2;
      }
    }, { passive: true });

    this.timelineScrollArea.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && this.touchPinchInitialDist) {
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const currentDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        if (this.touchPinchInitialDist > 0) {
          const ratio = currentDist / this.touchPinchInitialDist;
          const targetZoom = this.touchPinchInitialZoom * ratio;
          this.applyZoom(targetZoom, this.touchPinchMidX);
        }
      }
    }, { passive: true });

    this.timelineScrollArea.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) {
        this.touchPinchInitialDist = null;
        this.touchPinchInitialZoom = null;
      }
    });

    // Ruler click / drag for playhead scrub
    this.rulerCanvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const rect = this.rulerCanvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const time = Math.max(0, clickX / this.pixelsPerSecond);
      
      this.isDraggingPlayhead = true;
      this.audio.seek(time);
      
      const onMouseMove = (moveEvent) => {
        if (!this.isDraggingPlayhead) return;
        const moveX = moveEvent.clientX - rect.left;
        const scrubTime = Math.max(0, moveX / this.pixelsPerSecond);
        this.audio.seek(scrubTime);
      };

      const onMouseUp = () => {
        this.isDraggingPlayhead = false;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });

    // Double click ruler to add marker
    this.rulerCanvas.addEventListener('dblclick', (e) => {
      const rect = this.rulerCanvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const time = Math.max(0, clickX / this.pixelsPerSecond);
      const markerName = prompt('Enter name for new marker:', `Marker ${this.state.markers.length + 1}`);
      if (markerName !== null) {
        this.state.addMarker(markerName, time);
      }
    });

    // Playhead line / handle dragging
    if (this.playheadHandle) {
      this.playheadHandle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        this.isDraggingPlayhead = true;
        const startX = e.clientX;
        const startTime = this.audio.playheadPosition;

        const onMouseMove = (moveEvent) => {
          if (!this.isDraggingPlayhead) return;
          const deltaX = moveEvent.clientX - startX;
          const newTime = Math.max(0, startTime + (deltaX / this.pixelsPerSecond));
          this.audio.seek(newTime);
        };

        const onMouseUp = () => {
          this.isDraggingPlayhead = false;
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

    // State changes
    this.state.subscribe((type, payload) => {
      if (type === 'project_loaded' || type === 'track_volume' || type === 'track_mute' || type === 'track_solo' || type === 'all_unmuted' || type === 'solos_cleared') {
        this.render();
        this.updateInspectorPane();
      } else if (type === 'track_selected') {
        this.render();
        this.updateInspectorPane();
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
        this.state.selectTrack(this.state.selectedTrackIndex - 1);
      });
    }
    if (this.paneNextTrack) {
      this.paneNextTrack.addEventListener('click', () => {
        this.state.selectTrack(this.state.selectedTrackIndex + 1);
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
    this.updateTimelineDimensions();
    this.renderRuler();
    this.renderWaveforms();
    this.updatePlayheadPosition();
    this.renderMarkerElements();
  }

  updateTimelineDimensions() {
    const headerWidth = this.getTrackHeaderWidth();
    const totalDuration = Math.max(this.audio.getTotalDuration(), 10);
    const visibleWaveAreaW = Math.max(
      this.timelineScrollArea.clientWidth - headerWidth - 20,
      totalDuration * this.pixelsPerSecond + 150
    );

    this.timelineWidth = visibleWaveAreaW;

    this.timelineContent.style.width = `${headerWidth + this.timelineWidth}px`;
    this.rulerCanvas.style.width = `${this.timelineWidth}px`;
    this.markerLayer.style.width = `${this.timelineWidth}px`;
  }

  applyZoom(newZoom, originClientX = null) {
    const clampedZoom = Math.max(this.minZoom, Math.min(this.maxZoom, newZoom));
    if (clampedZoom === this.pixelsPerSecond) return;

    const headerWidth = this.getTrackHeaderWidth();

    let focalTime = (this.scrollLeft + (this.timelineScrollArea.clientWidth / 2) - headerWidth) / this.pixelsPerSecond;
    if (originClientX !== null) {
      const rect = this.timelineScrollArea.getBoundingClientRect();
      const originX = originClientX - rect.left;
      focalTime = (this.scrollLeft + originX - headerWidth) / this.pixelsPerSecond;
    }

    focalTime = Math.max(0, focalTime);

    this.pixelsPerSecond = clampedZoom;
    this.updateTimelineDimensions();

    if (originClientX !== null) {
      const rect = this.timelineScrollArea.getBoundingClientRect();
      const originX = originClientX - rect.left;
      this.timelineScrollArea.scrollLeft = (focalTime * this.pixelsPerSecond) + headerWidth - originX;
    } else {
      this.timelineScrollArea.scrollLeft = (focalTime * this.pixelsPerSecond) + headerWidth - (this.timelineScrollArea.clientWidth / 2);
    }

    this.scrollLeft = this.timelineScrollArea.scrollLeft;

    this.renderRuler();
    this.renderWaveforms();
    this.updatePlayheadPosition();
    this.renderMarkerElements();
  }

  checkAutoScroll(time) {
    if (!this.followPlayhead || !this.audio.isPlaying) return;

    const headerWidth = this.getTrackHeaderWidth();
    const playheadX = headerWidth + (time * this.pixelsPerSecond);
    const viewLeft = this.scrollLeft;
    const viewWidth = this.timelineScrollArea.clientWidth;
    const viewRight = viewLeft + viewWidth;

    if (playheadX > viewRight - 80) {
      this.timelineScrollArea.scrollLeft = playheadX - 120;
    } else if (playheadX < viewLeft + headerWidth) {
      this.timelineScrollArea.scrollLeft = Math.max(0, playheadX - headerWidth - 40);
    }
  }

  renderRuler() {
    if (!this.rulerCanvas) return;

    const dpr = window.devicePixelRatio || 1;
    const width = this.timelineWidth;
    const height = this.isMobile() ? 30 : 36;

    if (this.rulerCanvas.width !== width * dpr || this.rulerCanvas.height !== height * dpr) {
      this.rulerCanvas.width = width * dpr;
      this.rulerCanvas.height = height * dpr;
    }

    const ctx = this.rulerCanvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Ruler Background
    ctx.fillStyle = 'rgba(14, 18, 26, 0.95)';
    ctx.fillRect(0, 0, width, height);

    // Bottom border line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 0.5);
    ctx.lineTo(width, height - 0.5);
    ctx.stroke();

    // Step interval
    let stepSec = 1;
    if (this.pixelsPerSecond < 25) stepSec = 10;
    else if (this.pixelsPerSecond < 50) stepSec = 5;
    else if (this.pixelsPerSecond < 100) stepSec = 2;
    else if (this.pixelsPerSecond < 200) stepSec = 1;
    else stepSec = 0.5;

    const totalSeconds = width / this.pixelsPerSecond;

    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';

    for (let t = 0; t <= totalSeconds; t += stepSec) {
      const x = t * this.pixelsPerSecond;
      if (x < 0 || x > width) continue;

      const isMajor = Math.abs(t % (stepSec * 5)) < 0.001 || t === 0;

      ctx.beginPath();
      ctx.moveTo(x, height);
      ctx.lineTo(x, isMajor ? height - 10 : height - 5);
      ctx.stroke();

      if (isMajor || this.pixelsPerSecond >= 70) {
        const mins = Math.floor(t / 60);
        const secs = Math.floor(t % 60);
        const millis = Math.floor((t % 1) * 10);
        let timeLabel = `${mins}:${secs.toString().padStart(2, '0')}`;
        if (stepSec < 1) {
          timeLabel += `.${millis}`;
        }
        ctx.fillText(timeLabel, x + 3, 12);
      }
    }

    ctx.restore();
  }

  renderMarkerElements() {
    if (!this.markerLayer) return;
    this.markerLayer.innerHTML = '';

    const markers = this.state.markers;
    markers.forEach((marker) => {
      const markerX = (marker.time * this.pixelsPerSecond);

      const el = document.createElement('div');
      el.className = 'marker-flag';
      el.dataset.id = marker.id;
      el.style.left = `${markerX}px`;
      el.style.borderColor = marker.color;

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
    const pillContainer = document.getElementById('markerPillList');
    if (!pillContainer) return;

    pillContainer.innerHTML = '';
    const markers = this.state.markers;

    if (markers.length === 0) {
      pillContainer.innerHTML = '<span class="empty-markers-hint">No markers. Double-click ruler or click "+ Marker"</span>';
      return;
    }

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
      });

      pillContainer.appendChild(pill);
    });
  }

  /**
   * Render all track rows, mobile selection handles or desktop headers, and wave canvases
   */
  render() {
    if (!this.tracksContainer) return;

    this.updateTimelineDimensions();
    this.tracksContainer.innerHTML = '';

    const tracks = this.state.project?.tracks || [];
    const hasAnySolo = this.state.tracksState.some(s => s && s.solo);
    const selectedIdx = this.state.selectedTrackIndex;
    const isMobileMode = this.isMobile();

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

      if (isMobileMode) {
        // Mobile Mode: Compact Selection Handle (tiny circle in track color + number)
        const handle = document.createElement('div');
        handle.className = 'mobile-track-handle';
        handle.style.borderLeft = `3px solid ${color}`;
        handle.innerHTML = `
          <span class="track-handle-dot" style="background: ${color}; color: ${color};"></span>
          <span class="track-handle-num">${index + 1}</span>
        `;
        row.appendChild(handle);
      } else {
        // Desktop Mode: Full Track Header with mix controls
        const header = document.createElement('div');
        header.className = 'track-header';
        header.style.borderLeft = `4px solid ${color}`;

        const offsetStr = offset > 0 ? `+${offset.toFixed(2)}s` : 't0 (0.0s)';

        header.innerHTML = `
          <div class="track-info">
            <div class="track-title-row">
              <span class="track-name" title="${this.escapeHtml(t.name)}">${this.escapeHtml(t.name)}</span>
              <span class="track-offset-badge" title="Start Offset from t0">${offsetStr}</span>
            </div>
            <div class="track-sub-info">
              <span class="track-status">${loadedTrack?.buffer ? `${(loadedTrack.duration).toFixed(1)}s` : 'Loading...'}</span>
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
        row.appendChild(header);
      }

      // Right Track Waveform Canvas Lane
      const lane = document.createElement('div');
      lane.className = 'track-lane';
      lane.style.width = `${this.timelineWidth}px`;

      const canvas = document.createElement('canvas');
      canvas.className = 'track-canvas';
      canvas.dataset.index = index;
      lane.appendChild(canvas);

      // Track Lane click to scrub & select
      lane.addEventListener('click', (e) => {
        const rect = lane.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const time = Math.max(0, clickX / this.pixelsPerSecond);
        this.audio.seek(time);
      });

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
      slider.addEventListener('input', (e) => {
        const idx = parseInt(slider.dataset.index, 10);
        const val = parseFloat(slider.value);
        this.state.setTrackVolume(idx, val);
        const label = slider.parentElement.querySelector('.vol-label');
        if (label) label.textContent = this.formatGainDb(val);
      });
    });
  }

  renderWaveforms() {
    if (!this.tracksContainer) return;

    const canvases = this.tracksContainer.querySelectorAll('.track-canvas');
    const hasAnySolo = this.state.tracksState.some(s => s && s.solo);
    const selectedIdx = this.state.selectedTrackIndex;

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
        0,
        this.timelineWidth,
        { isMuted: trackState.mute, isSoloed: trackState.solo, isDimmed, isSelected }
      );
    });
  }

  updatePlayheadPosition() {
    const time = this.audio.playheadPosition;
    const headerWidth = this.getTrackHeaderWidth();
    const playheadX = headerWidth + (time * this.pixelsPerSecond);

    if (this.playheadLine) {
      this.playheadLine.style.transform = `translateX(${playheadX}px)`;
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
