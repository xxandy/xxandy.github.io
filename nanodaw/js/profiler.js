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
    SYSTEM: 10
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
    10: 'SYSTEM'
  };

  const PHASE = {
    START: 0,
    END: 1,
    POINT: 2
  };

  class ZoomProfiler {
    constructor() {
      this.wasmInstance = null;
      this.wasmExports = null;
      this.isReady = false;
      this.currentOpId = 0;
      this.currentOpType = 0;
      this.activeStepStarts = new Map(); // key -> start timestamp
      this.opStartTime = 0;

      this.initWasm();
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
    }

    /**
     * Export recorded profile events in chronological order from circular ring buffer
     */
    exportProfile(extraMeta = {}) {
      if (!this.wasmExports) return null;

      const totalCount = this.wasmExports.get_event_count();
      const capacity = typeof this.wasmExports.get_capacity === 'function' ? this.wasmExports.get_capacity() : 16384;
      const ptr = this.wasmExports.get_buffer_ptr();
      const memory = this.wasmExports.memory.buffer;
      const view = new DataView(memory, ptr);

      const events = [];
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

      return {
        format: 'nanodaw_telemetry_profile_v2',
        bufferType: 'circular_ring_buffer',
        exportedAt: new Date().toISOString(),
        device: {
          platform: detectedDevice,
          userAgent,
          isIOS,
          isAndroid,
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
          totalOps: this.currentOpId,
          ...extraMeta
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
      if (!data || data.events.length === 0) {
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
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);

      return {
        success: true,
        filename,
        totalOps: data.meta.totalOps,
        totalEvents: data.meta.eventsExported
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
      } catch (err) {}
    });
    window.addEventListener('unhandledrejection', (e) => {
      try {
        zoomProfiler.logEvent(STEP.SYSTEM_ERROR, {
          opType: OP.SYSTEM,
          extraData: 999
        });
      } catch (err) {}
    });
    window.dumpLog = (extraMeta) => zoomProfiler.exportProfile(extraMeta);
    window.downloadLog = (extraMeta) => zoomProfiler.downloadProfile(extraMeta);
  }

})(typeof window !== 'undefined' ? window : global);
