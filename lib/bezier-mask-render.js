'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const BM = require('./bezier-mask');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const T = n => String(Number(Number(n).toFixed(9)));

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii'); const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0); name.copy(chunk, 4); data.copy(chunk, 8); chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length); return chunk;
}
function writeGrayPng(file, width, height, pixels) {
  width = Math.trunc(width); height = Math.trunc(height);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width + 1; const scanlines = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y++) { scanlines[y * stride] = 0; pixels.copy(scanlines, y * stride + 1, y * width, (y + 1) * width); }
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(scanlines, { level: 3 })), pngChunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(file, png);
}

function rasterizeBezierMask(mask, width, height, time = 0, samplesPerSegment = 12) {
  const nodes = BM.evaluateNodes(mask, time);
  const polygon = BM.sampleNodes(nodes, samplesPerSegment).map(p => ({ x: p.x * width, y: p.y * height }));
  const pixels = Buffer.alloc(width * height, 0);
  let minY = height, maxY = 0;
  for (const p of polygon) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const yStart = clamp(Math.floor(minY), 0, height - 1), yEnd = clamp(Math.ceil(maxY), 0, height - 1);
  const intersections = [];
  for (let y = yStart; y <= yEnd; y++) {
    intersections.length = 0; const py = y + 0.5;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      if ((a.y <= py && b.y > py) || (b.y <= py && a.y > py)) intersections.push(a.x + (py - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    intersections.sort((a,b) => a-b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const left = clamp(Math.ceil(intersections[i] - 0.5), 0, width), right = clamp(Math.ceil(intersections[i + 1] - 0.5), 0, width);
      if (right > left) pixels.fill(255, y * width + left, y * width + right);
    }
  }
  return pixels;
}

function collectAnimatedBezierMasks(timeline) {
  const out = [];
  for (const [kind, list] of [['clip', timeline?.video || []], ['layer', timeline?.layers || []]]) {
    for (const owner of list) {
      const mask = owner?.mask;
      if (!mask || mask.enabled === false || mask.shape !== 'bezier') continue;
      const keys = BM.normalizePathKeyframes(mask);
      if (keys.length < 2) continue;
      if (!owner.src) throw new Error(`Animated Bézier mask on ${owner.name || owner.id || kind} has no media source.`);
      out.push({ key: `${kind}:${owner.id}`, kind, owner, mask, keys });
    }
  }
  return out;
}

async function prepareBezierMaskVideos(timeline, options, workspace, dependencies) {
  const entries = collectAnimatedBezierMasks(timeline);
  if (!entries.length) return {};
  const run = dependencies?.run;
  const probe = dependencies?.probe;
  if (typeof run !== 'function' || typeof probe !== 'function') throw new TypeError('FFmpeg run and media probe functions are required for animated Bézier masks.');
  fs.mkdirSync(workspace, { recursive: true });
  const rawFps = options.fpsValue || options.fps || 30;
  const fpsParts = String(rawFps).split('/').map(Number);
  const fps = fpsParts.length === 2 && fpsParts.every(Number.isFinite) && fpsParts[1] !== 0 ? fpsParts[0] / fpsParts[1] : Number(rawFps);
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new RangeError('Bézier mask frame rate must be between 1 and 120 fps.');
  const result = {};
  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx], owner = entry.owner;
    const meta = await probe(owner.src);
    const width = clamp(Math.round(Number(meta.width) || Number(options.width) || 1280), 16, 7680);
    const height = clamp(Math.round(Number(meta.height) || Number(options.height) || 720), 16, 4320);
    const duration = entry.kind === 'clip'
      ? Math.max(1 / fps, (Math.max(0, Number(owner.out) - Number(owner.in)) / Math.max(.01, Number(owner.speed) || 1)))
      : Math.max(1 / fps, Number(owner.out) - Number(owner.in));
    const frames = Math.max(1, Math.ceil(duration * fps - 1e-9));
    if (frames > 216000) throw new Error(`Animated Bézier mask for ${owner.name || owner.id} is longer than the supported 2-hour frame budget.`);
    const frameDir = path.join(workspace, `bezier-${idx}-${String(owner.id).replace(/[^a-z0-9_-]/gi, '_')}`);
    fs.mkdirSync(frameDir, { recursive: true });
    const pattern = path.join(frameDir, 'mask-%06d.png');
    for (let frame = 0; frame < frames; frame++) {
      const t = frame / fps;
      const pixels = rasterizeBezierMask(entry.mask, width, height, t);
      writeGrayPng(pattern.replace('%06d', String(frame).padStart(6, '0')), width, height, pixels);
    }
    const mattePath = path.join(workspace, `bezier-${idx}.mkv`);
    try {
      await run(['-y', '-hide_banner', '-loglevel', 'error', '-framerate', T(fps), '-start_number', '0', '-i', pattern,
        '-frames:v', String(frames), '-an', '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'gray', mattePath]);
    } catch (error) {
      throw new Error(`Could not pre-render animated Bézier mask for ${owner.name || owner.id}: ${error.message}`);
    } finally { fs.rmSync(frameDir, { recursive: true, force: true }); }
    result[entry.key] = { path: mattePath, duration, width, height, frames };
  }
  return result;
}

function maskMatteFilters(mask) {
  const out = [];
  const feather = clamp(Number(mask?.feather) || 0, 0, 100);
  if (feather > 0.001) out.push(`gblur=sigma=${T(Math.max(.1, feather / 3))}`);
  if (mask?.invert) out.push('negate');
  out.push('format=gray');
  return out.join(',');
}

module.exports = { rasterizeBezierMask, collectAnimatedBezierMasks, prepareBezierMaskVideos, maskMatteFilters, writeGrayPng };
