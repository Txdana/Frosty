'use strict';

// Reference-to-editable-template analysis. The numeric analysis is deterministic;
// AI is an optional interpretation/refinement layer, never the sole source of edits.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const TL = require('./timeline');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
const round = (v, n = 3) => +Number(v || 0).toFixed(n);

function normalizeTranscript(input, duration) {
  const source = Array.isArray(input) ? input : [];
  return source.map((row) => {
    if (typeof row === 'string') return { start: 0, end: duration, text: row.trim() };
    if (!row || typeof row.text !== 'string') return null;
    const start = clamp(row.start, 0, duration), end = clamp(row.end, start, duration);
    const text = row.text.replace(/\s+/g, ' ').trim().slice(0, 1600);
    return end > start && text ? { start: round(start), end: round(end), text, confidence: Number.isFinite(+row.confidence) ? +row.confidence : null } : null;
  }).filter(Boolean).sort((a, b) => a.start - b.start);
}

function segmentBoundaries(duration, sceneEvents = [], minShot = 0.22) {
  duration = Math.max(0, Number(duration) || 0);
  const ordered = (sceneEvents || []).map((e) => ({ ...e, time: Number(e.time) }))
    .filter((e) => Number.isFinite(e.time) && e.time > 0 && e.time < duration)
    .sort((a, b) => a.time - b.time);
  // Reject cuts that would create tiny clips; this is safer than silently creating
  // a zero/negative-duration clip or leaving stale duration metadata after merging.
  const cuts = [];
  for (const event of ordered) {
    if (event.time < minShot || duration - event.time < minShot) continue;
    if (!cuts.length || event.time - cuts[cuts.length - 1].time >= minShot) cuts.push(event);
  }
  const bounds = [0, ...cuts.map((x) => x.time), duration];
  const shots = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i], end = bounds[i + 1];
    if (end - start < minShot && shots.length) {
      shots[shots.length - 1].end = round(end);
      shots[shots.length - 1].duration = round(end - shots[shots.length - 1].start);
      continue;
    }
    const event = cuts.find((e) => Math.abs(e.time - start) < 0.01);
    shots.push({ index: shots.length, start: round(start), end: round(end), duration: round(end - start),
      boundaryScore: event?.score ?? null, boundaryConfidence: start === 0 ? 'high' : (event?.confidence || 'low'),
      transition: start === 0 ? { type: 'none', confidence: 'high' } : { type: 'cut', confidence: event?.confidence || 'low' },
      transcript: [], captionText: '', motion: { activity: 'unknown', score: null, camera: 'unknown', cameraConfidence: 'low' } });
  }
  if (!shots.length && duration > 0) shots.push({ index: 0, start: 0, end: round(duration), duration: round(duration), boundaryScore: null, boundaryConfidence: 'high', transition: { type: 'none', confidence: 'high' }, transcript: [], captionText: '', motion: { activity: 'unknown', score: null, camera: 'unknown', cameraConfidence: 'low' } });
  return shots;
}

function paceSummary(shots) {
  const values = shots.map((s) => s.duration).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!values.length) return { medianShotSeconds: 0, meanShotSeconds: 0, pace: 'unknown', variability: 0 };
  const mid = Math.floor(values.length / 2), median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return { medianShotSeconds: round(median), meanShotSeconds: round(mean), pace: median < 1.05 ? 'rapid' : median < 2.2 ? 'fast' : median < 4.5 ? 'measured' : 'slow', variability: round(mean > 0 ? sd / mean : 0) };
}

function parseMotionBytes(bytes, frameBytes, width, height, fps) {
  const count = Math.floor(bytes.length / frameBytes), frames = [];
  for (let i = 0; i < count; i++) frames.push(bytes.subarray(i * frameBytes, (i + 1) * frameBytes));
  const pairs = [];
  const scales = [0.94, 0.97, 1, 1.03, 1.06], shiftsX = [-2, -1, 0, 1, 2], shiftsY = [-1, 0, 1];
  const match = (a, b, scale, dx, dy) => {
    let error = 0, used = 0;
    const cx = (width - 1) / 2, cy = (height - 1) / 2;
    for (let y = 2; y < height - 2; y += 1) {
      const py = Math.round(cy + (y - cy) / scale + dy);
      if (py < 1 || py >= height - 1) continue;
      for (let x = 2; x < width - 2; x += 1) {
        const px = Math.round(cx + (x - cx) / scale + dx);
        if (px < 1 || px >= width - 1) continue;
        error += Math.abs(b[y * width + x] - a[py * width + px]); used++;
      }
    }
    return used ? error / used : 255;
  };
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    const raw = match(a, b, 1, 0, 0); let best = { error: raw, scale: 1, dx: 0, dy: 0 };
    for (const scale of scales) for (const dx of shiftsX) for (const dy of shiftsY) {
      const error = match(a, b, scale, dx, dy);
      if (error < best.error) best = { error, scale, dx, dy };
    }
    const improvement = raw > 0.5 ? clamp((raw - best.error) / raw, 0, 1) : 0;
    let camera = 'steady';
    if (improvement > 0.11) {
      if (best.scale > 1.015) camera = 'zoom-in';
      else if (best.scale < 0.985) camera = 'zoom-out';
      else if (best.dx > 0.8) camera = 'pan-right';
      else if (best.dx < -0.8) camera = 'pan-left';
      else if (best.dy > 0.7) camera = 'pan-down';
      else if (best.dy < -0.7) camera = 'pan-up';
      else camera = 'camera-motion';
    } else if (raw > 22) camera = 'complex-motion';
    pairs.push({ time: i / fps, rawChange: raw / 255, score: clamp(raw / 64, 0, 1), camera, confidence: improvement > 0.24 ? 'medium' : 'low', zoomScale: best.scale, dx: best.dx, dy: best.dy });
  }
  return pairs;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const ordered = values.slice().sort((a, b) => a - b);
  return ordered[Math.max(0, Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * p)))];
}

