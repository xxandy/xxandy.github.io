/**
 * StateManager - Handles project state, URL serialization/deserialization,
 * and synchronizing editable parameters (mute, volume, solo, markers, playhead)
 * with the browser URL without saving anywhere else.
 */
class StateManager {
  constructor() {
    this.project = null;
    this.projectUrl = '';
    this.tracksState = []; // Array of { volume: number, mute: boolean, solo: boolean }
    this.markers = [];     // Array of { id: string, name: string, time: number, color: string }
    this.currentTime = 0;
    this.selectedTrackIndex = 0;
    this.zoom = 60; // Pixels per second zoom factor
    this.listeners = new Set();
    this.debounceTimer = null;
  }

  setZoom(zoom) {
    const clamped = Math.max(15, Math.min(300, Math.round(zoom)));
    if (this.zoom !== clamped) {
      this.zoom = clamped;
      this.notify('zoom_changed', { zoom: this.zoom });
    }
  }

  selectTrack(index) {
    const maxIdx = (this.project?.tracks?.length || 1) - 1;
    this.selectedTrackIndex = Math.max(0, Math.min(maxIdx, index));
    this.notify('track_selected', { index: this.selectedTrackIndex });
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notify(changeType, payload) {
    this.listeners.forEach(cb => cb(changeType, payload));
    this.scheduleUrlUpdate();
  }

  /**
   * Load project data and merge with URL parameters
   */
  initProject(projectData, projectUrl) {
    this.project = projectData;
    this.projectUrl = projectUrl;

    const tracks = projectData.tracks || [];
    this.tracksState = tracks.map((track, index) => ({
      volume: typeof track.volume === 'number' ? track.volume : 1.0,
      mute: Boolean(track.mute),
      solo: Boolean(track.solo)
    }));

    // Base markers from project
    this.markers = (projectData.markers || []).map((m, idx) => ({
      id: 'm_' + idx + '_' + Math.random().toString(36).substr(2, 6),
      name: m.name || `Marker ${idx + 1}`,
      time: Math.max(0, Number(m.time) || 0),
      color: m.color || this.getMarkerColor(idx)
    }));

    // Parse URL hash for override parameters
    this.parseUrlHash();

    this.notify('project_loaded', { project: this.project });
  }

  getMarkerColor(index) {
    const palette = ['#00f2fe', '#38ef7d', '#ff758c', '#c471ed', '#f7797d', '#fbb034', '#4facfe'];
    return palette[index % palette.length];
  }

  /**
   * Parse state from URL hash
   */
  parseUrlHash() {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;

    const params = new URLSearchParams(hash);

    // 1. Playhead time
    if (params.has('t')) {
      const t = parseFloat(params.get('t'));
      if (!isNaN(t) && t >= 0) {
        this.currentTime = t;
      }
    }

    // 2. Volumes: "1.0,0.8,0.5,..."
    if (params.has('v')) {
      const vols = params.get('v').split(',');
      vols.forEach((val, idx) => {
        if (this.tracksState[idx]) {
          const num = parseFloat(val);
          if (!isNaN(num) && num >= 0 && num <= 2.0) {
            this.tracksState[idx].volume = num;
          }
        }
      });
    }

    // 3. Mutes: "0,1,0,..." (1 = muted)
    if (params.has('m')) {
      const mutes = params.get('m').split(',');
      mutes.forEach((val, idx) => {
        if (this.tracksState[idx]) {
          this.tracksState[idx].mute = val === '1' || val === 'true';
        }
      });
    }

    // 4. Solos: "0,1,0,..." (1 = soloed)
    if (params.has('s')) {
      const solos = params.get('s').split(',');
      solos.forEach((val, idx) => {
        if (this.tracksState[idx]) {
          this.tracksState[idx].solo = val === '1' || val === 'true';
        }
      });
    }

    // 5. Markers: "Intro@0,Verse 1@14.5,Chorus@36.2"
    if (params.has('markers')) {
      const markerStrs = params.get('markers').split(';');
      if (markerStrs.length > 0 && markerStrs[0] !== '') {
        const loadedMarkers = [];
        markerStrs.forEach((item, idx) => {
          const atIdx = item.lastIndexOf('@');
          if (atIdx !== -1) {
            const rawName = decodeURIComponent(item.substring(0, atIdx));
            const timeVal = parseFloat(item.substring(atIdx + 1));
            if (!isNaN(timeVal) && timeVal >= 0) {
              loadedMarkers.push({
                id: 'm_url_' + idx + '_' + Math.random().toString(36).substr(2, 6),
                name: rawName.trim() || `Marker ${idx + 1}`,
                time: timeVal,
                color: this.getMarkerColor(idx)
              });
            }
          }
        });
        if (loadedMarkers.length > 0) {
          // Sort markers by time
          loadedMarkers.sort((a, b) => a.time - b.time);
          this.markers = loadedMarkers;
        }
      }
    // 6. Zoom factor: "z=75"
    if (params.has('z')) {
      const zVal = parseFloat(params.get('z'));
      if (!isNaN(zVal) && zVal >= 10 && zVal <= 500) {
        this.zoom = Math.round(zVal);
      }
    }
  }

  /**
   * Build URL representation of editable parameters
   */
  buildShareableUrl(includeCurrentTime = true) {
    const url = new URL(window.location.href);

    // Keep project param if set
    if (this.projectUrl) {
      // If default demo.json, we can keep or omit, but keeping makes it unambiguous
      url.searchParams.set('project', this.projectUrl);
    }

    const hashParams = new URLSearchParams();

    // Volume
    const volStr = this.tracksState.map(t => Number(t.volume.toFixed(2))).join(',');
    hashParams.set('v', volStr);

    // Mutes
    if (this.tracksState.some(t => t.mute)) {
      const muteStr = this.tracksState.map(t => t.mute ? '1' : '0').join(',');
      hashParams.set('m', muteStr);
    }

    // Solos
    if (this.tracksState.some(t => t.solo)) {
      const soloStr = this.tracksState.map(t => t.solo ? '1' : '0').join(',');
      hashParams.set('s', soloStr);
    }

    // Markers
    if (this.markers.length > 0) {
      const markerStr = this.markers
        .map(m => `${encodeURIComponent(m.name)}@${Number(m.time.toFixed(2))}`)
        .join(';');
      hashParams.set('markers', markerStr);
    }

    // Zoom factor
    if (this.zoom) {
      hashParams.set('z', Math.round(this.zoom));
    }

    // Playhead time
    if (includeCurrentTime && this.currentTime > 0) {
      hashParams.set('t', Number(this.currentTime.toFixed(2)));
    }

    url.hash = hashParams.toString();
    return url.toString();
  }

  /**
   * Synchronize current state to browser address bar smoothly
   */
  scheduleUrlUpdate() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      if (!this.project) return;
      const shareUrl = this.buildShareableUrl(true);
      window.history.replaceState(null, '', shareUrl);
    }, 150);
  }

  // --- Actions ---

  setTrackVolume(trackIndex, volume) {
    if (!this.tracksState[trackIndex]) return;
    this.tracksState[trackIndex].volume = Math.max(0, Math.min(2.0, volume));
    this.notify('track_volume', { index: trackIndex, volume: this.tracksState[trackIndex].volume });
  }

  toggleTrackMute(trackIndex) {
    if (!this.tracksState[trackIndex]) return;
    this.tracksState[trackIndex].mute = !this.tracksState[trackIndex].mute;
    this.notify('track_mute', { index: trackIndex, mute: this.tracksState[trackIndex].mute });
  }

  toggleTrackSolo(trackIndex) {
    if (!this.tracksState[trackIndex]) return;
    this.tracksState[trackIndex].solo = !this.tracksState[trackIndex].solo;
    this.notify('track_solo', { index: trackIndex, solo: this.tracksState[trackIndex].solo });
  }

  unmuteAll() {
    this.tracksState.forEach((t, i) => {
      t.mute = false;
    });
    this.notify('all_unmuted', {});
  }

  clearAllSolos() {
    this.tracksState.forEach((t, i) => {
      t.solo = false;
    });
    this.notify('solos_cleared', {});
  }

  addMarker(name, time) {
    const newMarker = {
      id: 'm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      name: (name || `Marker ${this.markers.length + 1}`).trim(),
      time: Math.max(0, Number(time) || 0),
      color: this.getMarkerColor(this.markers.length)
    };
    this.markers.push(newMarker);
    this.markers.sort((a, b) => a.time - b.time);
    this.notify('marker_added', { marker: newMarker, markers: this.markers });
    return newMarker;
  }

  updateMarker(id, updates) {
    const marker = this.markers.find(m => m.id === id);
    if (!marker) return;

    if (typeof updates.name === 'string') {
      marker.name = updates.name.trim() || marker.name;
    }
    if (typeof updates.time === 'number') {
      marker.time = Math.max(0, updates.time);
    }
    if (updates.color) {
      marker.color = updates.color;
    }

    this.markers.sort((a, b) => a.time - b.time);
    this.notify('marker_updated', { marker, markers: this.markers });
  }

  deleteMarker(id) {
    const index = this.markers.findIndex(m => m.id === id);
    if (index === -1) return;
    const removed = this.markers.splice(index, 1)[0];
    this.notify('marker_deleted', { marker: removed, markers: this.markers });
  }

  setCurrentTime(t) {
    this.currentTime = Math.max(0, t);
    this.scheduleUrlUpdate();
  }

  getProjectDuration() {
    if (!this.project || !this.project.tracks) return 30;
    let maxDur = 0;
    this.project.tracks.forEach(t => {
      const offset = Number(t.offset) || 0;
      const dur = Number(t.duration) || 30;
      if (offset + dur > maxDur) {
        maxDur = offset + dur;
      }
    });
    return Math.max(maxDur, 10);
  }
}
