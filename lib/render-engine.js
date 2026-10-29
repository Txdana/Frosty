// Shared, frame-indexed preview renderer. It samples each active source at the
// project's exact rational-frame timestamp, then delegates compositing/effects
// to the same FFmpeg free-timeline graph used by export.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TL = require('./timeline');
const ff = require('./ffmpeg');
const BezierMask = require('./bezier-mask');

const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;
const T = (n) => String(Number(Number(n).toFixed(9)));
const frameCache = new Map();
let cachedBytes = 0;
const MAX_CACHE_ITEMS = 40;
const MAX_CACHE_BYTES = 24 * 1024 * 1024;

function fileFingerprint(file) {
  try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return 'missing'; }
}
function stableCacheKey({ timeline, frame, width, height, fps }) {
  const sources = new Set();
  for (const c of timeline.video || []) if (c.src) sources.add(c.src);
  for (const c of timeline.layers || []) if (c.src) sources.add(c.src);
  for (const c of timeline.audio || []) if (c.src) sources.add(c.src);
  if (timeline.music?.src) sources.add(timeline.music.src);
  const sourceState = [...sources].sort().map((src) => [src, fileFingerprint(src)]);
  return crypto.createHash('sha256').update(JSON.stringify({ timeline, frame, width, height, fps, sourceState })).digest('hex');
}
function cacheGet(key) {
  const found = frameCache.get(key);
  if (!found) return null;
  frameCache.delete(key); frameCache.set(key, found);
  return found;
}
function cachePut(key, value) {
  const size = value.length;
  if (size > MAX_CACHE_BYTES) return;
  const previous = frameCache.get(key);
  if (previous) { cachedBytes -= previous.length; frameCache.delete(key); }
  frameCache.set(key, value); cachedBytes += size;
  while (frameCache.size > MAX_CACHE_ITEMS || cachedBytes > MAX_CACHE_BYTES) {
    const oldestKey = frameCache.keys().next().value;
    const oldest = frameCache.get(oldestKey);
    frameCache.delete(oldestKey); cachedBytes -= oldest.length;
  }
}
function trackVisible(tl, track) {
  const state = tl.trackState?.[String(Number(track) || 1)];
  return !state || state.visible !== false;
}
function evaluated(obj, property, localTime, fallback) {
  return TL.evaluateKeyframes(obj, property, Math.max(0, localTime), fallback);
}
function fadeAlpha(clip, localTime, duration) {
  const [fadeIn = 0, fadeOut = 0] = Array.isArray(clip.fade) ? clip.fade : [0, 0];
  let alpha = 1;
  if (fadeIn > 0) alpha *= Math.max(0, Math.min(1, localTime / fadeIn));
  if (fadeOut > 0) alpha *= Math.max(0, Math.min(1, (duration - localTime) / fadeOut));
  return alpha;
}
async function extractSourceFrame(src, sourceTime, destination, isImage, signal, hardwareAcceleration = 'auto') {
  if (signal?.aborted) { const error = new Error('Preview rendering cancelled'); error.name = 'AbortError'; throw error; }
  if (!fs.existsSync(src)) throw new Error(`Preview source is missing: ${src}`);
  const buildArgs = (hardware) => {
    const args = ['-y'];
    // Hardware decoding accelerates source-frame extraction where the installed
    // FFmpeg build and driver support it. Filters/compositing still run in FFmpeg's
    // common graph and unsupported devices retry on software decode.
    if (!isImage && hardware) args.push('-hwaccel', hardware === true ? 'auto' : String(hardware));
    if (!isImage && sourceTime > 0) args.push('-ss', T(sourceTime));
    args.push('-i', src, '-frames:v', '1', '-compression_level', '3', destination);
    return args;
  };
  const requested = !isImage && hardwareAcceleration !== false && hardwareAcceleration !== 'off';
  let accelerated = false;
  if (requested) {
    try { await ff.run(buildArgs(hardwareAcceleration === true ? 'auto' : (hardwareAcceleration || 'auto')), { signal }); accelerated = true; }
    catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      // Clear partial output before retrying without GPU acceleration.
      try { fs.rmSync(destination, { force: true }); } catch {}
      await ff.run(buildArgs(null), { signal });
    }
  } else await ff.run(buildArgs(null), { signal });
  if (!fs.existsSync(destination) || fs.statSync(destination).size < 64) throw new Error(`Could not decode a preview frame from ${path.basename(src)}`);
  return { path: destination, decodeMode: accelerated ? 'hardware-auto-attempted' : requested ? 'cpu-fallback' : 'cpu' };
}