// Deterministic audio-envelope / onset analysis. This estimates rhythmic structure;
// it deliberately does not claim source separation or music-vs-speech classification.
function analyzeAudioPcm(buffer, sampleRate = 8000, { windowMs = 20 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || !Number.isFinite(sampleRate) || sampleRate < 1000) {
    return { status: 'unavailable', reason: 'no-decodable-audio', sampleRate, windowMs, onsets: [], beatTimes: [], estimatedBpm: null, beatConfidence: 0 };
  }
  const usable = buffer.length - (buffer.length % 4);
  const floats = new Float32Array(usable / 4);
  for (let i = 0; i < floats.length; i++) floats[i] = Number.isFinite(buffer.readFloatLE(i * 4)) ? buffer.readFloatLE(i * 4) : 0;
  const samplesPerWindow = Math.max(1, Math.round(sampleRate * windowMs / 1000));
  const rms = [];
  for (let start = 0; start < floats.length; start += samplesPerWindow) {
    const end = Math.min(floats.length, start + samplesPerWindow);
    let sum = 0;
    for (let i = start; i < end; i++) sum += floats[i] * floats[i];
    rms.push(Math.sqrt(sum / Math.max(1, end - start)));
  }
  if (!rms.length) return { status: 'unavailable', reason: 'empty-audio-envelope', sampleRate, windowMs, onsets: [], beatTimes: [], estimatedBpm: null, beatConfidence: 0 };
  const sortedRms = rms.slice().sort((a, b) => a - b);
  const rmsMean = rms.reduce((a, b) => a + b, 0) / rms.length;
  const rmsPeak = Math.max(...rms);
  const safeDb = (v) => round(20 * Math.log10(Math.max(1e-8, v)), 2);
  const dynamicsDb = round(safeDb(percentile(sortedRms, 0.95)) - safeDb(percentile(sortedRms, 0.1)), 2);
  const flux = rms.map((value, i) => i === 0 ? 0 : Math.max(0, value - rms[i - 1] * 0.92));
  const fluxMean = flux.reduce((a, b) => a + b, 0) / flux.length;
  const fluxVariance = flux.reduce((a, b) => a + (b - fluxMean) ** 2, 0) / flux.length;
  const fluxStd = Math.sqrt(fluxVariance);
  const threshold = Math.max(percentile(flux, 0.78), fluxMean + 0.85 * fluxStd, 0.0008);
  const hopSeconds = samplesPerWindow / sampleRate;
  const rawOnsets = [];
  let lastOnset = -Infinity;
  for (let i = 1; i < flux.length - 1; i++) {
    if (flux[i] >= threshold && flux[i] >= flux[i - 1] && flux[i] > flux[i + 1] && i * hopSeconds - lastOnset >= 0.09) {
      rawOnsets.push({ time: round(i * hopSeconds, 3), strength: round(flux[i] / Math.max(1e-8, fluxMean + fluxStd), 3) });
      lastOnset = i * hopSeconds;
    }
  }

  // Autocorrelation of onset novelty over plausible beat periods (70–180 BPM).
  let bestLag = 0, bestCorr = 0;
  const centered = flux.map((x) => x - fluxMean);
  const energy = centered.reduce((a, b) => a + b * b, 0);
  if (energy > 1e-9 && rawOnsets.length >= 5) {
    const minLag = Math.max(2, Math.floor(60 / (180 * hopSeconds)));
    const maxLag = Math.min(Math.floor(60 / (70 * hopSeconds)), Math.floor(centered.length / 3));
    for (let lag = minLag; lag <= maxLag; lag++) {
      let cross = 0, left = 0, right = 0;
      for (let i = lag; i < centered.length; i++) {
        cross += centered[i] * centered[i - lag];
        left += centered[i] * centered[i];
        right += centered[i - lag] * centered[i - lag];
      }
      const corr = cross / Math.sqrt(Math.max(1e-12, left * right));
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
  }
  const beatConfidence = round(clamp(bestCorr, 0, 1), 3);
  const periodic = bestLag > 0 && beatConfidence >= 0.28 && rawOnsets.length >= 6;
  let beatTimes = [];
  let estimatedBpm = null;
  if (periodic) {
    estimatedBpm = round(60 / (bestLag * hopSeconds), 1);
    // Pick the most energetic phase of the detected period, avoiding a forced beat at t=0.
    let phase = 0, phaseScore = -Infinity;
    for (let candidate = 0; candidate < bestLag; candidate++) {
      let score = 0;
      for (let i = candidate; i < flux.length; i += bestLag) score += Math.max(0, centered[i]);
      if (score > phaseScore) { phaseScore = score; phase = candidate; }
    }
    for (let i = phase; i < flux.length; i += bestLag) {
      const t = i * hopSeconds;
      if (t >= 0.08 && t <= (floats.length / sampleRate) && (beatTimes.length === 0 || t - beatTimes[beatTimes.length - 1] >= 0.25)) beatTimes.push(round(t, 3));
    }
  }
  return {
    status: 'measured', sampleRate, windowMs,
    duration: round(floats.length / sampleRate), rmsMean: round(rmsMean, 5), rmsPeak: round(rmsPeak, 5), dynamicsDb,
    envelope: rms.filter((_, i) => i % 5 === 0).map((v) => round(v, 4)), envelopeSampleRate: round(1000 / (windowMs * 5), 2),
    onsetCount: rawOnsets.length, onsets: rawOnsets.slice(0, 240),
    estimatedBpm, beatConfidence, beatPeriodSeconds: periodic ? round(bestLag * hopSeconds, 3) : null,
    beatTimes: beatTimes.slice(0, 480), rhythmStatus: periodic ? (beatConfidence >= 0.45 ? 'stable-pulse-candidate' : 'possible-pulse') : 'no-confident-periodic-pulse'
  };
}

async function extractAudioFeatures(src, ff, duration, { sampleRate = 8000, timeoutMs = 30000 } = {}) {
  if (!src || !fs.existsSync(src) || !ff?.ffmpegPath) return { status: 'unavailable', reason: 'source-or-ffmpeg-missing', onsets: [], beatTimes: [], estimatedBpm: null, beatConfidence: 0 };
  return await new Promise((resolve) => {
    const chunks = []; let byteCount = 0, completed = false;
    const maxBytes = Math.max(4096, Math.ceil(Math.min(900, Number(duration) || 120) * sampleRate * 4) + 4096);
    const p = spawn(ff.ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', String(sampleRate), '-t', String(Math.min(900, Number(duration) || 120)), '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    const finish = (value) => { if (completed) return; completed = true; clearTimeout(timer); resolve(value); };
    p.stdout.on('data', (chunk) => {
      if (byteCount >= maxBytes) { try { p.kill(); } catch {} return; }
      const allowed = Math.min(chunk.length, maxBytes - byteCount);
      if (allowed > 0) { chunks.push(allowed === chunk.length ? chunk : chunk.subarray(0, allowed)); byteCount += allowed; }
    });
    p.on('error', () => finish({ status: 'unavailable', reason: 'ffmpeg-audio-decode-failed', onsets: [], beatTimes: [], estimatedBpm: null, beatConfidence: 0 }));
    p.on('close', (code) => {
      if (code !== 0 || !chunks.length) return finish({ status: 'unavailable', reason: 'no-audio-stream-or-decode-failed', onsets: [], beatTimes: [], estimatedBpm: null, beatConfidence: 0 });
      finish(analyzeAudioPcm(Buffer.concat(chunks), sampleRate));
    });
  });
}

function alignCutsToAudio(cuts, audio) {
  const beats = Array.isArray(audio?.beatTimes) ? audio.beatTimes : [];
  const onsets = Array.isArray(audio?.onsets) ? audio.onsets : [];
  return (cuts || []).map((cut) => {
    const time = Number(cut.time) || 0;
    const nearest = (values, map) => values.reduce((best, value) => {
      const t = typeof value === 'number' ? value : Number(value.time) || 0;
      const distance = Math.abs(time - t);
      return !best || distance < best.distance ? { time: round(t), distance: round(distance, 3), ...(map && typeof value === 'object' ? { strength: value.strength } : {}) } : best;
    }, null);
    const nearestBeat = nearest(beats), nearestOnset = nearest(onsets, true);
    return { ...cut, audioAlignment: {
      nearestBeat, nearestOnset,
      label: nearestBeat ? (nearestBeat.distance <= 0.06 ? 'beat-aligned' : nearestBeat.distance <= 0.16 ? 'near-beat' : 'off-beat') : 'not-estimated',
      confidence: audio?.beatConfidence >= 0.45 && nearestBeat ? 'medium' : 'low'
    } };
  });
}

async function extractMotionSamples(src, ff, duration, { fps = 3, width = 48, height = 27, maxFrames = 360 } = {}) {
  if (!src || !fs.existsSync(src) || !ff?.ffmpegPath) return [];
  fps = clamp(fps, 1, 4); width = Math.trunc(clamp(width, 32, 96)); height = Math.trunc(clamp(height, 18, 54));
  const frameBytes = width * height;
  return await new Promise((resolve) => {
    let data = [], error = '', total = 0, completed = false;
    const p = spawn(ff.ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', src, '-an', '-vf', `fps=${fps},scale=${width}:${height}:flags=area,format=gray`, '-frames:v', String(Math.min(maxFrames, Math.ceil(duration * fps))), '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { windowsHide: true });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 45000);
    p.stdout.on('data', (chunk) => { if (total < frameBytes * maxFrames) { data.push(chunk); total += chunk.length; } });
    p.stderr.on('data', (chunk) => { error += chunk.toString(); });
    p.on('error', () => { completed = true; clearTimeout(timer); resolve([]); });
    p.on('close', (code) => {
      if (completed) return; completed = true; clearTimeout(timer);
      if (code !== 0 || !data.length) { resolve([]); return; }
      resolve(parseMotionBytes(Buffer.concat(data), frameBytes, width, height, fps));
    });
  });
}

function describeMotion(shots, samples, fps = 3) {
  for (const shot of shots) {
    const rows = samples.filter((m) => m.time >= shot.start && m.time < shot.end);
    if (!rows.length) continue;
    const mean = rows.reduce((a, b) => a + b.score, 0) / rows.length;
    const active = rows.filter((x) => x.score > 0.18);
    const cameras = rows.filter((x) => x.camera !== 'steady' && x.confidence !== 'low');
    const counts = new Map(); for (const row of cameras) counts.set(row.camera, (counts.get(row.camera) || 0) + 1);
    const dominant = [...counts].sort((a, b) => b[1] - a[1])[0];
    shot.motion = { activity: mean < 0.055 ? 'low' : mean < 0.15 ? 'moderate' : 'high', score: round(mean), activeSamples: active.length,
      camera: dominant && dominant[1] >= 2 ? dominant[0] : mean > 0.2 ? 'complex-motion' : 'steady',
      cameraConfidence: dominant && dominant[1] >= 3 ? 'medium' : 'low', samples: rows.length, sampleRate: fps };
  }
  return shots;
}

function assignTranscript(shots, transcript) {
  for (const shot of shots) {
    shot.transcript = transcript.filter((t) => t.end > shot.start && t.start < shot.end).map((t) => ({
      start: round(Math.max(shot.start, t.start)), end: round(Math.min(shot.end, t.end)), text: t.text, confidence: t.confidence
    })).filter((t) => t.end > t.start);
    shot.captionText = shot.transcript.map((x) => x.text).join(' ').trim();
  }
  return shots;
}

function summarizeShotMotion(shots, samples) {
  // Separate measured camera-like movement from editorial animation. The estimate is
  // intentionally conservative: global frame matching cannot prove object tracking.
  for (const shot of shots) {
    const rows = samples.filter((m) => m.time >= shot.start && m.time < shot.end);
    const scales = rows.map((m) => Number(m.zoomScale)).filter((v) => Number.isFinite(v) && v > 0);
    const zoomMedian = (values) => {
      const a = values.slice().sort((x, y) => x - y);
      if (!a.length) return null;
      const mid = Math.floor(a.length / 2);
      return round(a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2, 4);
    };
    const zoom = zoomMedian(scales.filter((v) => Math.abs(v - 1) > 0.012));
    const dx = rows.map((m) => Number(m.dx) || 0), dy = rows.map((m) => Number(m.dy) || 0);
    const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    const panX = mean(dx), panY = mean(dy);
    const zoomDirection = zoom == null ? 'none-detected' : zoom > 1.015 ? 'zoom-in-candidate' : zoom < 0.985 ? 'zoom-out-candidate' : 'subtle-or-uncertain';
    const panDirection = Math.abs(panX) < 0.45 && Math.abs(panY) < 0.45 ? 'none-detected' : Math.abs(panX) >= Math.abs(panY) ? (panX > 0 ? 'pan-right-candidate' : 'pan-left-candidate') : (panY > 0 ? 'pan-down-candidate' : 'pan-up-candidate');
    shot.motion = { ...(shot.motion || {}), zoomDirection, zoomMedianScale: zoom, panDirection,
      panEstimate: { x: round(panX, 3), y: round(panY, 3) },
      movementSamples: rows.length, motionEvidence: rows.length >= 4 ? 'low-resolution-global-match' : 'insufficient-samples',
      confidence: rows.length >= 8 && (zoom != null || panDirection !== 'none-detected') ? 'low' : 'very-low' };
    // Keep source motion separate from editable overlay animation, so a template
    // does not accidentally apply the same zoom twice.
    shot.animation = { cameraMotionCandidate: zoomDirection !== 'none-detected' || panDirection !== 'none-detected',
      titleMotion: 'requires-visual-frame-comparison', entrance: 'unknown', exit: 'unknown', easing: 'unknown', confidence: 'unclassified' };
  }
  return shots;
}

function estimateTransition(shots, samples) {
  // Score a window on both sides of every cut. A real hard cut usually produces one
  // dominant spike; a dissolve distributes change over several adjacent samples.
  // This is a review hint, not a visual-model substitute for wipes, masks or motion blur.
  for (let i = 1; i < shots.length; i++) {
    const shot = shots[i], near = samples.filter((s) => Math.abs(s.time - shot.start) <= 0.7).sort((a, b) => a.time - b.time);
    const scores = near.map((s) => Number(s.score) || 0);
    const peak = scores.reduce((m, v) => Math.max(m, v), 0);
    const energetic = scores.filter((v) => v >= 0.14).length;
    const spread = scores.length ? scores.filter((v) => v >= Math.max(0.08, peak * 0.42)).length : 0;
    const gradual = near.length >= 5 && energetic >= 3 && spread >= 3 && peak < 0.72;
    const evidence = { windowSamples: near.length, peakChange: round(peak, 3), energeticSamples: energetic, distributedChangeSamples: spread };
    if (gradual) shot.transition = { type: 'dissolve-candidate', confidence: 'low', evidence, reason: 'frame change is distributed across adjacent samples; verify against full-resolution playback' };
    else shot.transition = { type: 'cut', confidence: shot.boundaryConfidence || 'low', evidence, reason: 'no reliable gradual-transition signature detected' };
  }
  return shots;
}

function selectRepresentativeShots(shots, maxShots = 8) {
  const count = Array.isArray(shots) ? shots.length : 0;
  maxShots = Math.max(1, Math.trunc(Number(maxShots) || 8));
  if (count <= maxShots) return (shots || []).map((shot) => shot.index);
  if (maxShots === 1) return [shots[0].index];
  const chosen = new Set();
  for (let i = 0; i < maxShots; i++) chosen.add(shots[Math.round(i * (count - 1) / (maxShots - 1))].index);
  return [...chosen].sort((a, b) => a - b);
}

function normalizeVisualResult(value) {
  if (!value || typeof value !== 'object') return null;
  const frames = Array.isArray(value.frames) ? value.frames.filter((x) => x && typeof x === 'object' && typeof x.id === 'string') : [];
  const shots = Array.isArray(value.shots) ? value.shots.filter((x) => x && typeof x === 'object') : [];
  return {
    status: frames.length || shots.length ? 'available' : 'empty',
    styleBible: value.styleBible && typeof value.styleBible === 'object' ? value.styleBible : null,
    frames: frames.map((frame) => ({
      id: frame.id.slice(0, 100), description: String(frame.description || '').slice(0, 1600),
      visibleText: Array.isArray(frame.visibleText) ? frame.visibleText.map((x) => String(x).slice(0, 240)).slice(0, 12) : [],
      textPosition: String(frame.textPosition || '').slice(0, 160), typography: String(frame.typography || '').slice(0, 240),
      overlayElements: Array.isArray(frame.overlayElements) ? frame.overlayElements.map((x) => String(x).slice(0, 160)).slice(0, 12) : [],
      palette: Array.isArray(frame.palette) ? frame.palette.map((x) => String(x).slice(0, 60)).slice(0, 8) : [],
      animationEvidence: String(frame.animationEvidence || '').slice(0, 400), confidence: ['high', 'medium', 'low'].includes(frame.confidence) ? frame.confidence : 'low'
    })),
    shots: shots.slice(0, 64).map((shot) => ({ shot: Math.max(1, Math.trunc(Number(shot.shot) || 1)), titleAnimation: String(shot.titleAnimation || shot.titleMotion || '').slice(0, 240), entrance: String(shot.entrance || '').slice(0, 160), exit: String(shot.exit || '').slice(0, 160), easing: String(shot.easing || '').slice(0, 120), transition: String(shot.transition || '').slice(0, 160), evidence: Array.isArray(shot.evidence) ? shot.evidence.map((x) => String(x).slice(0, 240)).slice(0, 8) : [], confidence: ['high', 'medium', 'low'].includes(shot.confidence) ? shot.confidence : 'low' })),
    notes: Array.isArray(value.notes) ? value.notes.map((x) => String(x).slice(0, 300)).slice(0, 20) : []
  };
}

function buildShotBlueprint(shots) {
  return shots.map((shot) => ({
    shot: shot.index + 1, sourceIn: shot.start, sourceOut: shot.end, duration: shot.duration,
    pacing: shot.duration < 1.05 ? 'rapid' : shot.duration < 2.2 ? 'fast' : shot.duration < 4.5 ? 'measured' : 'slow',
    incomingTransition: shot.transition || { type: 'none', confidence: 'high' },
    camera: { zoom: shot.motion?.zoomDirection || 'unknown', pan: shot.motion?.panDirection || 'unknown', activity: shot.motion?.activity || 'unknown', confidence: shot.motion?.confidence || 'very-low' },
    caption: { text: shot.captionText || '', segments: (shot.transcript || []).length, source: 'transcript-if-available' },
    animation: shot.animation || { titleMotion: 'requires-visual-frame-comparison', entrance: 'unknown', exit: 'unknown', easing: 'unknown', confidence: 'unclassified' },
    audioAlignment: shot.audioAlignment || { label: 'not-estimated', confidence: 'low' },
    visualEvidence: shot.visualAnalysis || { status: 'not-sampled' }, reviewRequired: true
  }));
}

async function analyzeReference({ src, ff, transcribe = null, caption = null, analyzeVisualFrames = null, maxVisualShots = 8, maxDuration = 120, onProgress = () => {} } = {}) {
  if (!src || !fs.existsSync(src)) throw new Error(`Reference source not found: ${src || '(empty path)'}`);
  const media = await ff.probe(src);
  if (!media.hasVideo) throw new Error('Reference-to-template requires a video source.');
  if (!(media.duration > 0)) throw new Error('Could not determine the reference duration.');
  if (media.duration > maxDuration + 0.5) throw new Error(`Reference is ${round(media.duration, 1)} seconds; maximum is ${maxDuration} seconds.`);
  onProgress({ phase: 'cuts', message: 'Detecting shot boundaries…' });
  let events = [];
  try { events = await ff.detectSceneEvents(src, 0.28); }
  catch (e) { onProgress({ phase: 'warning', message: `Scene detection unavailable: ${e.message}` }); }
  events = (events || []).filter((e) => Number.isFinite(+e.time) && +e.time > 0 && +e.time < media.duration).map((e) => ({ ...e, time: +e.time }));
  const shots = segmentBoundaries(media.duration, events);
  onProgress({ phase: 'transcript', message: 'Extracting timed captions/transcript…' });
  let transcript = [], transcriptStatus = 'not-requested';
  if (media.hasAudio && typeof transcribe === 'function') {
    try { transcript = normalizeTranscript(await transcribe(src), media.duration); transcriptStatus = transcript.length ? 'available' : 'empty'; }
    catch (e) { transcriptStatus = 'unavailable'; onProgress({ phase: 'warning', message: `Transcript not available: ${e.message}` }); }
  }
  assignTranscript(shots, transcript);
  onProgress({ phase: 'motion', message: 'Measuring frame motion and audio rhythm…' });
  let motionSamples = [], audioAnalysis = { status: 'unavailable', reason: 'not-run', onsets: [], beatTimes: [], estimatedBpm: null, beatConfidence: 0 };
  const [motionResult, audioResult] = await Promise.allSettled([
    extractMotionSamples(src, ff, media.duration),
    media.hasAudio ? extractAudioFeatures(src, ff, media.duration) : Promise.resolve({ status: 'unavailable', reason: 'no-audio-stream', onsets: [], beatTimes: [], estimatedBpm: null, beatConfidence: 0 })
  ]);
  if (motionResult.status === 'fulfilled') motionSamples = motionResult.value || [];
  if (audioResult.status === 'fulfilled') audioAnalysis = audioResult.value || audioAnalysis;
  describeMotion(shots, motionSamples);
  summarizeShotMotion(shots, motionSamples);
  estimateTransition(shots, motionSamples);

  const selectedShotIndices = new Set(selectRepresentativeShots(shots, Math.max(1, Math.min(12, Math.trunc(maxVisualShots) || 8))));
  const representativeFrames = [];
  // Sample temporal phases across the entire video, not merely the opening shots.
  // Start/middle/end comparisons are the minimum useful evidence for overlay animation.
  for (const shot of shots.filter((candidate) => selectedShotIndices.has(candidate.index))) {
    const span = Math.max(0, shot.end - shot.start);
    for (const [phase, portion] of [['start', 0.08], ['middle', 0.5], ['end', 0.92]]) {
      representativeFrames.push({ id: `shot-${shot.index + 1}-${phase}`, time: round(shot.start + span * portion), shot: shot.index, phase, path: null, visualDescription: '', visualEvidence: null });
    }
  }
  let visualAnalysis = { status: 'not-requested', styleBible: null, frames: [], shots: [], notes: [] };
  if (typeof analyzeVisualFrames === 'function' && representativeFrames.length) {
    onProgress({ phase: 'visual', message: `Comparing ${representativeFrames.length} temporal reference frames for typography, overlays, motion and transitions…` });
    try {
      const raw = await analyzeVisualFrames(src, representativeFrames.map(({ id, time, shot, phase }) => ({ id, time, shot, phase })));
      visualAnalysis = normalizeVisualResult(raw) || { status: 'unavailable', styleBible: null, frames: [], shots: [], notes: ['Visual model returned no structured result.'] };
      const byId = new Map(visualAnalysis.frames.map((frame) => [frame.id, frame]));
      for (const frame of representativeFrames) {
        const evidence = byId.get(frame.id);
        if (!evidence) continue;
        frame.visualEvidence = evidence;
        frame.visualDescription = [evidence.description, evidence.visibleText.length ? `Visible text: ${evidence.visibleText.join(' | ')}` : '', evidence.textPosition ? `Text position: ${evidence.textPosition}` : '', evidence.typography ? `Typography: ${evidence.typography}` : '', evidence.animationEvidence ? `Animation evidence: ${evidence.animationEvidence}` : ''].filter(Boolean).join('. ').slice(0, 1600);
      }
    } catch (error) {
      visualAnalysis = { status: 'unavailable', styleBible: null, frames: [], shots: [], notes: [`Visual comparison failed: ${String(error?.message || error).slice(0, 240)}`] };
      onProgress({ phase: 'warning', message: `Visual reference comparison unavailable: ${error.message}` });
    }
  } else if (typeof caption === 'function' && representativeFrames.length) {
    onProgress({ phase: 'visual', message: 'Inspecting sampled frames for visible titles/caption style…' });
    for (const frame of representativeFrames) {
      try { const r = await caption(src, frame.time, frame.shot, frame.phase); if (r) frame.visualDescription = String(r).slice(0, 1200); }
      catch { /* Visual analysis is optional; measured timeline data remains available. */ }
    }
    visualAnalysis = { status: representativeFrames.some((x) => x.visualDescription) ? 'available-descriptions-only' : 'unavailable', styleBible: null, frames: [], shots: [], notes: [] };
  }
  const visualByShot = new Map();
  for (const frame of representativeFrames) {
    if (!visualByShot.has(frame.shot)) visualByShot.set(frame.shot, []);
    visualByShot.get(frame.shot).push(frame);
  }
  for (const shot of shots) {
    const sampled = visualByShot.get(shot.index) || [];
    const visibleText = [...new Set(sampled.flatMap((frame) => frame.visualEvidence?.visibleText || []))].slice(0, 20);
    shot.visualAnalysis = { status: sampled.length ? (visualAnalysis.status.startsWith('available') ? 'sampled' : visualAnalysis.status) : 'not-sampled', phases: sampled.map((frame) => frame.phase), visibleText, evidence: sampled.filter((frame) => frame.visualDescription).map((frame) => ({ phase: frame.phase, time: frame.time, description: frame.visualDescription, confidence: frame.visualEvidence?.confidence || 'low' })) };
    const animation = visualAnalysis.shots.find((candidate) => candidate.shot === shot.index + 1);
    if (animation) shot.animation = { ...shot.animation,
      titleMotion: animation.titleAnimation || shot.animation.titleMotion,
      entrance: animation.entrance || shot.animation.entrance, exit: animation.exit || shot.animation.exit,
      easing: animation.easing || shot.animation.easing,
      confidence: animation.confidence || 'low', evidence: animation.evidence || [] };
  }
  const alignedCuts = alignCutsToAudio(events, audioAnalysis);
  for (const shot of shots.slice(1)) {
    const candidate = alignedCuts.reduce((best, event) => !best || Math.abs(event.time - shot.start) < Math.abs(best.time - shot.start) ? event : best, null);
    shot.audioAlignment = candidate && Math.abs(candidate.time - shot.start) <= 0.12 ? candidate.audioAlignment : { label: 'not-estimated', confidence: 'low' };
  }
  const visualTextStatus = visualAnalysis.status === 'available' || visualAnalysis.status === 'available-descriptions-only' ? 'available' : visualAnalysis.status;
  const pace = paceSummary(shots);
  const blueprint = buildShotBlueprint(shots);
  const transitions = shots.slice(1).reduce((o, shot) => { const k = shot.transition.type; o[k] = (o[k] || 0) + 1; return o; }, {});
  return { schemaVersion: 3, kind: 'frosty-reference-analysis', source: { path: path.resolve(src), name: media.name || path.basename(src), duration: round(media.duration), width: media.width, height: media.height, hasAudio: media.hasAudio, hasVideo: media.hasVideo }, analyzedAt: new Date().toISOString(),
    cuts: { count: Math.max(0, shots.length - 1), threshold: 0.28, events: alignedCuts.map((e) => ({ time: round(e.time), score: e.score ?? null, confidence: e.confidence || 'low', audioAlignment: e.audioAlignment })) }, pace, transitions, shots, blueprint,
    captions: { transcriptStatus, segmentCount: transcript.length, visualTextStatus, transcript }, motion: { status: motionSamples.length ? 'measured' : 'unavailable', sampleCount: motionSamples.length, sampleRate: 3, cameras: Object.fromEntries(shots.reduce((m, shot) => { const key = shot.motion.camera || 'unknown'; m.set(key, (m.get(key) || 0) + 1); return m; }, new Map())) },
    audio: audioAnalysis, visualAnalysis,
    animation: { analysisStatus: visualAnalysis.status === 'available' ? 'vision-compared-temporal-first-pass' : visualTextStatus === 'available-descriptions-only' ? 'vision-described-first-pass' : 'visual-model-required-for-style-classification', textAnimationEvidence: representativeFrames.filter((x) => x.visualDescription).map((x) => ({ id: x.id, shot: x.shot, phase: x.phase, time: x.time, description: x.visualDescription, evidence: x.visualEvidence })), styleBible: visualAnalysis.styleBible, note: 'Frame-pair comparisons are model hypotheses, not the source editor project or exact keyframes. Source-camera motion is measured separately from overlay animation.' },
    visualSamples: representativeFrames, limitations: ['Cut timestamps are FFmpeg scene-score estimates; rapid flashes and very short shots can be missed or merged.', 'Zoom/pan labels are low-resolution global-motion estimates, not guaranteed camera tracking.', 'Transition labels are conservative candidates; wipes, slides, masks and stylized transitions require visual confirmation.', 'Camera zoom/pan candidates may reflect object motion instead of camera movement.', 'Vision-reported text, easing, typography and transitions are hypotheses and may be wrong; high-confidence exact reconstruction requires original project assets or frame-accurate iterative comparison.', 'Audio beat detection is an envelope-based rhythmic estimate, not source separation or guaranteed musical beat tracking.', 'Visible on-screen text may be missed when no vision-capable model is configured.'] };
}

function visibleTextMatchesTranscript(row, analysis) {
  const stop = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'are', 'was', 'were', 'have', 'has', 'had', 'from', 'into', 'then', 'than', 'but', 'not', 'can', 'will', 'its', 'our', 'they', 'them', 'his', 'her', 'she', 'him', 'who', 'what', 'when', 'where', 'how', 'why', 'all', 'just', 'like', 'yeah', 'okay']);
  const words = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter((word) => word.length > 1 && !stop.has(word));
  const rowWords = new Set(words(row.text));
  if (rowWords.size < 2) return null;
  const midpoint = (row.start + row.end) / 2;
  const relatedShots = (analysis.shots || []).filter((shot) => shot.end > row.start && shot.start < row.end);
  const candidates = [];
  for (const shot of relatedShots) for (const text of shot.visualAnalysis?.visibleText || []) candidates.push({ text, time: midpoint, shot: shot.index, confidence: 'medium' });
  for (const frame of analysis.visualSamples || []) {
    if (Math.abs((Number(frame.time) || 0) - midpoint) > Math.max(0.7, (row.end - row.start) * 0.7) && !relatedShots.some((shot) => shot.index === frame.shot)) continue;
    for (const text of frame.visualEvidence?.visibleText || []) candidates.push({ text, time: frame.time, shot: frame.shot, confidence: frame.visualEvidence.confidence || 'low' });
  }
  for (const candidate of candidates) {
    if (candidate.confidence === 'low' || String(candidate.text || '').trim().length < 4) continue;
    const visible = words(candidate.text);
    if (visible.length < 2) continue;
    const overlap = visible.filter((word) => rowWords.has(word)).length;
    const ratio = overlap / visible.length;
    // Require almost all meaningful words from the visible caption to appear in the transcript.
    // This avoids suppressing unrelated overlays that happen to share one common word.
    if (overlap >= 2 && ratio >= 0.8) return { visibleText: candidate.text, shot: candidate.shot, time: candidate.time, confidence: candidate.confidence, overlapRatio: round(ratio, 2) };
  }
  return null;
}

