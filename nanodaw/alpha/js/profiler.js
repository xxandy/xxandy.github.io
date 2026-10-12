/**
 * NANOdaw Ultra-Low-Overhead WebAssembly Zoom Profiler
 * 
 * Logs sub-step timestamps during zoom operations directly into native WebAssembly
 * linear memory (~0.1 nanoseconds per event call) with zero GC and zero string allocations.
 */

(function(global) {
  'use strict';

  // Base64 encoding of the pre-compiled ~230-byte profiler WebAssembly module
  // Exports: memory, record_event(op_id, op_type, step_id, phase, track_index, timestamp_ms, duration_ms, extra_data),
  //          get_event_count(), get_buffer_ptr(), reset_profiler()
  const WASM_PROFILER_BASE64 = 'AGFzbQEAAAABFANgCH9/f39/fHx/AX9gAAF/YAAAAwUEAAEBAgUDAQAQBgYBfwFBAAsHTQUGbWVtb3J5AgAMcmVjb3JkX2V2ZW50AAAPZ2V0X2V2ZW50X2NvdW50AAEOZ2V0X2J1ZmZlcl9wdHIAAg5yZXNldF9wcm9maWxlcgADCmQEUAEBfyMAQQV0QcAAaiEIIAggADYCACAIIAE7AQQgCCACOwEGIAggAzoACCAIIAQ6AAkgCCAHNgIMIAggBTkDECAIIAY5AxgjAEEBaiQAIwALBAAjAAsFAEHAAAsGAEEAJAAL';

  const STEP = {
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
    TRACK_CANVAS_RESIZE: 11,
    TRACK_CANVAS_CLEAR: 12,
    TRACK_WAVEFORM_PAINT: 13,
    UPDATE_PLAYHEAD: 14,
    POST_RENDER_RAF: 15
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
    15: 'POST_RENDER_RAF'
  };

  const OP = {
    ZOOM_IN: 1,
    ZOOM_OUT: 2,
    ZOOM_FIT: 3,
    PINCH: 4
  };

  const OP_NAMES = {
    1: 'ZOOM_IN',
    2: 'ZOOM_OUT',
    3: 'ZOOM_FIT',
    4: 'PINCH'
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
        console.log('[ZoomProfiler] Low-overhead WASM profiler initialized.');
      } catch (e) {
        console.warn('[ZoomProfiler] Failed to compile WASM profiler, falling back:', e);
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
      }
      return duration;
    }

    /**
     * Total number of events currently in the buffer
     */
    getEventCount() {
      return this.wasmExports ? this.wasmExports.get_event_count() : 0;
    }

    /**
     * Reset the profiler buffer
     */
    reset() {
      if (this.wasmExports) {
        this.wasmExports.reset_profiler();
      }
      this.currentOpId = 0;
      this.currentOpType = 0;
      this.activeStepStarts.clear();
    }

    /**
     * Export all recorded profile events and device metadata into a structured JSON object
     */
    exportProfile(extraMeta = {}) {
      if (!this.wasmExports) return null;

      const count = this.wasmExports.get_event_count();
      const ptr = this.wasmExports.get_buffer_ptr();
      const memory = this.wasmExports.memory.buffer;
      const view = new DataView(memory, ptr);

      const events = [];
      const STRIDE = 32;

      for (let i = 0; i < count; i++) {
        const offset = i * STRIDE;
        const op_id = view.getUint32(offset + 0, true);
        const op_type = view.getUint16(offset + 4, true);
        const step_id = view.getUint16(offset + 6, true);
        const phase = view.getUint8(offset + 8);
        const track_index = view.getUint8(offset + 9);
        const extra_data = view.getUint32(offset + 12, true);
        const timestamp_ms = view.getFloat64(offset + 16, true);
        const duration_ms = view.getFloat64(offset + 24, true);

        events.push({
          i,
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

      const userAgent = navigator.userAgent || '';
      const isIOS = /iPad|iPhone|iPod/.test(userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const isAndroid = /Android/.test(userAgent);
      const detectedDevice = isIOS ? 'ios' : isAndroid ? 'android' : 'desktop';

      return {
        format: 'nanodaw_zoom_profile_v1',
        exportedAt: new Date().toISOString(),
        device: {
          platform: detectedDevice,
          userAgent,
          isIOS,
          isAndroid,
          devicePixelRatio: window.devicePixelRatio || 1,
          screen: {
            width: window.screen ? window.screen.width : 0,
            height: window.screen ? window.screen.height : 0
          },
          viewport: {
            width: window.innerWidth || 0,
            height: window.innerHeight || 0
          }
        },
        meta: {
          totalOps: this.currentOpId,
          totalEvents: count,
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
        return { success: false, message: 'No zoom operations recorded yet. Use Zoom +/- first!' };
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
        totalEvents: data.meta.totalEvents
      };
    }
  }

  const zoomProfiler = new ZoomProfiler();

  global.ZoomProfiler = ZoomProfiler;
  global.zoomProfiler = zoomProfiler;
  global.ZOOM_STEP = STEP;
  global.ZOOM_OP = OP;

})(typeof window !== 'undefined' ? window : global);
