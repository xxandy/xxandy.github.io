/**
 * NANOdaw Ultra-Low-Overhead WebAssembly Zoom Profiler
 * 
 * Logs sub-step timestamps during zoom operations directly into native WebAssembly
 * linear memory (~0.1 nanoseconds per event call) with zero GC and zero string allocations.
 */

(function(global) {
  'use strict';

  // Base64 encoding of the pre-compiled 259-byte circular ring buffer WebAssembly module (16,384 events capacity, 576 KB memory)
  // Exports: memory, record_event, get_event_count, get_buffer_ptr, reset_profiler, get_capacity
  const WASM_PROFILER_BASE64 = 'AGFzbQEAAAABFANgCH9/f39/fHx/AX9gAAF/YAAAAwYFAAEBAgEFAwEACQYGAX8BQQALB1wGBm1lbW9yeQIADHJlY29yZF9ldmVudAAAD2dldF9ldmVudF9jb3VudAABDmdldF9idWZmZXJfcHRyAAIOcmVzZXRfcHJvZmlsZXIAAwxnZXRfY2FwYWNpdHkABApwBVUBAX8jAEH//wBxQQV0QYABaiEIIAggADYCACAIIAE7AQQgCCACOwEGIAggAzoACCAIIAQ6AAkgCCAHNgIMIAggBTkDECAIIAY5AxgjAEEBaiQAIwALBAAjAAsFAEGAAQsGAEEAJAALBgBBgIABCw==';

  const STEP = {
    // Zoom & Viewport operations
    ZOOM_OP_TOTAL: 1,
    COMPUTE_BOUNDS: 2,
    CALC_FOCAL_ANCHOR: 3,
    UPDATE_DIMENSIONS: 4,
    DOM_SCROLL_UPDATE: 5,
    UPDATE_VIEWPORT_WIN: 6,
    RENDER_RULER_TOTAL: 7,
    RULER_CANVAS_RESIZE: 8,
    RULER_CANVAS_PAINT: 9,
    RENDER_WAVEFORMS_TOTAL: 10,
    TRACK_CANVAS_RESIZE: 11, // High-frequency pruned
    TRACK_CANVAS_CLEAR: 12,  // High-frequency pruned
    TRACK_WAVEFORM_PAINT: 13,
    UPDATE_PLAYHEAD: 14,
    POST_RENDER_RAF: 15,
    PINCH_START: 16,
    PINCH_END: 17,
    WINDOW_SCROLL: 18,

    // Audio & Transport
    AUDIO_PLAY: 20,
    AUDIO_PAUSE: 21,
    AUDIO_STOP: 22,
    AUDIO_SEEK: 23,
    AUDIO_LOOP_TOGGLE: 24,
    AUDIO_CTX_RESUME: 25,

    // Mixer & Tracks
    TRACK_VOLUME: 30,
    TRACK_MUTE: 31,
    TRACK_SOLO: 32,
    MASTER_VOLUME: 33,
    TRACK_SELECT: 34,

    // Project & Chunks
    PROJECT_LOAD: 40,
    CHUNK_DECODE_START: 41,
    CHUNK_DECODE_END: 42,

    // Markers
    MARKER_ADD: 50,
    MARKER_UPDATE: 51,
    MARKER_DELETE: 52,

    // Recording Stream & Pipeline Diagnostics
    REC_MODAL_OPEN: 60,
    REC_AUDIO_SESSION_SET: 61,
    REC_ENUMERATE_DEVICES: 62,
    REC_PERMISSION_PROBE: 63,
    REC_VU_START: 64,
    REC_VU_STOP: 65,
    REC_FLOW_START: 66,
    REC_AUDIO_CTX_INIT: 67,
    REC_AUDIO_CTX_RESUME: 68,
    REC_AUDIO_CTX_STATE: 69,
    REC_GUM_REQUEST: 70,
    REC_STREAM_REUSED: 71,
    REC_TRACK_SETTINGS: 72,
    REC_TRACK_EVENT: 73,
    REC_WORKLET_LOAD: 74,
    REC_PIPELINE_ATTACH: 75,
    REC_WORKLET_FIRST_CHUNK: 76,
    REC_WORKLET_HEARTBEAT: 77,
    REC_STREAM_STALL: 78,
    REC_PASS1_START: 79,
    REC_PASS1_FINISH: 80,
    REC_PASS2_START: 81,
    REC_TAKE_START: 82,
    REC_STOP_BEGIN: 83,
    REC_POST_PROCESS: 84,
    REC_STOP_COMPLETE: 85,
    REC_ERROR: 86,

    // System Telemetry & Errors
    SYSTEM_ERROR: 90
  };

  const STEP_NAMES = {
    1: 'ZOOM_OP_TOTAL',
    2: 'COMPUTE_BOUNDS',
    3: 'CALC_FOCAL_ANCHOR',
    4: 'UPDATE_DIMENSIONS',
    5: 'DOM_SCROLL_UPDATE',
    6: 'UPDATE_VIEWPORT_WIN',
    7: 'RENDER_RULER_TOTAL',
    8: 'RULER_CANVAS_RESIZE',
    9: 'RULER_CANVAS_PAINT',
    10: 'RENDER_WAVEFORMS_TOTAL',
    11: 'TRACK_CANVAS_RESIZE',
    12: 'TRACK_CANVAS_CLEAR',
    13: 'TRACK_WAVEFORM_PAINT',
    14: 'UPDATE_PLAYHEAD',
    15: 'POST_RENDER_RAF',
    16: 'PINCH_START',
    17: 'PINCH_END',
    18: 'WINDOW_SCROLL',

    20: 'AUDIO_PLAY',
    21: 'AUDIO_PAUSE',
    22: 'AUDIO_STOP',
    23: 'AUDIO_SEEK',
    24: 'AUDIO_LOOP_TOGGLE',
    25: 'AUDIO_CTX_RESUME',

    30: 'TRACK_VOLUME',
    31: 'TRACK_MUTE',
    32: 'TRACK_SOLO',
    33: 'MASTER_VOLUME',
    34: 'TRACK_SELECT',

    40: 'PROJECT_LOAD',
    41: 'CHUNK_DECODE_START',
    42: 'CHUNK_DECODE_END',

    50: 'MARKER_ADD',
    51: 'MARKER_UPDATE',
    52: 'MARKER_DELETE',

    60: 'REC_MODAL_OPEN',
    61: 'REC_AUDIO_SESSION_SET',
    62: 'REC_ENUMERATE_DEVICES',
    63: 'REC_PERMISSION_PROBE',
    64: 'REC_VU_START',
    65: 'REC_VU_STOP',
    66: 'REC_FLOW_START',
    67: 'REC_AUDIO_CTX_INIT',
    68: 'REC_AUDIO_CTX_RESUME',
    69: 'REC_AUDIO_CTX_STATE',
    70: 'REC_GUM_REQUEST',
    71: 'REC_STREAM_REUSED',
    72: 'REC_TRACK_SETTINGS',
    73: 'REC_TRACK_EVENT',
    74: 'REC_WORKLET_LOAD',
    75: 'REC_PIPELINE_ATTACH',
    76: 'REC_WORKLET_FIRST_CHUNK',
    77: 'REC_WORKLET_HEARTBEAT',
    78: 'REC_STREAM_STALL',
    79: 'REC_PASS1_START',
    80: 'REC_PASS1_FINISH',
    81: 'REC_PASS2_START',
    82: 'REC_TAKE_START',
    83: 'REC_STOP_BEGIN',
    84: 'REC_POST_PROCESS',
    85: 'REC_STOP_COMPLETE',
    86: 'REC_ERROR',

    90: 'SYSTEM_ERROR'
  };

  const OP = {
    ZOOM_IN: 1,
    ZOOM_OUT: 2,
    ZOOM_FIT: 3,
    PINCH: 4,
    TRANSPORT: 5,
    MIXER: 6,
    PROJECT: 7,
    MARKER: 8,
    SCROLL: 9,
    SYSTEM: 10,
    RECORD: 11
  };

  const OP_NAMES = {
    1: 'ZOOM_IN',
    2: 'ZOOM_OUT',
    3: 'ZOOM_FIT',
    4: 'PINCH',
    5: 'TRANSPORT',
    6: 'MIXER',
    7: 'PROJECT',
    8: 'MARKER',
    9: 'SCROLL',
    10: 'SYSTEM',
    11: 'RECORD'
  };

  const PHASE = {
    START: 0,
    END: 1,
    POINT: 2
  };

  const STORAGE_KEY_ACTIVE = 'nanodaw_rec_diag_v1';
  const STORAGE_KEY_PREV_HANG = 'nanodaw_rec_prev_hang_v1';

  class ZoomProfiler {
    constructor() {
      this.wasmInstance = null;
      this.wasmExports = null;
      this.isReady = false;
      this.currentOpId = 0;
      this.currentOpType = 0;
      this.activeStepStarts = new Map(); // key -> start timestamp
      this.opStartTime = 0;

      // Structured diagnostic ring buffer for rich recording / device / WebAudio telemetry
      this.diagLogs = [];
      this.maxDiagLogs = 600;
      this.diagSeq = 0;
      this.recordingSession = null;
      this._lastPersistMs = 0;

      this._recoverUnfinishedSession();
      this.initWasm();
    }

    _recoverUnfinishedSession() {
      if (typeof localStorage === 'undefined') return;
      try {
        const raw = localStorage.getItem(STORAGE_KEY_ACTIVE);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.session && parsed.session.status === 'in_progress') {
          parsed.recoveredAt = new Date().toISOString();
          parsed.recoveryNote = 'Previous recording session did not reach completion (possible hang, crash, or page reload during recording).';
          localStorage.setItem(STORAGE_KEY_PREV_HANG, JSON.stringify(parsed));
          console.warn('[Profiler] Preserved unfinished recording diagnostic session from previous run:', parsed.session.sessionId);
        }
      } catch (e) {}
    }

    _persistDiagSnapshot(force = false) {
      if (typeof localStorage === 'undefined') return;
      const now = performance.now();
      if (!force && now - this._lastPersistMs < 750) return;
      this._lastPersistMs = now;
      try {
        const recentEntries = this.diagLogs.slice(-220);
        const payload = {
          savedAt: new Date().toISOString(),
          session: this.recordingSession,
          totalDiagSeq: this.diagSeq,
          entries: recentEntries
        };
        localStorage.setItem(STORAGE_KEY_ACTIVE, JSON.stringify(payload));
      } catch (e) {}
    }

    /**
     * Begin a tracked recording diagnostic session (persisted immediately to survive hangs/reloads)
     */
    beginRecSession(meta = {}) {
      // If a previous session in this tab was somehow still marked in_progress, preserve it first
      if (this.recordingSession && this.recordingSession.status === 'in_progress') {
        this._recoverUnfinishedSession();
      }
      const sessionId = `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      this.recordingSession = {
        sessionId,
        startedAt: new Date().toISOString(),
        startedPerfMs: Number(performance.now().toFixed(2)),
        updatedAt: new Date().toISOString(),
        status: 'in_progress',
        meta
      };
      this.logDiag('REC_SESSION_BEGIN', meta, {
        stepId: STEP.REC_FLOW_START,
        phase: PHASE.START,
        forcePersist: true
      });
      return sessionId;
    }

    /**
     * Update metadata or current stage on the active recording diagnostic session
     */
    updateRecSession(patch = {}, forcePersist = false) {
      if (!this.recordingSession) return;
      Object.assign(this.recordingSession, patch, {
        updatedAt: new Date().toISOString()
      });
      this._persistDiagSnapshot(forcePersist);
    }

    /**
     * Finalize a tracked recording diagnostic session
     */
    endRecSession(status = 'completed', detail = {}) {
      if (this.recordingSession) {
        this.recordingSession.status = status;
        this.recordingSession.endedAt = new Date().toISOString();
        this.recordingSession.endedPerfMs = Number(performance.now().toFixed(2));
        this.recordingSession.summary = detail;
      }
      this.logDiag(`REC_SESSION_${String(status).toUpperCase()}`, detail, {
        stepId: status === 'error' ? STEP.REC_ERROR : STEP.REC_STOP_COMPLETE,
        phase: PHASE.END,
        forcePersist: true
      });
    }

    /**
     * Log a rich structured diagnostic event (device labels, getUserMedia constraints, AudioContext state, etc.)
     */
    logDiag(stage, detail = {}, options = {}) {
      const now = performance.now();
      const level = options.level || 'info';
      const entry = {
        seq: this.diagSeq++,
        t_ms: Number(now.toFixed(3)),
        iso: new Date().toISOString(),
        level,
        stage,
        recSessionId: this.recordingSession ? this.recordingSession.sessionId : null,
        detail
      };

      this.diagLogs.push(entry);
      if (this.diagLogs.length > this.maxDiagLogs) {
        this.diagLogs.splice(0, this.diagLogs.length - this.maxDiagLogs);
      }

      if (this.recordingSession) {
        this.recordingSession.lastStage = stage;
        this.recordingSession.updatedAt = entry.iso;
      }

      if (typeof options.stepId === 'number') {
        this.logEvent(options.stepId, {
          opType: typeof options.opType === 'number' ? options.opType : OP.RECORD,
          phase: typeof options.phase === 'number' ? options.phase : PHASE.POINT,
          trackIndex: typeof options.trackIndex === 'number' ? options.trackIndex : 255,
          duration: typeof options.duration === 'number' ? options.duration : 0,
          extraData: typeof options.extraData === 'number' ? options.extraData : 0
        });
      }

      const forcePersist = Boolean(options.forcePersist || level === 'error' || level === 'warn');
      this._persistDiagSnapshot(forcePersist);

      if (typeof console !== 'undefined') {
        const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        try {
          fn.call(console, `[RecDiag +${entry.t_ms.toFixed(1)}ms] ${stage}`, detail);
        } catch (e) {}
      }

      return entry;
    }

    getDiagCount() {
      return this.diagLogs.length;
    }

    initWasm() {
      try {
        const binaryStr = atob(WASM_PROFILER_BASE64);
        const len = binaryStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        const module = new WebAssembly.Module(bytes);
        this.wasmInstance = new WebAssembly.Instance(module, {});
        this.wasmExports = this.wasmInstance.exports;
        this.isReady = true;
        console.log('[Profiler] Circular WASM ring-buffer profiler initialized (Capacity: 16,384 events, 576 KB).');
      } catch (e) {
        console.warn('[Profiler] Failed to compile WASM profiler, falling back:', e);
      }
    }

    /**
     * Start a new zoom operation (e.g. Zoom In click, Zoom Out click, Pinch gesture)
     */
    startOp(opType = OP.ZOOM_IN) {
      this.currentOpId++;
      this.currentOpType = opType;
      this.opStartTime = performance.now();
      this.startStep(STEP.ZOOM_OP_TOTAL);
    }

    /**
     * Complete the current zoom operation
     */
    endOp() {
      const opId = this.currentOpId;
      const opType = this.currentOpType;
      this.endStep(STEP.ZOOM_OP_TOTAL);

      // Measure post-render compositor paint completion via next rAF
      if (typeof requestAnimationFrame === 'function') {
        const rafStart = performance.now();
        requestAnimationFrame(() => {
          const rafEnd = performance.now();
          const rafDur = rafEnd - rafStart;
          if (this.wasmExports) {
            try {
              this.wasmExports.record_event(
                opId,
                opType,
                STEP.POST_RENDER_RAF,
                PHASE.END,
                255,
                rafEnd,
                rafDur,
                0
              );
            } catch (e) {}
          }
        });
      }
    }

    /**
     * Mark the start of a meaningful sub-step
     */
    startStep(stepId, trackIndex = 255, extraData = 0) {
      const now = performance.now();
      const key = (stepId << 8) | (trackIndex & 0xff);
      this.activeStepStarts.set(key, now);

      if (this.wasmExports) {
        try {
          this.wasmExports.record_event(
            this.currentOpId,
            this.currentOpType,
            stepId,
            PHASE.START,
            trackIndex,
            now,
            0.0,
            extraData
          );
        } catch (e) {
          console.warn('[Profiler] record_event error:', e);
        }
      }
    }

    /**
     * Mark the completion of a meaningful sub-step
     */
    endStep(stepId, trackIndex = 255, extraData = 0) {
      const now = performance.now();
      const key = (stepId << 8) | (trackIndex & 0xff);
      const start = this.activeStepStarts.get(key) || now;
      this.activeStepStarts.delete(key);
      const duration = Math.max(0, now - start);

      if (this.wasmExports) {
        try {
          this.wasmExports.record_event(
            this.currentOpId,
            this.currentOpType,
            stepId,
            PHASE.END,
            trackIndex,
            now,
            duration,
            extraData
          );
        } catch (e) {
          console.warn('[Profiler] record_event error:', e);
        }
      }
      return duration;
    }

    /**
     * Log an instantaneous or standalone event point into the ring buffer
     */
    logEvent(stepId, options = {}) {
      if (!this.wasmExports) return;
      const now = performance.now();
      const opType = typeof options.opType === 'number' ? options.opType : (this.currentOpType || 0);
      const trackIndex = typeof options.trackIndex === 'number' ? options.trackIndex : 255;
      const duration = typeof options.duration === 'number' ? options.duration : 0.0;
      const extraData = typeof options.extraData === 'number' ? Math.round(options.extraData) : 0;
      const phase = typeof options.phase === 'number' ? options.phase : PHASE.POINT;
      const opId = typeof options.opId === 'number' ? options.opId : this.currentOpId;

      try {
        this.wasmExports.record_event(
          opId,
          opType,
          stepId,
          phase,
          trackIndex,
          now,
          duration,
          extraData
        );
      } catch (e) {
        console.warn('[Profiler] record_event error:', e);
      }
    }

    /**
     * Total number of events recorded since start/reset
     */
    getEventCount() {
      return this.wasmExports ? this.wasmExports.get_event_count() : 0;
    }

    /**
     * Ring buffer capacity (e.g. 16,384 slots)
     */
    getCapacity() {
      return this.wasmExports && typeof this.wasmExports.get_capacity === 'function'
        ? this.wasmExports.get_capacity()
        : 16384;
    }

    /**
     * Reset the profiler buffer
     */
    reset() {
      if (this.wasmExports) {
        try {
          this.wasmExports.reset_profiler();
        } catch (e) {}
      }
      this.currentOpId = 0;
      this.currentOpType = 0;
      this.activeStepStarts.clear();
      this.diagLogs = [];
      this.diagSeq = 0;
      this.recordingSession = null;
    }

    /**
     * Export recorded profile events in chronological order from circular ring buffer
     */
    exportProfile(extraMeta = {}) {
      let totalCount = 0;
      let capacity = 16384;
      const events = [];

      if (this.wasmExports) {
        totalCount = this.wasmExports.get_event_count();
        capacity = typeof this.wasmExports.get_capacity === 'function' ? this.wasmExports.get_capacity() : 16384;
        const ptr = this.wasmExports.get_buffer_ptr();
        const memory = this.wasmExports.memory.buffer;
        const view = new DataView(memory, ptr);
        const STRIDE = 32;

        // Extract events in chronological order from circular ring buffer
        const startSeq = totalCount > capacity ? totalCount - capacity : 0;

        for (let s = startSeq; s < totalCount; s++) {
          const slot = s & (capacity - 1);
          const offset = slot * STRIDE;
          const op_id = view.getUint32(offset + 0, true);
          const op_type = view.getUint16(offset + 4, true);
          const step_id = view.getUint16(offset + 6, true);
          const phase = view.getUint8(offset + 8);
          const track_index = view.getUint8(offset + 9);
          const extra_data = view.getUint32(offset + 12, true);
          const timestamp_ms = view.getFloat64(offset + 16, true);
          const duration_ms = view.getFloat64(offset + 24, true);

          events.push({
            seq: s,
            op_id,
            op_type: OP_NAMES[op_type] || `OP_${op_type}`,
            step_id,
            step_name: STEP_NAMES[step_id] || `STEP_${step_id}`,
            phase: phase === PHASE.START ? 'START' : phase === PHASE.END ? 'END' : 'POINT',
            track_index: track_index === 255 ? null : track_index,
            extra_data,
            timestamp_ms: Number(timestamp_ms.toFixed(4)),
            duration_ms: Number(duration_ms.toFixed(4))
          });
        }
      }

      // Compute initial summary metrics per step for quick human review
      const stepAggregates = {};
      events.forEach(e => {
        if (e.phase === 'END') {
          if (!stepAggregates[e.step_name]) {
            stepAggregates[e.step_name] = { count: 0, sum: 0, min: Infinity, max: -Infinity, values: [] };
          }
          const agg = stepAggregates[e.step_name];
          agg.count++;
          agg.sum += e.duration_ms;
          if (e.duration_ms < agg.min) agg.min = e.duration_ms;
          if (e.duration_ms > agg.max) agg.max = e.duration_ms;
          agg.values.push(e.duration_ms);
        }
      });

      const stepStats = {};
      Object.keys(stepAggregates).forEach(name => {
        const agg = stepAggregates[name];
        const mean = agg.sum / agg.count;
        const variance = agg.values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (agg.count || 1);
        const stddev = Math.sqrt(variance);
        stepStats[name] = {
          count: agg.count,
          mean_ms: Number(mean.toFixed(3)),
          stddev_ms: Number(stddev.toFixed(3)),
          min_ms: Number(agg.min.toFixed(3)),
          max_ms: Number(agg.max.toFixed(3))
        };
      });

      const userAgent = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
      const isIOS = /iPad|iPhone|iPod/.test(userAgent) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const isAndroid = /Android/.test(userAgent);
      const detectedDevice = isIOS ? 'ios' : isAndroid ? 'android' : 'desktop';
      const audioSessionType = (typeof navigator !== 'undefined' && navigator.audioSession)
        ? (navigator.audioSession.type || 'supported_unset')
        : 'unsupported';

      let recoveredUnfinishedSession = null;
      let persistedLastSession = null;
      if (typeof localStorage !== 'undefined') {
        try {
          const prevHangRaw = localStorage.getItem(STORAGE_KEY_PREV_HANG);
          if (prevHangRaw) recoveredUnfinishedSession = JSON.parse(prevHangRaw);
        } catch (e) {}
        try {
          const activeRaw = localStorage.getItem(STORAGE_KEY_ACTIVE);
          if (activeRaw) {
            const parsed = JSON.parse(activeRaw);
            const curId = this.recordingSession ? this.recordingSession.sessionId : null;
            if (!curId || !parsed?.session || parsed.session.sessionId !== curId) {
              persistedLastSession = parsed;
            }
          }
        } catch (e) {}
      }

      return {
        format: 'nanodaw_telemetry_profile_v2',
        bufferType: 'circular_ring_buffer',
        exportedAt: new Date().toISOString(),
        device: {
          platform: detectedDevice,
          userAgent,
          isIOS,
          isAndroid,
          audioSessionType,
          devicePixelRatio: typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1,
          screen: {
            width: typeof window !== 'undefined' && window.screen ? window.screen.width : 0,
            height: typeof window !== 'undefined' && window.screen ? window.screen.height : 0
          },
          viewport: {
            width: typeof window !== 'undefined' ? (window.innerWidth || 0) : 0,
            height: typeof window !== 'undefined' ? (window.innerHeight || 0) : 0
          }
        },
        meta: {
          totalRecorded: totalCount,
          bufferCapacity: capacity,
          bufferWrapped: totalCount > capacity,
          eventsExported: events.length,
          diagEntriesExported: this.diagLogs.length,
          totalOps: this.currentOpId,
          ...extraMeta
        },
        recordingDiagnostics: {
          activeSession: this.recordingSession,
          diagCount: this.diagLogs.length,
          entries: this.diagLogs,
          recoveredUnfinishedSession,
          persistedLastSession
        },
        stepDictionary: STEP_NAMES,
        stepStats,
        events
      };
    }

    /**
     * Download the profile JSON directly as a file on mobile Safari or Chrome
     */
    downloadProfile(extraMeta = {}) {
      const data = this.exportProfile(extraMeta);
      const hasDiag = data && data.recordingDiagnostics && (
        data.recordingDiagnostics.diagCount > 0 ||
        data.recordingDiagnostics.recoveredUnfinishedSession ||
        data.recordingDiagnostics.persistedLastSession
      );
      if (!data || (data.events.length === 0 && !hasDiag)) {
        return { success: false, message: 'No activity recorded yet.' };
      }

      const jsonStr = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const now = new Date();
      const datePart = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `nanodaw_profile_${data.device.platform}_${datePart}.json`;

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        if (a.parentNode) document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 2000);

      return {
        success: true,
        filename,
        totalOps: data.meta.totalOps,
        totalEvents: data.meta.eventsExported,
        totalDiag: data.meta.diagEntriesExported
      };
    }
  }

  const zoomProfiler = new ZoomProfiler();

  global.ZoomProfiler = ZoomProfiler;
  global.zoomProfiler = zoomProfiler;
  global.nanoProfiler = zoomProfiler;
  global.ZOOM_STEP = STEP;
  global.PROFILER_STEP = STEP;
  global.ZOOM_OP = OP;
  global.PROFILER_OP = OP;
  global.PROFILER_PHASE = PHASE;

  if (typeof window !== 'undefined') {
    window.addEventListener('error', (e) => {
      try {
        zoomProfiler.logEvent(STEP.SYSTEM_ERROR, {
          opType: OP.SYSTEM,
          extraData: e.lineno || 0
        });
        zoomProfiler.logDiag('WINDOW_ERROR', {
          message: e.message || String(e),
          filename: e.filename || '',
          lineno: e.lineno || 0,
          colno: e.colno || 0,
          stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 600) : undefined
        }, { level: 'error', forcePersist: true });
      } catch (err) {}
    });
    window.addEventListener('unhandledrejection', (e) => {
      try {
        zoomProfiler.logEvent(STEP.SYSTEM_ERROR, {
          opType: OP.SYSTEM,
          extraData: 999
        });
        const reason = e.reason;
        zoomProfiler.logDiag('UNHANDLED_PROMISE_REJECTION', {
          name: reason && reason.name ? reason.name : undefined,
          message: reason && reason.message ? reason.message : String(reason),
          stack: reason && reason.stack ? String(reason.stack).slice(0, 600) : undefined
        }, { level: 'error', forcePersist: true });
      } catch (err) {}
    });
    window.dumpLog = (extraMeta) => zoomProfiler.exportProfile(extraMeta);
    window.downloadLog = (extraMeta) => zoomProfiler.downloadProfile(extraMeta);
  }

})(typeof window !== 'undefined' ? window : global);