/**
 * Build a renderer-neutral plan for one project frame. Frame positions are
 * integers; seconds are derived only at the FFmpeg boundary.
 */
function createRenderPlan(timeline, frame, options = {}) {
  const tl = TL.ensure(TL.clone(timeline));
  const fps = TL.frameRateString(options.fps ?? tl);
  const time = TL.frameToSeconds(frame, fps);
  const activeMain = TL.layout(tl).filter((item) => time >= item.start - 1e-9 && time < item.end - 1e-9 && trackVisible(tl, item.clip.track || 1));
  const activeLayers = (tl.layers || []).filter((item) => time >= (+item.start || 0) - 1e-9 && time < (+item.start || 0) + Math.max(0, item.out - item.in) - 1e-9 && trackVisible(tl, item.track || 2));
  const activeText = (tl.text || []).filter((item) => time >= (+item.start || 0) - 1e-9 && time < (+item.start || 0) + Math.max(0, +item.dur || 0) - 1e-9);
  return { timeline: tl, frame: Math.max(0, Math.trunc(Number(frame) || 0)), time, fps, fpsValue: TL.frameRateValue(fps), frameDuration: TL.frameDuration(fps), activeMain, activeLayers, activeText };
}

async function renderPreviewFrame(timeline, frame, options = {}) {
  if (!timeline || typeof timeline !== 'object') throw new TypeError('A timeline model is required');
  const tl = TL.ensure(TL.clone(timeline));
  const signal = options.signal;
  if (signal?.aborted) { const error = new Error('Preview rendering cancelled'); error.name = 'AbortError'; throw error; }
  const fps = TL.frameRateString(options.fps ?? tl);
  const width = Math.max(16, Math.min(8192, Math.round(Number(options.width) || tl.settings.width || 1280)));
  const height = Math.max(16, Math.min(8192, Math.round(Number(options.height) || tl.settings.height || 720)));
  const frameIndex = Math.max(0, Math.trunc(Number(frame) || 0));
  const cacheKey = stableCacheKey({ timeline: tl, frame: frameIndex, width, height, fps });
  const cached = cacheGet(cacheKey);
  if (cached) return { dataUrl: `data:image/jpeg;base64,${cached.toString('base64')}`, frame: frameIndex, time: TL.frameToSeconds(frameIndex, fps), fps, width, height, cached: true };

  const plan = createRenderPlan(tl, frameIndex, { fps });
  const hasSequentialTransition = tl.mode !== 'free' && plan.activeMain.length === 2 && !!plan.activeMain[1].clip.trans;
  const useSequentialGraph = tl.mode !== 'free' && (plan.activeMain.length === 1 || hasSequentialTransition);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-preview-'));
  const sourceFrames = new Map();
  const decodeModes = new Set();
  const snapshot = TL.empty();
  snapshot.mode = useSequentialGraph ? 'sequential' : 'free';
  snapshot.video = [];
  snapshot.layers = [];
  snapshot.audio = [];
  snapshot.text = plan.activeText.map((text) => ({ ...text, start: 0, dur: plan.frameDuration }));
  snapshot.music = null;
  snapshot.settings = { ...tl.settings, frameRate: TL.normalizeFrameRate(fps), width, height };
  snapshot.trackCount = Math.max(2, Number(tl.trackCount) || 2);
  let outputFrameCount = 1;
  let outputDuration = plan.frameDuration;
  let transitionBaseFrame = 0;
  snapshot.trackState = {};
  for (let i = 1; i <= snapshot.trackCount + plan.activeMain.length + 2; i++) snapshot.trackState[String(i)] = { visible: true, muted: false, locked: false };

  const extract = async (item, sourceTime, name) => {
    const image = item.type === 'image' || IMAGE_RE.test(item.src || '');
    const targetTime = image ? 0 : Math.max(0, Number(sourceTime) || 0);
    const key = `${item.src}\u0000${image ? 'image' : T(targetTime)}`;
    if (sourceFrames.has(key)) return sourceFrames.get(key).path;
    // PNG intermediates preserve source pixel values and any alpha channel on image assets.
    const output = path.join(tempDir, `${name}-${sourceFrames.size}.png`);
    const decoded = await extractSourceFrame(item.src, targetTime, output, image, signal, options.hardwareAcceleration ?? 'auto');
    sourceFrames.set(key, decoded); decodeModes.add(decoded.decodeMode);
    return decoded.path;
  };

  try {
    // The same FFmpeg compositing graph used for export handles all active
    // visuals. Main-track transition overlaps are placed in deterministic
    // z-order; alpha is evaluated at this exact output frame.
    const mainTracks = [];
    for (let i = 0; i < plan.activeMain.length; i++) {
      const active = plan.activeMain[i];
      const clip = active.clip;
      const localTime = Math.max(0, plan.time - active.start);
      const speed = Math.max(0.01, Number(clip.speed) || 1);
      const sourceTime = clip.type === 'image' ? 0 : Math.max(Number(clip.in) || 0, Math.min((Number(clip.out) || 0) - 1e-7, (Number(clip.in) || 0) + localTime * speed));
      const imagePath = await extract(clip, sourceTime, `main-${i}`);
      const originalTrack = Math.max(1, Number(clip.track) || 1);
      const renderTrack = tl.mode === 'free' ? originalTrack : 1;
      const transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alpha: 1, shearX: 0, shearY: 0, ...(clip.transform || {}) };
      for (const property of ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'alpha']) transform[property] = evaluated(clip, property, localTime, transform[property]);
      const duration = Math.max(plan.frameDuration, TL.clipDur(clip));
      if (tl.mode !== 'free') transform.alpha *= fadeAlpha(clip, localTime, duration);
      if (tl.mode !== 'free' && !useSequentialGraph && i > 0 && clip.trans) {
        const previous = plan.activeMain[i - 1];
        const overlap = Math.max(1e-9, Math.min(Number(clip.trans.dur) || 0, TL.clipDur(previous.clip), TL.clipDur(clip)));
        if (localTime < overlap) transform.alpha *= Math.max(0, Math.min(1, localTime / overlap));
      }
      const frameMask = clip.mask ? { ...clip.mask } : clip.mask;
      if (frameMask?.shape === 'bezier') {
        frameMask.nodes = BezierMask.evaluateNodes(frameMask, localTime);
        delete frameMask.pathKeyframes; // The preview source is a single sampled frame.
      }
      const entry = { ...clip, mask: frameMask, src: imagePath, type: 'image', in: 0, out: plan.frameDuration, start: 0, speed: 1, track: renderTrack, hasAudio: false, transform, keyframes: {}, fade: [0, 0], trans: null };
      snapshot.video.push(entry);
      mainTracks.push({ originalTrack, renderTrack });
      snapshot.trackCount = Math.max(snapshot.trackCount, renderTrack);
    }

    // Overlay tracks remain above main-track clips in sequential mode, while
    // free mode retains the user's explicit track ordering.
    let layerTrackOffset = 0;
    if (tl.mode !== 'free' && !useSequentialGraph && mainTracks.length) layerTrackOffset = Math.max(...mainTracks.map((x) => x.renderTrack)) - 1;
    for (let i = 0; i < plan.activeLayers.length; i++) {
      const layer = plan.activeLayers[i];
      const localTime = Math.max(0, plan.time - (Number(layer.start) || 0));
      const sourceTime = layer.type === 'image' ? 0 : Math.max(Number(layer.in) || 0, Math.min((Number(layer.out) || 0) - 1e-7, (Number(layer.in) || 0) + localTime));
      const imagePath = await extract(layer, sourceTime, `layer-${i}`);
      const renderTrack = Math.max(2, (Number(layer.track) || 2) + layerTrackOffset);
      const frameMask = layer.mask ? { ...layer.mask } : layer.mask;
      if (frameMask?.shape === 'bezier') {
        frameMask.nodes = BezierMask.evaluateNodes(frameMask, localTime);
        delete frameMask.pathKeyframes; // Snapshot preview renders exactly one pose.
      }
      const staticLayer = { ...layer, mask: frameMask, src: imagePath, type: 'image', in: 0, out: plan.frameDuration, start: 0, track: renderTrack,
        x: evaluated(layer, 'x', localTime, Number(layer.x ?? 0.8)),
        y: evaluated(layer, 'y', localTime, Number(layer.y ?? 0.2)),
        scale: evaluated(layer, 'scale', localTime, Number(layer.scale ?? 0.3)),
        opacity: evaluated(layer, 'opacity', localTime, Number(layer.opacity ?? 1)),
        rotation: evaluated(layer, 'rotation', localTime, Number(layer.rotation || 0)),
        keyframes: {}, hasAudio: false };
      snapshot.layers.push(staticLayer);
      snapshot.trackCount = Math.max(snapshot.trackCount, renderTrack);
    }
    if (hasSequentialTransition) {
      const previousItem = plan.activeMain[0], incomingItem = plan.activeMain[1];
      const previousClip = snapshot.video[0], incomingClip = snapshot.video[1];
      const overlap = Math.max(1e-9, Math.min(Number(incomingItem.clip.trans.dur) || 0, TL.clipDur(previousItem.clip), TL.clipDur(incomingItem.clip)));
      transitionBaseFrame = TL.secondsToFrame(incomingItem.start, fps, 'floor');
      const baseTime = TL.frameToSeconds(transitionBaseFrame, fps);
      const offset = Math.max(0, incomingItem.start - baseTime);
      outputDuration = offset + overlap;
      outputFrameCount = Math.max(1, frameIndex - transitionBaseFrame + 1);
      previousClip.out = outputDuration;
      previousClip.trans = null;
      incomingClip.out = overlap;
      incomingClip.trans = { type: incomingItem.clip.trans.type || 'fade', dur: overlap };
      // Both stills represent their content at the requested global frame. The
      // short sequence retains the original xfade type and global frame-grid phase.
      snapshot.text = plan.activeText.map((text) => ({ ...text, start: 0, dur: outputDuration }));
    } else if (useSequentialGraph) {
      outputFrameCount = 1;
      outputDuration = plan.frameDuration;
      snapshot.text = plan.activeText.map((text) => ({ ...text, start: 0, dur: outputDuration }));
    } else {
      snapshot.text = plan.activeText.map((text) => ({ ...text, start: 0, dur: plan.frameDuration }));
    }
    for (const layer of snapshot.layers) layer.out = outputDuration;
    for (const text of snapshot.text) { text.start = 0; text.dur = outputDuration; }

    // Preserve visibility for real overlay tracks. The snapshot uses synthetic
    // tracks only for sequential transition overlaps, so those are explicitly on.
    for (const { originalTrack, renderTrack } of mainTracks) {
      snapshot.trackState[String(renderTrack)] = { ...(tl.trackState?.[String(originalTrack)] || {}), visible: true };
    }
    for (const layer of plan.activeLayers) {
      const newTrack = Math.max(2, (Number(layer.track) || 2) + layerTrackOffset);
      snapshot.trackState[String(newTrack)] = { ...(tl.trackState?.[String(Number(layer.track) || 2)] || {}), visible: true };
    }
    TL.ensure(snapshot);

    const movie = path.join(tempDir, 'frame.mp4');
    const still = path.join(tempDir, 'frame.jpg');
    const graph = useSequentialGraph
      ? ff.buildExport(snapshot, movie, { width, height, fps, crf: 18, frameCount: outputFrameCount })
      : ff.buildFreeExport(snapshot, movie, { width, height, fps, crf: 18, frameCount: 1 });
    try { await ff.run(graph.args, { signal }); } finally { graph.cleanup?.(); }
    const previewFrameIndex = useSequentialGraph ? Math.max(0, outputFrameCount - 1) : 0;
    await ff.run(['-y', '-i', movie, '-vf', `select='eq(n,${previewFrameIndex})'`, '-fps_mode', 'passthrough', '-frames:v', '1', '-q:v', '2', still], { signal });
    const buffer = fs.readFileSync(still);
    cachePut(cacheKey, buffer);
    return { dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`, frame: frameIndex, time: plan.time, fps, width, height, cached: false, decodeAcceleration: [...decodeModes] };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = { createRenderPlan, renderPreviewFrame };
