/**
 * WaveformCache & Renderer
 * Computes audio peak summaries from AudioBuffers and renders smooth canvas waveforms
 * with support for track offsets, Hi-DPI scaling, and theme colors.
 */
class WaveformCache {
  constructor() {
    this.cache = new Map(); // index -> { minPeaks, maxPeaks, duration }
  }

  clear() {
    this.cache.clear();
  }

  /**
   * Precalculate peaks for an AudioBuffer
   */
  getPeaks(trackIndex, audioBuffer, pointsPerSec = 100) {
    if (this.cache.has(trackIndex)) {
      return this.cache.get(trackIndex);
    }

    if (!audioBuffer) return null;

    const duration = audioBuffer.duration;
    const totalPoints = Math.max(100, Math.floor(duration * pointsPerSec));
    const channelData = audioBuffer.getChannelData(0); // Use channel 0 (or mix down)
    const samplesPerPoint = Math.floor(channelData.length / totalPoints);

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
    this.cache.set(trackIndex, peakData);
    return peakData;
  }

  /**
   * Render a track lane waveform onto a canvas
   */
  renderTrackCanvas(canvas, track, pixelsPerSecond, scrollLeft, visibleWidth, options = {}) {
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || visibleWidth;
    const height = canvas.clientHeight || 70;

    // Adjust canvas resolution for retina displays
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);

    // Clear background
    ctx.clearRect(0, 0, width, height);

    if (!track || !track.buffer) {
      // Empty lane
      ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
      return;
    }

    const offset = track.offset || 0;
    const duration = track.duration || 0;
    const trackStartX = (offset * pixelsPerSecond) - scrollLeft;
    const trackWidth = duration * pixelsPerSecond;
    const trackEndX = trackStartX + trackWidth;

    // If completely out of visible viewport, skip drawing waveform
    if (trackEndX < 0 || trackStartX > width) {
      ctx.restore();
      return;
    }

    const color = track.color || '#00f2fe';
    const isMuted = options.isMuted;
    const isSoloed = options.isSoloed;
    const isDimmed = options.isDimmed;

    // Draw track block container
    const blockX = Math.max(0, trackStartX);
    const blockRight = Math.min(width, trackEndX);
    const blockW = Math.max(0, blockRight - blockX);

    if (blockW > 0) {
      // Track block background
      ctx.fillStyle = isDimmed ? 'rgba(30, 35, 45, 0.4)' : 'rgba(20, 26, 38, 0.85)';
      ctx.beginPath();
      ctx.roundRect(trackStartX, 4, trackWidth, height - 8, 6);
      ctx.fill();

      // Track block border
      ctx.strokeStyle = isDimmed ? 'rgba(255, 255, 255, 0.05)' : (color + '44');
      ctx.lineWidth = 1;
      ctx.stroke();

      // Track start marker line if within view
      if (trackStartX >= 0 && trackStartX <= width) {
        ctx.fillStyle = color;
        ctx.fillRect(trackStartX, 4, 3, height - 8);
      }
    }

    // Draw Waveform
    const peakData = this.getPeaks(track.index, track.buffer);
    if (!peakData) {
      ctx.restore();
      return;
    }

    const { minPeaks, maxPeaks, totalPoints } = peakData;
    const midY = height / 2;
    const ampScale = (height - 20) / 2;

    ctx.save();
    // Clip to track bounds
    ctx.beginPath();
    ctx.rect(Math.max(0, trackStartX), 4, Math.max(0, trackWidth), height - 8);
    ctx.clip();

    // Waveform gradient
    const gradient = ctx.createLinearGradient(0, 4, 0, height - 4);
    if (isDimmed) {
      gradient.addColorStop(0, 'rgba(150, 160, 180, 0.25)');
      gradient.addColorStop(0.5, 'rgba(100, 110, 130, 0.15)');
      gradient.addColorStop(1, 'rgba(150, 160, 180, 0.25)');
    } else {
      gradient.addColorStop(0, color);
      gradient.addColorStop(0.5, color + '99');
      gradient.addColorStop(1, color);
    }

    ctx.fillStyle = gradient;

    // Draw waveform bars
    const visibleStartX = Math.max(0, trackStartX);
    const visibleEndX = Math.min(width, trackEndX);
    const step = 2; // draw every 2px for smooth crisp performance

    for (let x = visibleStartX; x < visibleEndX; x += step) {
      const timeAtX = (x + scrollLeft - (offset * pixelsPerSecond)) / pixelsPerSecond;
      const pointIdx = Math.floor((timeAtX / duration) * totalPoints);

      if (pointIdx >= 0 && pointIdx < totalPoints) {
        const minVal = minPeaks[pointIdx];
        const maxVal = maxPeaks[pointIdx];

        const topY = midY - (maxVal * ampScale);
        const botY = midY - (minVal * ampScale);
        const barHeight = Math.max(1.5, botY - topY);

        ctx.fillRect(x, topY, step - 0.5, barHeight);
      }
    }

    // Center baseline
    ctx.strokeStyle = isDimmed ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(trackStartX, midY);
    ctx.lineTo(trackEndX, midY);
    ctx.stroke();

    ctx.restore();
    ctx.restore();
  }
}