function mapTranscriptToTimeline(tl, analysis, { includeCaptions = true, avoidDuplicateVisibleCaptions = true } = {}) {
  if (!includeCaptions) return [];
  const transcript = analysis?.captions?.transcript || [];
  const layout = TL.layout(tl);
  const added = [], skippedVisible = [];
  analysis.captionOverlayAudit = { requested: true, added: 0, skippedVisibleDuplicates: 0, skippedEvidence: [] };
  for (const row of transcript) {
    const visibleMatch = avoidDuplicateVisibleCaptions ? visibleTextMatchesTranscript(row, analysis || {}) : null;
    if (visibleMatch) {
      skippedVisible.push({ start: row.start, end: row.end, transcript: row.text, matchedVisibleText: visibleMatch.visibleText, shot: visibleMatch.shot, confidence: visibleMatch.confidence });
      continue;
    }
    for (const item of layout) {
      const clip = item.clip, sourceStart = Math.max(Number(clip.in) || 0, row.start), sourceEnd = Math.min(Number(clip.out) || 0, row.end);
      if (sourceEnd - sourceStart < 0.06) continue;
      const speed = Math.max(0.1, Number(clip.speed) || 1);
      const start = item.start + (sourceStart - clip.in) / speed;
      const dur = (sourceEnd - sourceStart) / speed;
      if (!row.text || dur < 0.08) continue;
      const existing = tl.text.find((x) => x.text === row.text && Math.abs(x.start - start) < 0.08);
      if (existing) continue;
      const text = TL.addText(tl, row.text, round(start), round(dur), { size: tl.settings.height >= 1400 ? 54 : 42, color: '#ffffff', pos: 'bottom', fade: [80, 100], source: 'reference-transcript', confidence: row.confidence ?? null });
      added.push(text);
    }
  }
  analysis.captionOverlayAudit = { requested: true, added: added.length, skippedVisibleDuplicates: skippedVisible.length, skippedEvidence: skippedVisible.slice(0, 40) };
  return added;
}

