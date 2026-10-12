/**
 * WaveformCache & Renderer
 * Computes audio peak summaries from AudioBuffers or pre-extracted peaks and renders smooth canvas waveforms
 * with support for track offsets, Hi-DPI scaling, and theme colors.
 */
class WaveformCache {
  constructor() {
    this.cache = new Map(); // buffer -> { minPeaks, maxPeaks, duration }
  }

  clear() {
    this.cache.clear();
  }

  /**
   * Precalculate peaks for an AudioBuffer or retrieve track peak data
   */
  getPeaks(trackIndex, trackOrBuffer, pointsPerSec = 80) {
    if (!trackOrBuffer) return null;

    // 1. If track already has pre-computed or extracted peaks
    if (trackOrBuffer.peaks) {
      const p = trackOrBuffer.peaks;
      if (p.minPeaks && p.maxPeaks) {
        return p;
      }
      if (Array.isArray(p) || p instanceof Float32Array) {
        const totalPoints = p.length;
        const minPeaks = new Float32Array(totalPoints);
        const maxPeaks = new Float32Array(totalPoints);
        for (let i = 0; i < totalPoints; i++) {
          const v = Math.abs(p[i]);
          maxPeaks[i] = v;
          minPeaks[i] = -v;
        }
        const formatted = { minPeaks, maxPeaks, totalPoints, duration: trackOrBuffer.duration || 30 };
        trackOrBuffer.peaks = formatted;
        return formatted;
      }
    }

    const audioBuffer = trackOrBuffer.buffer || (trackOrBuffer.getChannelData ? trackOrBuffer : null);
    if (!audioBuffer) return null;

    if (this.cache.has(audioBuffer)) {
      return this.cache.get(audioBuffer);
    }

    const duration = audioBuffer.duration;
    const totalPoints = Math.max(100, Math.floor(duration * pointsPerSec));
    const channelData = audioBuffer.getChannelData(0);
    const samplesPerPoint = Math.max(1, Math.floor(channelData.length / totalPoints));

    const minPeaks = new Float32Array(totalPoints);
    const maxPeaks = new Float32Array(totalPoints);

    for (let p = 0; p < totalPoints; p++) {
      let min = 1.0;
      let max = -1.0;
      const start = p * samplesPerPoint;
      const end = Math.min(start + samplesPerPoint, channelData.length);

      for (let s = start; s < end; s++) {
        const val = channelData[s];
        if (val < min) min = val;
        if (val > max) max = val;
      }

      minPeaks[p] = min === 1.0 ? 0 : min;
      maxPeaks[p] = max === -1.0 ? 0 : max;
    }

    const peakData = { minPeaks, maxPeaks, totalPoints, duration };
    this.cache.set(audioBuffer, peakData);
    return peakData;
  }

  /**
   * Render a track lane waveform onto a canvas
   */
  renderTrackCanvas(canvas, track, pixelsPerSecond, timelineWidth, trackHeight, options = {}) {
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const win = options.window;
    const canvasCssWidth = win ? win.width : Math.max(100, Math.round(timelineWidth));
    const canvasCssStartX = win ? win.startX : 0;
    const height = Math.max(40, Math.round(trackHeight));

    // Ensure physical canvas dimensions match window width & DPR
    const maxDim = 32768;
    const targetW = Math.min(maxDim, Math.round(canvasCssWidth * dpr));
    const targetH = Math.min(maxDim, Math.round(height * dpr));

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    canvas.style.width = `${canvasCssWidth}px`;
    canvas.style.height = `${height}px`;
    canvas.style.left = `${canvasCssStartX}px`;

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);

    // Clear background
    ctx.clearRect(0, 0, canvasCssWidth, height);

    const isSelected = Boolean(options.isSelected);
    const isMuted = Boolean(options.isMuted);
    const isSoloed = Boolean(options.isSoloed);
    const isDimmed = Boolean(options.isDimmed);
    const color = track?.color || '#00f2fe';

