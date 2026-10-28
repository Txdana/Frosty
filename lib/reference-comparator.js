'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const round = (value, places = 3) => +Number(value || 0).toFixed(places);

async function extractRgbFrames(file, ff, { duration, fps = 2, width = 160, height = 90, timeoutMs = 60000 } = {}) {
  const frameBytes = width * height * 3;
  const maxFrames = Math.max(1, Math.ceil(duration * fps) + 1);
  return await new Promise((resolve, reject) => {
    const chunks = []; let byteCount = 0, completed = false, stderr = '';
    const maxBytes = frameBytes * maxFrames + frameBytes;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-t', String(Math.max(0.05, duration)),
      '-vf', `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=area,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,format=rgb24`,
      '-frames:v', String(maxFrames), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
    ];
    const proc = spawn(ff.ffmpegPath(), args, { windowsHide: true });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    const finish = (fn, value) => { if (completed) return; completed = true; clearTimeout(timer); fn(value); };
    proc.stdout.on('data', (chunk) => {
      const allowed = Math.min(chunk.length, Math.max(0, maxBytes - byteCount));
      if (allowed > 0) { chunks.push(allowed === chunk.length ? chunk : chunk.subarray(0, allowed)); byteCount += allowed; }
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); if (stderr.length > 12000) stderr = stderr.slice(-12000); });
    proc.on('error', (error) => finish(reject, error));
    proc.on('close', (code) => {
      if (code !== 0) return finish(reject, new Error(stderr.trim() || `FFmpeg frame sampling failed (${code}).`));
      const buffer = Buffer.concat(chunks);
      if (!buffer.length || buffer.length % frameBytes !== 0) return finish(reject, new Error(`Invalid RGB sample buffer for ${path.basename(file)}.`));
      finish(resolve, { buffer, frameBytes, frameCount: buffer.length / frameBytes, width, height, fps });
    });
  });
}

function frameStats(a, b, bytesPerFrame) {
  const channels = 3, pixels = bytesPerFrame / channels;
  let absolute = 0, squared = 0;
  const sumA = [0, 0, 0], sumB = [0, 0, 0], sumSqA = [0, 0, 0], sumSqB = [0, 0, 0], sumAB = [0, 0, 0];
  for (let i = 0; i < bytesPerFrame; i++) {
    const x = a[i], y = b[i], d = x - y, c = i % channels;
    absolute += Math.abs(d); squared += d * d;
    sumA[c] += x; sumB[c] += y; sumSqA[c] += x * x; sumSqB[c] += y * y; sumAB[c] += x * y;
  }
  const mae = absolute / bytesPerFrame, mse = squared / bytesPerFrame;
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
  const channelSsim = [];
  for (let c = 0; c < channels; c++) {
    const meanA = sumA[c] / pixels, meanB = sumB[c] / pixels;
    const varA = Math.max(0, sumSqA[c] / pixels - meanA * meanA);
    const varB = Math.max(0, sumSqB[c] / pixels - meanB * meanB);
    const covariance = sumAB[c] / pixels - meanA * meanB;
    channelSsim.push(((2 * meanA * meanB + c1) * (2 * covariance + c2)) / ((meanA * meanA + meanB * meanB + c1) * (varA + varB + c2)));
  }
  return { mae: round(mae, 3), similarityPercent: round(100 * (1 - mae / 255), 2), psnrDb: mse < 1e-12 ? 99 : round(10 * Math.log10((255 * 255) / mse), 2), globalSsimEstimate: round(channelSsim.reduce((x, y) => x + y, 0) / channels, 5) };
}

function compareFrameBuffers(reference, rendered, { duration, fps = 2, width = 160, height = 90 } = {}) {
  const bytesPerFrame = width * height * 3;
  const referenceCount = Math.floor(reference.length / bytesPerFrame), renderedCount = Math.floor(rendered.length / bytesPerFrame);
  const count = Math.min(referenceCount, renderedCount, Math.ceil(duration * fps));
  if (!count) throw new Error('No time-aligned frames were available to compare.');
  const frames = [];
  let totalAbs = 0, totalSquared = 0, totalBytes = 0, totalSsim = 0;
  for (let i = 0; i < count; i++) {
    const a = reference.subarray(i * bytesPerFrame, (i + 1) * bytesPerFrame);
    const b = rendered.subarray(i * bytesPerFrame, (i + 1) * bytesPerFrame);
    const stats = frameStats(a, b, bytesPerFrame);
    frames.push({ time: round(i / fps, 3), ...stats });
    totalAbs += stats.mae * bytesPerFrame;
    totalSsim += stats.globalSsimEstimate;
    // PSNR is reported per frame above; aggregate MSE is recomputed for accuracy below.
    for (let j = 0; j < bytesPerFrame; j++) { const d = a[j] - b[j]; totalSquared += d * d; }
    totalBytes += bytesPerFrame;
  }
  const mae = totalAbs / Math.max(1, totalBytes);
  const mse = totalSquared / Math.max(1, totalBytes);
  const worst = frames.slice().sort((a, b) => b.mae - a.mae).slice(0, 10);
  const best = frames.slice().sort((a, b) => a.mae - b.mae).slice(0, 10);
  return {
    method: 'RGB frame sampling at equal timestamps; global SSIM is an approximate per-frame statistic, not standards-compliant local SSIM.',
    sampling: { fps, width, height, comparedFrames: count, sampledDuration: round(count / fps), referenceFrames: referenceCount, renderedFrames: renderedCount },
    pixel: { meanAbsoluteError: round(mae, 3), similarityPercent: round(100 * (1 - mae / 255), 2), psnrDb: mse < 1e-12 ? 99 : round(10 * Math.log10((255 * 255) / mse), 2), globalSsimEstimate: round(totalSsim / count, 5) },
    frames: { worst, best },
    frameCountDifference: referenceCount - renderedCount
  };
}