function buildTemplate(analysis, { includeCaptions = true, preserveSourceMotion = true } = {}) {
  const media = analysis.source;
  const tl = TL.empty();
  tl.settings.width = clamp(media.width || 1920, 16, 16384);
  tl.settings.height = clamp(media.height || 1080, 16, 16384);
  tl.mode = 'sequential';
  tl.trackCount = Math.max(2, tl.trackCount || 2);
  const shots = analysis.shots?.length ? analysis.shots : segmentBoundaries(media.duration, []);
  const src = media.path;
  for (const shot of shots) {
    const clip = TL.addClip(tl, { path: src, name: `${media.name || 'Reference'} · Shot ${shot.index + 1}`, duration: shot.duration, type: 'video', hasAudio: media.hasAudio });
    clip.in = shot.start; clip.out = shot.end; clip.name = `${media.name || 'Reference'} · Shot ${shot.index + 1}`;
    clip.referenceShot = shot.index; clip.referenceMotion = shot.motion;
    clip.referenceBoundary = { transition: shot.transition, boundaryScore: shot.boundaryScore, confidence: shot.boundaryConfidence };
    // Source movement is preserved by trimming the original footage; do not double-apply inferred camera motion.
    if (preserveSourceMotion && shot.motion) clip.referenceMotionPreserved = true;
  }
  // Apply only conservative, low-impact crossfades. Hard cuts remain hard cuts.
  for (let i = 1; i < tl.video.length; i++) {
    const shot = shots[i];
    if (shot?.transition?.type === 'dissolve' && shot.transition.confidence !== 'low') tl.video[i].trans = { type: 'dissolve', dur: 0.25 };
  }
  mapTranscriptToTimeline(tl, analysis, { includeCaptions });
  tl.referenceTemplate = { schemaVersion: 1, sourcePath: media.path, sourceName: media.name, sourceDuration: media.duration, createdAt: new Date().toISOString(),
    analysis: { schemaVersion: analysis.schemaVersion || 1, cuts: analysis.cuts, pace: analysis.pace, transitions: analysis.transitions, motion: analysis.motion, audio: analysis.audio, visualAnalysis: analysis.visualAnalysis, animation: analysis.animation, captionOverlayAudit: analysis.captionOverlayAudit, captions: { transcriptStatus: analysis.captions?.transcriptStatus, segmentCount: analysis.captions?.segmentCount },
      shots: shots.map(({ index, start, end, duration, transition, motion, animation, audioAlignment, visualAnalysis, captionText, transcript }) => ({ index, start, end, duration, transition, motion, animation, audioAlignment, visualAnalysis, captionText, transcript })), blueprint: analysis.blueprint || buildShotBlueprint(shots) },
    note: 'The source remains editable. Detected shot boundaries, transcript captions, and motion metadata are first-pass estimates; review before delivery.' };
  return tl;
}

module.exports = { normalizeTranscript, segmentBoundaries, paceSummary, parseMotionBytes, analyzeAudioPcm, extractAudioFeatures, alignCutsToAudio, extractMotionSamples, describeMotion, summarizeShotMotion, estimateTransition, selectRepresentativeShots, normalizeVisualResult, buildShotBlueprint, analyzeReference, visibleTextMatchesTranscript, mapTranscriptToTimeline, buildTemplate };