    // Lane background wash
    if (isSelected) {
      ctx.fillStyle = isDimmed ? 'rgba(255, 255, 255, 0.02)' : 'rgba(0, 242, 254, 0.06)';
      ctx.fillRect(0, 0, canvasCssWidth, height);
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.01)';
      ctx.fillRect(0, 0, canvasCssWidth, height);
    }

    if (!track || (!track.buffer && !track.peaks && (!track.chunks || track.chunks.length === 0))) {
      // Empty or loading lane
      ctx.restore();
      return;
    }

    // Apply viewport window horizontal translation
    if (win) {
      ctx.translate(-canvasCssStartX, 0);
    }

    const offset = Math.max(0, Number(track.offset) || 0);
    const duration = Math.max(0.1, Number(track.duration) || (track.buffer ? track.buffer.duration : 0) || 30);
    const trackStartX = Math.round(offset * pixelsPerSecond);
    const trackWidth = Math.max(4, Math.round(duration * pixelsPerSecond));
    const trackEndX = trackStartX + trackWidth;

    // If track is completely outside the visible canvas window, skip drawing
    if (win && (trackEndX < canvasCssStartX || trackStartX > canvasCssStartX + canvasCssWidth)) {
      ctx.restore();
      return;
    }

    // Draw track block background
    if (isSelected) {
      ctx.fillStyle = isDimmed ? 'rgba(35, 42, 56, 0.6)' : 'rgba(20, 28, 42, 0.95)';
    } else {
      ctx.fillStyle = isDimmed ? 'rgba(25, 30, 40, 0.4)' : 'rgba(16, 22, 32, 0.85)';
    }

    ctx.beginPath();
    ctx.roundRect(trackStartX, 4, trackWidth, height - 8, 6);
    ctx.fill();

    // Track block border
    if (isSelected) {
      ctx.strokeStyle = isDimmed ? 'rgba(255, 255, 255, 0.2)' : color;
      ctx.lineWidth = 1.5;
    } else {
      ctx.strokeStyle = isDimmed ? 'rgba(255, 255, 255, 0.05)' : (color + '55');
      ctx.lineWidth = 1;
    }
    ctx.stroke();

    // Track start accent bar
    ctx.fillStyle = color;
    ctx.fillRect(trackStartX, 4, isSelected ? 4 : 3, height - 8);

    // Track label pill at start of block (pinned adaptively if scrolled past start)
    ctx.font = '10px "Inter", -apple-system, sans-serif';
    ctx.fillStyle = isDimmed ? 'rgba(255, 255, 255, 0.4)' : 'rgba(255, 255, 255, 0.85)';
    const nameLabel = track.name || 'Audio Track';
    const labelX = Math.max(trackStartX + 8, canvasCssStartX + 8);
    if (labelX < trackEndX - 40) {
      ctx.fillText(nameLabel, labelX, 16);
    }

    const midY = height / 2;
    const ampScale = (height - 24) / 2;

    ctx.save();
    // Clip drawing strictly to the track block
    ctx.beginPath();
    ctx.rect(trackStartX, 4, trackWidth, height - 8);
    ctx.clip();

    // Waveform gradient
    const gradient = ctx.createLinearGradient(0, 4, 0, height - 4);
    if (isDimmed) {
      gradient.addColorStop(0, 'rgba(140, 150, 170, 0.25)');
      gradient.addColorStop(0.5, 'rgba(100, 110, 130, 0.15)');
      gradient.addColorStop(1, 'rgba(140, 150, 170, 0.25)');
    } else {
      gradient.addColorStop(0, color);
      gradient.addColorStop(0.5, color + 'aa');
      gradient.addColorStop(1, color);
    }

    // --- Case A: Track has 20-second streaming chunks ---
    if (track.chunks && track.chunks.length > 0) {
      // Pass 1: Chunk boundaries and loading/placeholder states
      track.chunks.forEach((chunk, k) => {
        const chunkStartTime = offset + chunk.startTime;
        const chunkEndTime = chunkStartTime + chunk.duration;

        // Skip chunk if outside visible time window
        if (win && (chunkEndTime < win.startSec || chunkStartTime > win.endSec)) {
          return;
        }

        const chunkStartX = Math.round(chunkStartTime * pixelsPerSecond);
        const chunkWidth = Math.max(2, Math.round(chunk.duration * pixelsPerSecond));
        const chunkEndX = Math.min(trackEndX, chunkStartX + chunkWidth);

        // 1. Chunk boundary separator line
        if (k > 0) {
          ctx.save();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.moveTo(chunkStartX, 4);
          ctx.lineTo(chunkStartX, height - 4);
          ctx.stroke();
          ctx.restore();
        }

        // 2. Render overlays for non-decoded states
        if (chunk.status === 'loading') {
          // Loading chunk: diagonal animated stripes + loading badge
          ctx.save();
          ctx.beginPath();
          ctx.rect(chunkStartX, 4, chunkWidth, height - 8);
          ctx.clip();

          ctx.fillStyle = isDimmed ? 'rgba(255, 255, 255, 0.04)' : (color + '15');
          ctx.fillRect(chunkStartX, 4, chunkWidth, height - 8);

          ctx.strokeStyle = isDimmed ? 'rgba(255, 255, 255, 0.12)' : (color + '55');
          ctx.lineWidth = 1.5;
          const stripeSpacing = 12;
          for (let lx = chunkStartX - height; lx < chunkEndX + height; lx += stripeSpacing) {
            ctx.beginPath();
            ctx.moveTo(lx, height - 4);
            ctx.lineTo(lx + height, 4);
            ctx.stroke();
          }

          if (chunkWidth > 50) {
            ctx.font = '10px "Inter", -apple-system, sans-serif';
            ctx.fillStyle = isDimmed ? 'rgba(255, 255, 255, 0.6)' : color;
            ctx.fillText(`⚡ Loading ${Math.round(chunk.startTime)}s...`, chunkStartX + 8, midY + 4);
          }
          ctx.restore();

        } else if (chunk.status !== 'decoded') {
          // Undecoded chunk: dimmed diagonal hatch pattern + timestamp label
          ctx.save();
          ctx.beginPath();
          ctx.rect(chunkStartX, 4, chunkWidth, height - 8);
          ctx.clip();

          ctx.fillStyle = 'rgba(15, 20, 30, 0.5)';
          ctx.fillRect(chunkStartX, 4, chunkWidth, height - 8);

          ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
          ctx.lineWidth = 1;
          const stripeSpacing = 16;
          for (let lx = chunkStartX - height; lx < chunkEndX + height; lx += stripeSpacing) {
            ctx.beginPath();
            ctx.moveTo(lx, height - 4);
            ctx.lineTo(lx + height, 4);
            ctx.stroke();
          }

          if (chunkWidth > 35) {
            ctx.font = '9px "Inter", -apple-system, sans-serif';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
            ctx.fillText(`${Math.round(chunk.startTime)}s`, chunkStartX + 8, height - 12);
          }
          ctx.restore();
        }
      });

      // Pass 2: High-speed batched waveform rendering for visible decoded chunks
      ctx.fillStyle = gradient;
      ctx.beginPath();
      const step = 2;
      const barW = step - 0.5;

      const windowStartX = win ? win.startX : 0;
      const windowEndX = win ? (win.startX + win.width) : (trackEndX + 100);

      track.chunks.forEach((chunk) => {
        if (chunk.status === 'decoded' && chunk.minPeaks && chunk.maxPeaks) {
          const chunkStartTime = offset + chunk.startTime;
          const chunkEndTime = chunkStartTime + chunk.duration;

          // Skip chunk if outside visible time window
          if (win && (chunkEndTime < win.startSec || chunkStartTime > win.endSec)) {
            return;
          }

          const chunkStartX = Math.round(chunkStartTime * pixelsPerSecond);
          const chunkWidth = Math.max(2, Math.round(chunk.duration * pixelsPerSecond));
          const chunkEndX = Math.min(trackEndX, chunkStartX + chunkWidth);
          const totalPoints = chunk.minPeaks.length;

          const drawStartX = Math.max(chunkStartX, Math.floor(windowStartX));
          const drawEndX = Math.min(chunkEndX, Math.ceil(windowEndX));

          for (let x = drawStartX; x < drawEndX; x += step) {
            const relX = x - chunkStartX;
            const pointIdx = Math.floor((relX / chunkWidth) * totalPoints);
            if (pointIdx >= 0 && pointIdx < totalPoints) {
              const minVal = chunk.minPeaks[pointIdx];
              const maxVal = chunk.maxPeaks[pointIdx];
              const topY = midY - (maxVal * ampScale);
              const botY = midY - (minVal * ampScale);
              const barHeight = Math.max(1.5, botY - topY);
              ctx.rect(x, topY, barW, barHeight);
            }
          }
        }
      });
      ctx.fill();

    } else {
      // --- Case B: Legacy / Monolithic buffer or pre-computed peaks ---
      const peakData = this.getPeaks(track.index, track);
      if (peakData) {
        const { minPeaks, maxPeaks, totalPoints } = peakData;
        ctx.fillStyle = gradient;
        const step = 2;
        const barW = step - 0.5;
        const windowStartX = win ? win.startX : 0;
        const windowEndX = win ? (win.startX + win.width) : trackEndX;
        const drawStartX = Math.max(trackStartX, Math.floor(windowStartX));
        const maxDrawX = Math.min(trackEndX, Math.ceil(windowEndX));
        ctx.beginPath();
        for (let x = drawStartX; x < maxDrawX; x += step) {
          const relX = x - trackStartX;
          const pointIdx = Math.floor((relX / trackWidth) * totalPoints);

          if (pointIdx >= 0 && pointIdx < totalPoints) {
            const minVal = minPeaks[pointIdx];
            const maxVal = maxPeaks[pointIdx];
            const topY = midY - (maxVal * ampScale);
            const botY = midY - (minVal * ampScale);
            const barHeight = Math.max(1.5, botY - topY);
            ctx.rect(x, topY, barW, barHeight);
          }
        }
        ctx.fill();
      }
    }

    // Center reference line
    ctx.strokeStyle = isDimmed ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(trackStartX, midY);
    ctx.lineTo(trackEndX, midY);
    ctx.stroke();

    ctx.restore(); // restores clip
    ctx.restore(); // restores scale & translate
  }
}