async function compareVideos(referencePath, renderedPath, ff, { fps = 2, width = 160, height = 90, maxDuration = 120 } = {}) {
  if (!referencePath || !renderedPath || !fs.existsSync(referencePath) || !fs.existsSync(renderedPath)) throw new Error('Both the reference and rendered video files must exist.');
  const [referenceMeta, renderedMeta] = await Promise.all([ff.probe(referencePath), ff.probe(renderedPath)]);
  if (!referenceMeta.hasVideo || !renderedMeta.hasVideo) throw new Error('Reference comparison requires two decodable video files.');
  if (!(referenceMeta.duration > 0) || !(renderedMeta.duration > 0)) throw new Error('Could not determine both video durations.');
  fps = Math.max(1, Math.min(4, Number(fps) || 2));
  width = Math.max(80, Math.min(320, Math.trunc(Number(width) || 160)));
  height = Math.max(45, Math.min(180, Math.trunc(Number(height) || 90)));
  const commonDuration = Math.min(referenceMeta.duration, renderedMeta.duration, maxDuration);
  // Sample each complete bounded duration separately so the report can surface
  // trailing/leading frame-count mismatches instead of hiding them by truncating
  // both files to the shorter duration before sampling.
  const [referenceFrames, renderedFrames] = await Promise.all([
    extractRgbFrames(referencePath, ff, { duration: Math.min(referenceMeta.duration, maxDuration), fps, width, height }),
    extractRgbFrames(renderedPath, ff, { duration: Math.min(renderedMeta.duration, maxDuration), fps, width, height })
  ]);
  const visual = compareFrameBuffers(referenceFrames.buffer, renderedFrames.buffer, { duration: commonDuration, fps, width, height });
  let referenceCuts = [], renderedCuts = [];
  try {
    [referenceCuts, renderedCuts] = await Promise.all([ff.detectSceneEvents(referencePath, 0.28), ff.detectSceneEvents(renderedPath, 0.28)]);
  } catch { /* Pixel metrics remain useful when the FFmpeg build lacks scene scoring. */ }
  const referenceTimes = referenceCuts.map((cut) => Number(cut.time)).filter(Number.isFinite);
  const renderedTimes = renderedCuts.map((cut) => Number(cut.time)).filter(Number.isFinite);
  const tolerance = 0.18;
  const cutMatches = referenceTimes.map((time) => {
    const nearest = renderedTimes.reduce((best, candidate) => best == null || Math.abs(candidate - time) < Math.abs(best - time) ? candidate : best, null);
    return { reference: round(time), rendered: nearest == null ? null : round(nearest), delta: nearest == null ? null : round(nearest - time), matched: nearest != null && Math.abs(nearest - time) <= tolerance };
  });
  const matched = cutMatches.filter((item) => item.matched).length;
  return {
    ...visual,
    videos: { reference: { name: path.basename(referencePath), duration: round(referenceMeta.duration), width: referenceMeta.width, height: referenceMeta.height, hasAudio: referenceMeta.hasAudio }, rendered: { name: path.basename(renderedPath), duration: round(renderedMeta.duration), width: renderedMeta.width, height: renderedMeta.height, hasAudio: renderedMeta.hasAudio } },
    durationDifferenceSeconds: round(renderedMeta.duration - referenceMeta.duration), commonDuration: round(commonDuration),
    audioPresenceMismatch: Boolean(referenceMeta.hasAudio) !== Boolean(renderedMeta.hasAudio),
    cuts: { referenceCount: referenceTimes.length, renderedCount: renderedTimes.length, matchToleranceSeconds: tolerance, matchedReferenceCuts: matched, matchedRatio: referenceTimes.length ? round(matched / referenceTimes.length, 3) : null, matches: cutMatches }
  };
}

module.exports = { extractRgbFrames, frameStats, compareFrameBuffers, compareVideos };
