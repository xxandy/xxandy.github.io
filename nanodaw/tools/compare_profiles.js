#!/usr/bin/env node

/**
 * NANOdaw Zoom Profile Comparison & Analysis Tool
 * 
 * Usage:
 *   Single profile:  node tools/compare_profiles.js profile_ios.json
 *   Comparison mode: node tools/compare_profiles.js profile_ios.json profile_android.json
 */

const fs = require('fs');
const path = require('path');

function loadProfile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Error reading ${filePath}:`, e.message);
    process.exit(1);
  }
}

function calculateStats(values) {
  if (!values || values.length === 0) {
    return { count: 0, mean: 0, stddev: 0, min: 0, max: 0, median: 0, sum: 0 };
  }
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / values.length;
  const variance = values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length;
  const stddev = Math.sqrt(variance);
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];

  return {
    count: values.length,
    mean,
    stddev,
    min,
    max,
    median,
    sum
  };
}

function analyzeSingleProfile(prof, label = 'PROFILE') {
  const events = prof.events || [];
  const endEvents = events.filter(e => e.phase === 'END');

  // Group by step_name
  const stepGroups = new Map();
  endEvents.forEach(e => {
    if (!stepGroups.has(e.step_name)) {
      stepGroups.set(e.step_name, []);
    }
    stepGroups.get(e.step_name).push(e.duration_ms);
  });

  const stepStats = {};
  for (const [name, values] of stepGroups.entries()) {
    stepStats[name] = calculateStats(values);
  }

  // Group by op_id to see per-op total times
  const opGroups = new Map();
  endEvents.forEach(e => {
    if (!opGroups.has(e.op_id)) {
      opGroups.set(e.op_id, { type: e.op_type, steps: {} });
    }
    const op = opGroups.get(e.op_id);
    if (!op.steps[e.step_name]) op.steps[e.step_name] = [];
    op.steps[e.step_name].push(e.duration_ms);
  });

  const opTotalDurations = [];
  opGroups.forEach(op => {
    const totalEvents = op.steps['ZOOM_OP_TOTAL'];
    if (totalEvents && totalEvents.length > 0) {
      opTotalDurations.push(totalEvents[0]);
    }
  });

  // Per-track stats
  const trackGroups = new Map();
  endEvents.forEach(e => {
    if (typeof e.track_index === 'number') {
      if (!trackGroups.has(e.track_index)) {
        trackGroups.set(e.track_index, { resize: [], paint: [], clear: [] });
      }
      const tg = trackGroups.get(e.track_index);
      if (e.step_name === 'TRACK_CANVAS_RESIZE') tg.resize.push(e.duration_ms);
      if (e.step_name === 'TRACK_WAVEFORM_PAINT') tg.paint.push(e.duration_ms);
      if (e.step_name === 'TRACK_CANVAS_CLEAR') tg.clear.push(e.duration_ms);
    }
  });

  return {
    label,
    device: prof.device || {},
    meta: prof.meta || {},
    stepStats,
    opTotalStats: calculateStats(opTotalDurations),
    trackStats: trackGroups,
    totalOpsRecorded: opGroups.size
  };
}

function printHeader(title) {
  console.log('\n' + '='.repeat(80));
  console.log(`  ${title}`);
  console.log('='.repeat(80));
}

function formatMs(val, width = 8) {
  if (typeof val !== 'number' || isNaN(val)) return '-'.padStart(width);
  return (val.toFixed(2) + ' ms').padStart(width);
}

function runSingleReport(filePath) {
  const prof = loadProfile(filePath);
  const data = analyzeSingleProfile(prof, path.basename(filePath));

  printHeader(`NANOdaw Zoom Profiling Report: ${data.label}`);

  console.log(`Platform:          ${data.device.platform || 'Unknown'} (iOS: ${data.device.isIOS}, Android: ${data.device.isAndroid})`);
  console.log(`Device Pixel Ratio:${data.device.devicePixelRatio || 1}x`);
  console.log(`Screen Dimensions: ${data.device.screen?.width} x ${data.device.screen?.height} (Viewport: ${data.device.viewport?.width} x ${data.device.viewport?.height})`);
  console.log(`Zoom Ops Tracked:  ${data.totalOpsRecorded}`);
  console.log(`Total Events:      ${data.meta.totalEvents || 0}`);
  console.log(`User Agent:        ${data.device.userAgent || 'N/A'}`);

  console.log('\n--- OVERALL ZOOM OPERATION DURATION ---');
  console.log(`Mean:              ${formatMs(data.opTotalStats.mean)} ± ${formatMs(data.opTotalStats.stddev)}`);
  console.log(`Median:            ${formatMs(data.opTotalStats.median)}`);
  console.log(`Range (Min..Max):  ${formatMs(data.opTotalStats.min)} .. ${formatMs(data.opTotalStats.max)}`);

  console.log('\n--- SUB-STEP BREAKDOWN ---');
  console.log(
    'Sub-Step Name'.padEnd(26) +
    'Count'.padStart(7) +
    'Mean ± StdDev'.padStart(18) +
    'Median'.padStart(11) +
    'Min..Max'.padStart(20) +
    '% of Op'.padStart(10)
  );
  console.log('-'.repeat(92));

  const opMean = data.opTotalStats.mean || 1;
  const orderedStepNames = [
    'ZOOM_OP_TOTAL',
    'COMPUTE_BOUNDS',
    'CALC_FOCAL_ANCHOR',
    'UPDATE_DIMENSIONS',
    'DOM_SCROLL_UPDATE',
    'UPDATE_VIEWPORT_WIN',
    'RENDER_RULER_TOTAL',
    'RULER_CANVAS_RESIZE',
    'RULER_CANVAS_PAINT',
    'RENDER_WAVEFORMS_TOTAL',
    'TRACK_CANVAS_RESIZE',
    'TRACK_CANVAS_CLEAR',
    'TRACK_WAVEFORM_PAINT',
    'UPDATE_PLAYHEAD',
    'POST_RENDER_RAF'
  ];

  orderedStepNames.forEach(name => {
    const s = data.stepStats[name];
    if (s) {
      const pct = (s.mean / opMean) * 100;
      console.log(
        name.padEnd(26) +
        String(s.count).padStart(7) +
        `${s.mean.toFixed(2)} ± ${s.stddev.toFixed(1)}ms`.padStart(18) +
        formatMs(s.median, 11) +
        `${s.min.toFixed(1)}..${s.max.toFixed(1)}ms`.padStart(20) +
        (name === 'ZOOM_OP_TOTAL' ? '100.0%' : `${pct.toFixed(1)}%`).padStart(10)
      );
    }
  });

  if (data.trackStats.size > 0) {
    console.log('\n--- PER-TRACK BREAKDOWN ---');
    console.log('Track Idx'.padEnd(12) + 'Canvas Resize'.padStart(15) + 'Canvas Clear'.padStart(15) + 'Waveform Paint'.padStart(16));
    console.log('-'.repeat(58));
    for (const [tIdx, tg] of data.trackStats.entries()) {
      const r = calculateStats(tg.resize);
      const c = calculateStats(tg.clear);
      const p = calculateStats(tg.paint);
      console.log(
        `Track ${tIdx}`.padEnd(12) +
        formatMs(r.mean, 15) +
        formatMs(c.mean, 15) +
        formatMs(p.mean, 16)
      );
    }
  }

  console.log('='.repeat(80) + '\n');
}

function runComparisonReport(file1, file2) {
  const prof1 = loadProfile(file1);
  const prof2 = loadProfile(file2);

  const d1 = analyzeSingleProfile(prof1, path.basename(file1));
  const d2 = analyzeSingleProfile(prof2, path.basename(file2));

  printHeader(`NANOdaw Zoom Profile Comparison: ${d1.label}  VS  ${d2.label}`);

  console.log(`Device 1 (A):      ${d1.device.platform?.toUpperCase() || 'A'} | DPR: ${d1.device.devicePixelRatio}x | ${d1.device.screen?.width}x${d1.device.screen?.height} | ${d1.totalOpsRecorded} Ops`);
  console.log(`Device 2 (B):      ${d2.device.platform?.toUpperCase() || 'B'} | DPR: ${d2.device.devicePixelRatio}x | ${d2.device.screen?.width}x${d2.device.screen?.height} | ${d2.totalOpsRecorded} Ops`);

  const op1 = d1.opTotalStats.mean;
  const op2 = d2.opTotalStats.mean;
  const opDelta = op1 - op2;
  const opRatio = op2 > 0 ? (op1 / op2) : 0;

  console.log('\n--- OVERALL ZOOM OPERATION DURATION ---');
  console.log(`Device A Mean:     ${formatMs(op1)} ± ${formatMs(d1.opTotalStats.stddev)}`);
  console.log(`Device B Mean:     ${formatMs(op2)} ± ${formatMs(d2.opTotalStats.stddev)}`);
  console.log(`Delta (A - B):     ${(opDelta >= 0 ? '+' : '') + opDelta.toFixed(2)} ms`);
  console.log(`Speed Comparison:  ${opRatio >= 1 ? `Device A is ${(opRatio).toFixed(2)}x SLOWER than Device B` : `Device A is ${(1/opRatio).toFixed(2)}x FASTER than Device B`}`);

  console.log('\n--- SUB-STEP COMPARISON TABLE ---');
  console.log(
    'Sub-Step Name'.padEnd(24) +
    'Dev A Mean'.padStart(12) +
    'Dev B Mean'.padStart(12) +
    'Delta (A-B)'.padStart(14) +
    'Ratio (A/B)'.padStart(13) +
    '% of Delta'.padStart(13)
  );
  console.log('-'.repeat(88));

  const allStepNames = Array.from(new Set([
    ...Object.keys(d1.stepStats),
    ...Object.keys(d2.stepStats)
  ]));

  const deltas = [];

  allStepNames.forEach(name => {
    const s1 = d1.stepStats[name] || { mean: 0, stddev: 0 };
    const s2 = d2.stepStats[name] || { mean: 0, stddev: 0 };
    const delta = s1.mean - s2.mean;
    const ratio = s2.mean > 0 ? (s1.mean / s2.mean) : (s1.mean > 0 ? Infinity : 1);
    const pctOfDelta = (Math.abs(opDelta) > 0.1 && name !== 'ZOOM_OP_TOTAL')
      ? ((delta / opDelta) * 100)
      : 0;

    deltas.push({ name, s1, s2, delta, ratio, pctOfDelta });

    console.log(
      name.padEnd(24) +
      formatMs(s1.mean, 12) +
      formatMs(s2.mean, 12) +
      `${(delta >= 0 ? '+' : '') + delta.toFixed(2)} ms`.padStart(14) +
      `${ratio.toFixed(2)}x`.padStart(13) +
      (name === 'ZOOM_OP_TOTAL' ? '-' : `${pctOfDelta.toFixed(1)}%`).padStart(13)
    );
  });

  // Top Bottlenecks Analysis
  console.log('\n--- TOP BOTTLENECK CONTRIBUTORS TO DELTA ---');
  const nonTotalDeltas = deltas.filter(d => d.name !== 'ZOOM_OP_TOTAL' && d.delta > 0)
    .sort((a, b) => b.delta - a.delta);

  if (nonTotalDeltas.length === 0) {
    console.log('No significant slow sub-steps detected in Device A relative to Device B.');
  } else {
    nonTotalDeltas.slice(0, 3).forEach((item, idx) => {
      console.log(`  ${idx + 1}. ${item.name.padEnd(24)} +${item.delta.toFixed(2)} ms slower on Device A (${item.pctOfDelta.toFixed(1)}% of total delay)`);
    });
  }

  // Check Compositor Lag (POST_RENDER_RAF)
  const raf1 = d1.stepStats['POST_RENDER_RAF'];
  const raf2 = d2.stepStats['POST_RENDER_RAF'];
  if (raf1 && raf2) {
    console.log('\n--- BROWSER COMPOSITOR / RAF LAG ---');
    console.log(`Device A Compositor Lag: ${formatMs(raf1.mean)}`);
    console.log(`Device B Compositor Lag: ${formatMs(raf2.mean)}`);
    const rafDelta = raf1.mean - raf2.mean;
    console.log(`Compositor Delay Delta:  ${(rafDelta >= 0 ? '+' : '') + rafDelta.toFixed(2)} ms`);
  }

  console.log('='.repeat(88) + '\n');
}

// Entrypoint
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log(`
NANOdaw Zoom Profiler Parser & Comparison Tool

Usage:
  Single Profile Report:
    node tools/compare_profiles.js <profile.json>

  Comparison Mode (iOS vs Android):
    node tools/compare_profiles.js <profile_ios.json> <profile_android.json>
`);
  process.exit(0);
}

if (args.length === 1) {
  runSingleReport(args[0]);
} else {
  runComparisonReport(args[0], args[1]);
}
