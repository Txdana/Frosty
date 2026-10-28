// Frosty FFmpeg engine (Node side). Plans come from the timeline; FFmpeg does the work.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TL = require('./timeline');
const BezierMask = require('./bezier-mask');
const { prepareBezierMaskVideos, collectAnimatedBezierMasks, maskMatteFilters } = require('./bezier-mask-render');

function ffmpegPath() {
  // FFmpeg is an independently installed command-line dependency, not an
  // npm module bundled/relicensed with Frosty. Explicit overrides are useful
  // for development and for users with a non-standard installation path.
  const override = process.env.FROSTY_FFMPEG;
  if (override && override.trim()) {
    try {
      const explicit = override.trim();
      if (fs.existsSync(explicit) && fs.statSync(explicit).isFile()) return explicit;
    } catch { /* A stale override should not block PATH/WinGet discovery. */ }
  }

  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [];
  // Optional user-managed copy beside the app or inside its tools directory.
  // The release packager deliberately does not put an FFmpeg binary here.
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, executable));
    candidates.push(path.join(process.resourcesPath, 'tools', executable));
    candidates.push(path.join(process.resourcesPath, 'ffmpeg', executable));
  }
  candidates.push(path.join(path.dirname(process.execPath), executable));
  candidates.push(path.join(path.dirname(process.execPath), 'tools', executable));
  candidates.push(path.join(__dirname, '..', 'tools', executable));
  // WinGet's portable ZIP packages commonly expose commands from this user-level link directory.
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', executable));
  }
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch { /* check the next candidate */ }
  }

  // WinGet's portable ZIP package may be present before its link is visible to
  // the current process. Inspect only Gyan's package cache as a targeted fallback.
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const packageRoot = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    const findInDirectory = (directory, maxDepth = 5) => {
      if (maxDepth < 0) return null;
      let entries;
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return null; }
      for (const entry of entries) {
        const child = path.join(directory, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === executable.toLowerCase()) return child;
        if (entry.isDirectory()) {
          const found = findInDirectory(child, maxDepth - 1);
          if (found) return found;
        }
      }
      return null;
    };
    try {
      for (const packageName of fs.readdirSync(packageRoot)) {
        if (!packageName.toLowerCase().startsWith('gyan.ffmpeg_')) continue;
        const found = findInDirectory(path.join(packageRoot, packageName));
        if (found) return found;
      }
    } catch { /* WinGet may not be installed; continue to PATH. */ }
  }

  // Fall back to PATH. The OS resolves this command when spawn() is called.
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

function run(args, { onStderr, signal } = {}) {
  return new Promise((resolve, reject) => {
    const abortError = () => { const error = new Error('FFmpeg operation cancelled'); error.name = 'AbortError'; return error; };
    if (signal?.aborted) { reject(abortError()); return; }
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = '', settled = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const finish = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value); };
    const onAbort = () => { try { p.kill('SIGTERM'); } catch {} };
    signal?.addEventListener('abort', onAbort, { once: true });
    p.stderr.on('data', (d) => { const s = d.toString(); err += s; if (onStderr) onStderr(s); });
    p.on('error', (error) => finish(reject, signal?.aborted ? abortError() : error));
    p.on('close', (code) => {
      if (signal?.aborted) return finish(reject, abortError());
      if (code === 0) return finish(resolve, err);
      finish(reject, new Error(err.split('\n').slice(-30).join('\n')));
    });
    // Close the race where cancellation occurs just after the initial check.
    if (signal?.aborted) onAbort();
  });
}

// ffmpeg exits non-zero when no output is given, so probe through stderr of a null run.
async function probe(file) {
  let log = '';
  try { log = await run(['-hide_banner', '-i', file, '-f', 'null', '-t', '0.01', '-']); }
  catch (e) { log = e.message; }
  const d = /Duration: (\d+):(\d+):(\d+\.?\d*)/.exec(log);
  const duration = d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0;
  const res = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(log);
  if (/\.(png|jpe?g|webp|bmp|gif)$/i.test(file)) return { path: file, name: path.basename(file), type: 'image', duration: 5, hasVideo: true, hasAudio: false, width: res ? +res[1] : 0, height: res ? +res[2] : 0 };
  return {
    path: file,
    name: path.basename(file),
    duration,
    hasVideo: /Stream #.*Video:/.test(log),
    hasAudio: /Stream #.*Audio:/.test(log),
    width: res ? +res[1] : 0,
    height: res ? +res[2] : 0,
  };
}

async function detectSilence(file, { noiseDb = -30, minDur = 0.5 } = {}) {
  const log = await run(['-hide_banner', '-i', file, '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minDur}`, '-f', 'null', '-']);
  const ranges = [];
  let start = null;
  for (const line of log.split('\n')) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (s) start = Math.max(0, +s[1]);
    if (e && start !== null) { ranges.push([start, +e[1]]); start = null; }
  }
  return ranges;
}

async function extractAudioWav(file, out) {
  await run(['-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', out]);
  return out;
}

async function extractFrames(file, outDir, count = 6, duration = 0) {
  fs.mkdirSync(outDir, { recursive: true });
  const fps = duration > 0 ? (count / duration).toFixed(5) : '0.5';
  await run(['-y', '-i', file, '-vf', `fps=${fps},scale=480:-2`, '-frames:v', String(count), path.join(outDir, 'f%02d.jpg')]);
  return fs.readdirSync(outDir).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(outDir, f));
}

// ---- filtergraph helpers ----
// Text is burned in with libass (ASS subtitles): it works on any ffmpeg build with libass, gives
// outlines/fades, and uses system fonts, so Frosty never depends on the drawtext filter.
const fp = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
const T = (n) => Number.isFinite(Number(n)) ? String(Number(Number(n).toFixed(9))) : '0';
const fpsString = (fps, tl) => TL.frameRateString(fps == null ? tl : fps);
const fpsValue = (fps, tl) => TL.frameRateValue(fps == null ? tl : fps);
const frameCountFor = (duration, fps, tl) => Math.max(1, Math.ceil(Math.max(0, Number(duration) || 0) * fpsValue(fps, tl) - 1e-9));
const assTime = (t) => {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};
const assColor = (c) => { const h = String(c || '#ffffff').replace('#', '').padStart(6, '0'); return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`; };
const assEsc = (t) => String(t).replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');

// overlays: [{text,start,dur,size,color,pos,fade}]
function writeAss(overlays, W, H, file, font = 'Arial') {
  const lines = ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', '',
    '[V4+ Styles]', 'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    `Style: Default,${font},48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,0,2,${Math.round(W * 0.06)},${Math.round(W * 0.06)},${Math.round(H * 0.07)},1`,
    '', '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'];
  for (const o of overlays) {
    if (!o.text) continue;
    const an = o.pos === 'top' ? 8 : o.pos === 'center' ? 5 : 2;
    const size = Math.round((o.size || 48) * (H / 720));
    const fad = o.fade ? `\\fad(${o.fade[0]},${o.fade[1]})` : '';
    lines.push(`Dialogue: 0,${assTime(o.start)},${assTime(o.start + o.dur)},Default,,0,0,0,,{\\an${an}\\fs${size}\\c${assColor(o.color)}\\bord${Math.max(2, Math.round(size / 16))}${fad}}${assEsc(o.text)}`);
  }
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

let cachedEncoderListing;
function availableVideoEncoders() {
  if (cachedEncoderListing) return cachedEncoderListing;
  try {
    const r = spawnSync(ffmpegPath(), ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    const output = `${r.stdout || ''}\n${r.stderr || ''}`;
    cachedEncoderListing = new Set([...output.matchAll(/^\s*[VAS.][A-Z.]{5}\s+([a-z0-9_]+)\s+/gim)].map(m => m[1]));
  } catch { cachedEncoderListing = new Set(); }
  return cachedEncoderListing;
}
function softwareCodecFor(codec) { return /(?:hevc|265|h265)/i.test(String(codec || '')) ? 'libx265' : 'libx264'; }
function videoEncoderCandidates(opts = {}) {
  const mode = String(opts.gpuEncoding || 'off').toLowerCase();
  const requested = String(opts.videoCodec || 'libx264');
  const fallback = softwareCodecFor(requested);
  if (mode === 'off') return [...new Set([requested, fallback])];
  const prefix = /(?:hevc|265|h265)/i.test(requested) ? 'hevc' : 'h264';
  let hardware = [];
  if (mode === 'auto') hardware = process.platform === 'darwin'
    ? [`${prefix}_videotoolbox`, `${prefix}_nvenc`, `${prefix}_qsv`, `${prefix}_amf`]
    : [`${prefix}_nvenc`, `${prefix}_qsv`, `${prefix}_amf`, `${prefix}_videotoolbox`];
  else if (mode === 'nvidia') hardware = [`${prefix}_nvenc`];
  else if (mode === 'intel' || mode === 'qsv') hardware = [`${prefix}_qsv`];
  else if (mode === 'amd' || mode === 'amf') hardware = [`${prefix}_amf`];
  else if (mode === 'apple' || mode === 'videotoolbox') hardware = [`${prefix}_videotoolbox`];
  const available = availableVideoEncoders();
  return [...new Set([...hardware.filter(codec => available.has(codec)), requested, fallback])];
}
function videoEncoderArgs(codec, { crf = 20, videoBitrate = '', width = 1280, height = 720, fps = 30 } = {}) {
  const c = String(codec || 'libx264');
  const bitrate = videoBitrate ? ['-b:v', String(videoBitrate)] : null;
  if (/_nvenc$/i.test(c)) return ['-c:v', c, '-preset', 'p4', ...(bitrate || ['-cq', String(crf), '-b:v', '0']), '-pix_fmt', 'yuv420p'];
  if (/_qsv$/i.test(c)) return ['-c:v', c, '-preset', 'medium', ...(bitrate || ['-global_quality', String(crf)]), '-pix_fmt', 'yuv420p'];
  if (/_amf$/i.test(c)) return ['-c:v', c, '-quality', 'balanced', ...(bitrate || ['-qp_i', String(crf), '-qp_p', String(crf)]), '-pix_fmt', 'yuv420p'];
  if (/_videotoolbox$/i.test(c)) return ['-c:v', c, ...(bitrate || ['-b:v', `${Math.max(2, Math.min(60, Math.round(width * height * (Number(fps) || 30) / 160000)))}M`]), '-pix_fmt', 'yuv420p'];
  return ['-c:v', c, '-preset', 'veryfast', ...(bitrate || ['-crf', String(crf)]), '-pix_fmt', 'yuv420p'];
}

const PRESETS = {
  'YouTube 1080p': { width: 1920, height: 1080, fps: 30, crf: 20 },
  'YouTube 4K': { width: 3840, height: 2160, fps: 30, crf: 21 },
  'Web 720p': { width: 1280, height: 720, fps: 30, crf: 23 },
  'Vertical 9:16 (Reels/TikTok)': { width: 1080, height: 1920, fps: 30, crf: 21 },
  'Square 1:1': { width: 1080, height: 1080, fps: 30, crf: 21 },
  'YouTube 1080p High Quality': { width: 1920, height: 1080, fps: 30, crf: 18, videoBitrate: '12M', audioBitrate: '320k', videoCodec: 'libx264', audioCodec: 'aac' },
  'YouTube 1080p 60fps': { width: 1920, height: 1080, fps: 60, crf: 20, videoBitrate: '15M', audioBitrate: '256k', videoCodec: 'libx264', audioCodec: 'aac' },
  'Archive Master (High Quality)': { width: 1920, height: 1080, fps: 30, crf: 15, audioBitrate: '320k', videoCodec: 'libx264', audioCodec: 'aac' },
  'Small File 720p': { width: 1280, height: 720, fps: 30, crf: 28, videoBitrate: '2M', audioBitrate: '128k', videoCodec: 'libx264', audioCodec: 'aac' },
  'HEVC 4K': { width: 3840, height: 2160, fps: 30, crf: 24, videoCodec: 'libx265', audioCodec: 'aac', audioBitrate: '256k' },
};

// Per-clip colour/effect chain (Shotcut/Kdenlive-style filters, implemented on FFmpeg filters).
const EFFECT_DEFAULTS = Object.freeze({ brightness: 0, contrast: 1, saturation: 1, gamma: 1, blur: 0, sharpen: 0, grayscale: false, sepia: false, invert: false, vignette: false, flipH: false, flipV: false });
function safeNum(v, fallback, min, max) { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; }
function oneEffect(effect, owner, timeExpr = 't') {
  if (!effect || effect.enabled === false) return '';
  const type = String(effect.type || effect.name || '').toLowerCase();
  const p = effect.params || effect;
  const prop = (key, fallback, min, max) => {
    const points = effect.keyframes?.[key];
    if (Array.isArray(points) && points.length) {
      // Effects use the owning clip/layer's local timebase, not global timeline time.
      return keyframeExpr({ keyframes: effect.keyframes }, key, fallback, timeExpr);
    }
    return String(safeNum(p[key], fallback, min, max));
  };
  switch (type) {
    case 'brightness': return `eq=brightness='${prop('value', 0, -1, 1)}'`;
    case 'contrast': return `eq=contrast='${prop('value', 1, 0, 3)}'`;
    case 'saturation': return `eq=saturation='${prop('value', 1, 0, 3)}'`;
    case 'color': case 'colour': return `eq=brightness='${prop('brightness', 0, -1, 1)}':contrast='${prop('contrast', 1, 0, 3)}':saturation='${prop('saturation', 1, 0, 3)}'`;
    case 'gamma': return `eq=gamma='${prop('value', 1, 0.1, 10)}'`;
    case 'blur': return `gblur=sigma='${prop('amount', 2, 0, 50)}'`;
    case 'sharpen': return `unsharp=5:5:'${prop('amount', 0.5, 0, 5)}'`;
    case 'grayscale': return 'hue=s=0';
    case 'sepia': return 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131';
    case 'invert': return 'negate';
    case 'vignette': return 'vignette';
    case 'flip-h': case 'fliph': return 'hflip';
    case 'flip-v': case 'flipv': return 'vflip';
    case 'hue': return `hue=h='${prop('degrees', 0, -180, 180)}'`;
    default: return '';
  }
}
function effectStackChain(owner, trackState, timeExpr = 't', trackTimeExpr = timeExpr) {
  const stack = Array.isArray(owner?.effects) ? owner.effects : [];
  const legacy = owner?.fx && typeof owner.fx === 'object' ? Object.entries(owner.fx).filter(([k,v]) => v && k in EFFECT_DEFAULTS).map(([type,value]) => ({ type, ...(typeof value === 'boolean' ? {} : { params: ({ blur: { amount: value }, sharpen: { amount: value }, brightness: { value }, contrast: { value }, saturation: { value }, gamma: { value } })[type] || { value } }), enabled: true })) : [];
  const stateStack = Array.isArray(trackState?.effects) ? trackState.effects : [];
  const filters = [...legacy.map((e) => oneEffect(e, owner, timeExpr)), ...stack.map((e) => oneEffect(e, owner, timeExpr)), ...stateStack.map((e) => oneEffect(e, owner, trackTimeExpr))].filter(Boolean);
  return filters.length ? filters.join(',') + ',' : '';
}
function bezierCoordinateExpr(mask, nodeIndex, component, timeExpr) {
  const nodes = BezierMask.normalizeNodes(mask.nodes);
  const fallback = nodes[nodeIndex]?.[component.includes('.') ? component.split('.')[0] : component];
  const base = component.split('.').reduce((value, key) => value?.[key], nodes[nodeIndex]);
  const fallbackValue = Number.isFinite(Number(base)) ? Number(base) : 0.5;
  const pathKeys = BezierMask.normalizePathKeyframes({ ...mask, nodes });
  if (!pathKeys.length) return Number(fallbackValue).toFixed(6);
  const points = pathKeys.map((key) => ({ t: key.t, v: component.split('.').reduce((value, keyName) => value?.[keyName], key.nodes[nodeIndex]), interpolation: key.interpolation }));
  return keyframeExpr({ keyframes: { bezierCoordinate: points } }, 'bezierCoordinate', fallbackValue, timeExpr);
}

function bezierExpressionPoints(mask, timeExpr) {
  const nodes = BezierMask.normalizeNodes(mask.nodes);
  const pathKeys = BezierMask.normalizePathKeyframes({ ...mask, nodes });
  // For static paths, flatten in JS to keep the per-pixel FFmpeg expression small.
  if (pathKeys.length <= 1) {
    const staticNodes = pathKeys.length === 1 ? pathKeys[0].nodes : nodes;
    const steps = Math.max(3, Math.min(12, Math.floor(48 / staticNodes.length)));
    return BezierMask.sampleNodes(staticNodes, steps).map((p) => ({ x: p.x.toFixed(6), y: p.y.toFixed(6) }));
  }
  // Limit flattening to 32 vertices. A bounded expression is important because geq
  // evaluates the mask per pixel, and a 100+ vertex expression becomes unusably slow.
  const steps = Math.max(2, Math.min(6, Math.floor(32 / nodes.length)));
  const coord = (i, prop) => bezierCoordinateExpr(mask, i, prop, timeExpr);
  const cubic = (p0, p1, p2, p3, t) => {
    const u = Number(t.toFixed(6)), v = Number((1 - u).toFixed(6));
    return `((${v})*(${v})*(${v})*(${p0})+3*(${v})*(${v})*(${u})*(${p1})+3*(${v})*(${u})*(${u})*(${p2})+(${u})*(${u})*(${u})*(${p3}))`;
  };
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const j = (i + 1) % nodes.length;
    for (let sample = 0; sample < steps; sample++) {
      const u = sample / steps;
      out.push({
        x: cubic(coord(i, 'x'), coord(i, 'out.x'), coord(j, 'in.x'), coord(j, 'x'), u),
        y: cubic(coord(i, 'y'), coord(i, 'out.y'), coord(j, 'in.y'), coord(j, 'y'), u),
      });
    }
  }
  return out;
}

function getAnimatedBezierMatte(owner, kind, opts, addIn, inputMap) {
  const mask = owner?.mask;
  if (!mask || mask.enabled === false || mask.shape !== 'bezier') return null;
  const pathKeys = BezierMask.normalizePathKeyframes(mask);
  if (pathKeys.length < 2) return null;
  const key = `${kind}:${owner.id}`;
  const entry = opts.__bezierMaskFiles?.[key];
  if (!entry?.path) {
    throw new Error(`Animated Bézier mask on ${owner.name || owner.id || kind} needs a pre-rendered matte. Export through exportTimeline() so mask animation can be rendered safely.`);
  }
  if (!inputMap.has(key)) inputMap.set(key, addIn(['-i', entry.path]));
  return { key, index: inputMap.get(key), entry, filters: maskMatteFilters(mask) };
}

function maskChain(owner, timeExpr = 'T') {
  const m = owner?.mask;
  if (!m || m.enabled === false || !['rectangle', 'ellipse', 'path', 'bezier'].includes(m.shape || 'rectangle')) return '';
  const val = (key, fallback) => keyframeExpr({ keyframes: m.keyframes || {} }, key, fallback, timeExpr);
  const x = val('x', safeNum(m.x, 0, 0, 1)), y = val('y', safeNum(m.y, 0, 0, 1));
  const w = val('width', safeNum(m.width, 1, 0.001, 1)), h = val('height', safeNum(m.height, 1, 0.001, 1));
  const feather = safeNum(m.feather, 0, 0, 100);
  const inv = m.invert ? '1-' : '';
  let inside, signedDistance;
  if (m.shape === 'ellipse') {
    const q = `sqrt(pow((X/W-((${x})+(${w})/2))/max((${w})/2,0.0005),2)+pow((Y/H-((${y})+(${h})/2))/max((${h})/2,0.0005),2))`;
    inside = `lte(${q},1)`;
    if (feather > 0) signedDistance = `(1-(${q}))*min((${w})*W/2,(${h})*H/2)`;
  } else if (m.shape === 'bezier' || m.shape === 'path') {
    let points;
    if (m.shape === 'bezier') {
      try { points = bezierExpressionPoints(m, timeExpr); }
      catch { return ''; }
    } else {
      // Legacy polygon paths remain fully backward-compatible.
      points = (Array.isArray(m.points) ? m.points : []).map((p) => {
        const px = Array.isArray(p) ? Number(p[0]) : Number(p?.x);
        const py = Array.isArray(p) ? Number(p[1]) : Number(p?.y);
        return Number.isFinite(px) && Number.isFinite(py) ? { x: Math.max(0, Math.min(1, px)).toFixed(6), y: Math.max(0, Math.min(1, py)).toFixed(6) } : null;
      }).filter(Boolean).slice(0, 32);
      if (points.length < 3) return '';
    }
    if (points.length < 3) return '';
    const xx = '(X/W)', yy = '(Y/H)';
    const crossings = [];
    const distances = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const ax = a.x, ay = a.y, bx = b.x, by = b.y;
      crossings.push(`if(gt(abs(gt((${ay}),${yy})-gt((${by}),${yy})),0),lt(${xx},(${ax})+(${yy}-(${ay}))*(((${bx})-(${ax}))/(((${by})-(${ay}))+1e-9))),0)`);
      if (feather > 0) {
        const edx = `(((${bx})-(${ax}))*W)`, edy = `(((${by})-(${ay}))*H)`;
        const px = `(X-(${ax})*W)`, py = `(Y-(${ay})*H)`;
        const denom = `max(pow(${edx},2)+pow(${edy},2),0.000001)`;
        const projection = `clip(((${px})*(${edx})+(${py})*(${edy}))/${denom},0,1)`;
        distances.push(`sqrt(pow((${px})-(${edx})*(${projection}),2)+pow((${py})-(${edy})*(${projection}),2))`);
      }
    }
    const sum = crossings.length === 1 ? crossings[0] : crossings.reduce((a, b) => `(${a})+(${b})`);
    inside = `gt(mod(${sum},2),0)`;
    if (feather > 0 && distances.length) {
      const d = distances.reduce((a, b) => `min(${a},${b})`);
      signedDistance = `(if(${inside},1,-1))*(${d})`;
    }
  } else {
    inside = `if(between(X/W,(${x}),(${x})+(${w}))*between(Y/H,(${y}),(${y})+(${h})),1,0)`;
    if (feather > 0) {
      const d = `min(min(abs(X-(${x})*W),abs(X-((${x})+(${w}))*W)),min(abs(Y-(${y})*H),abs(Y-((${y})+(${h}))*H)))`;
      signedDistance = `(if(${inside},1,-1))*(${d})`;
    }
  }
  let maskAlpha = inside;
  if (feather > 0 && signedDistance) maskAlpha = `clip(0.5+(${signedDistance})/${feather.toFixed(3)},0,1)`;
  const geqExpr = (expr) => expr.replace(/,/g, '\\,');
  const alphaExpr = `alpha(X,Y)*(${inv}(${maskAlpha}))`;
  return `format=rgba,geq=r='${geqExpr('r(X,Y)')}':g='${geqExpr('g(X,Y)')}':b='${geqExpr('b(X,Y)')}':a='${geqExpr(alphaExpr)}'`;
}
function fxChain(c) { const effects = effectStackChain(c); const mask = maskChain(c); return [effects.replace(/,$/, ''), mask].filter(Boolean).join(',') + (effects || mask ? ',' : ''); }
function masterFxChain(tl) { return effectStackChain({ effects: tl?.masterEffects || tl?.settings?.masterEffects || [] }); }
const atempo = (s) => { const o = []; while (s > 2) { o.push('atempo=2'); s /= 2; } while (s < 0.5) { o.push('atempo=0.5'); s /= 0.5; } o.push(`atempo=${s.toFixed(4)}`); return o.join(','); };

function keyframeExpr(item, property, fallback, timeExpr = 't') {
  const points = (item && item.keyframes && item.keyframes[property] || []).slice().filter((p) => Number.isFinite(+p.t) && Number.isFinite(+p.v)).sort((a, b) => a.t - b.t);
  if (!points.length) return Number(fallback).toFixed(6);
  const num = (v) => Number(v).toFixed(6);
  let expr = num(points[points.length - 1].v);
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i], b = points[i + 1];
    let interp;
    if (a.interpolation === 'constant') interp = num(a.v);
    else {
      const u = `((${timeExpr})-${num(a.t)})/${Math.max(0.000001, b.t - a.t).toFixed(6)}`;
      const curve = a.interpolation === 'bezier' ? `(${u})*(${u})*(3-2*(${u}))` : u;
      interp = `${num(a.v)}+(${num(b.v)}-${num(a.v)})*(${curve})`;
    }
    expr = `if(lt(${timeExpr},${num(b.t)}),${interp},${expr})`;
  }
  return `if(lt(${timeExpr},${num(points[0].t)}),${num(points[0].v)},${expr})`;
}

function audioProductionChain(item, duration, localTime = 't') {
  const chain = [];
  const gain = Math.max(-36, Math.min(24, Number(item?.gainDb) || 0));
  if (Math.abs(gain) > 0.001) chain.push(`volume=${gain.toFixed(2)}dB`);
  const low = Math.max(-18, Math.min(18, Number(item?.lowShelfDb) || 0));
  const high = Math.max(-18, Math.min(18, Number(item?.highShelfDb) || 0));
  if (Math.abs(low) > 0.001) chain.push(`bass=g=${low.toFixed(2)}:f=120:w=0.5`);
  if (Math.abs(high) > 0.001) chain.push(`treble=g=${high.toFixed(2)}:f=6000:w=0.5`);
  const pan = Math.max(-1, Math.min(1, Number(item?.pan) || 0));
  if (Math.abs(pan) > 0.001) chain.push(`stereotools=balance_in=${pan.toFixed(3)}`);
  if (item?.compressor) chain.push('acompressor=threshold=0.125:ratio=3:attack=20:release=250:makeup=1');
  const fadeIn = Math.max(0, Math.min(Number(duration) || 0, Number(item?.fadeIn) || 0));
  const fadeOut = Math.max(0, Math.min(Number(duration) || 0, Number(item?.fadeOut) || 0));
  if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${T(fadeIn)}`);
  if (fadeOut > 0) chain.push(`afade=t=out:st=${T(Math.max(0, duration - fadeOut))}:d=${T(fadeOut)}`);
  return chain.length ? ',' + chain.join(',') : '';
}

function masterAudioChain(tl, opts = {}) {
  const cfg = { ...(tl?.audioMaster || {}), ...(opts.audioMaster || {}) };
  const chain = [];
  const gain = Math.max(-36, Math.min(18, Number(cfg.gainDb) || 0));
  if (Math.abs(gain) > 0.001) chain.push(`volume=${gain.toFixed(2)}dB`);
  if (cfg.compressor) chain.push('acompressor=threshold=0.125:ratio=2.5:attack=15:release=220:makeup=1');
  return chain.join(',');
}

function buildFreeExport(tl, outPath, opts = {}) {
  const { width = 1280, height = 720, fps: requestedFps = undefined, crf = 20, frameCount = undefined } = opts;
  const fps = requestedFps == null ? fpsString(null, tl) : fpsString(requestedFps, tl);
  const items = TL.layout(tl);
  if (!items.length && !(tl.layers || []).length && !(tl.text || []).length) throw new Error('Timeline is empty');
  const total = Math.max(0.1, ...items.map((i) => i.end), ...(tl.layers || []).map((l) => l.start + l.out - l.in), ...(tl.audio || []).map((a) => a.start + a.out - a.in), ...(tl.text || []).map((t) => t.start + t.dur));
  const outputFrames = Number.isFinite(Number(frameCount)) && Number(frameCount) > 0 ? Math.floor(Number(frameCount)) : frameCountFor(total, fps, tl);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-free-'));
  const inArgs = []; let nIn = 0;
  const addIn = (args) => { inArgs.push(...args); return nIn++; };
  const cache = new Map();
  const matteInputs = new Map();
  const getVid = (src) => { if (!cache.has(src)) cache.set(src, addIn(['-i', src])); return cache.get(src); };
  const imgIn = (src, dur) => addIn(['-loop', '1', '-framerate', String(fps), '-t', T(dur + 0.25), '-i', src]);
  const f = [`color=c=black:s=${width}x${height}:r=${fps}:d=${T(total)},format=yuv420p[base0]`];
  let vCur = '[base0]', serial = 0;
  const audioLabels = [];
  const visualItems = [
    ...items.map((item) => ({ kind: 'clip', track: Number(item.clip.track) || 1, start: item.start, end: item.end, item: item.clip })),
    ...(tl.layers || []).map((layer) => ({ kind: 'layer', track: Number(layer.track) || 2, start: +layer.start || 0, end: (+layer.start || 0) + Math.max(0.05, layer.out - layer.in), item: layer }))
  ].sort((a, b) => a.track - b.track || a.start - b.start);
  for (const visual of visualItems) {
    const obj = visual.item, trackKey = String(visual.track), state = (tl.trackState || {})[trackKey] || {};
    const visible = state.visible !== false, muted = !!state.muted;
    const start = visual.start, d = visual.end - visual.start;
    const k = obj.type === 'image' ? imgIn(obj.src, d) : getVid(obj.src);
    if (visible) {
      if (visual.kind === 'clip') {
        const c = obj, tr = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alpha: 1, shearX: 0, shearY: 0, ...(c.transform || {}) };
        const local = `(t-${T(start)})`;
        const zoom = Math.max(1, Number(c.zoom) || 1);
        const sx = `((${keyframeExpr(c, 'scaleX', tr.scaleX, local)})*${T(zoom)})`, sy = `((${keyframeExpr(c, 'scaleY', tr.scaleY, local)})*${T(zoom)})`;
        const rot = keyframeExpr(c, 'rotation', tr.rotation, local), alpha = keyframeExpr(c, 'alpha', tr.alpha, local);
        const x = keyframeExpr(c, 'x', tr.x, local), y = keyframeExpr(c, 'y', tr.y, local);
        const shear = Math.abs(+tr.shearX) > 0.001 || Math.abs(+tr.shearY) > 0.001
          ? `,shear=shx=${Math.max(-1.5, Math.min(1.5, +tr.shearX || 0))}:shy=${Math.max(-1.5, Math.min(1.5, +tr.shearY || 0))}` : '';
        const fade = Array.isArray(c.fade) ? c.fade : [0, 0];
        const fadeTerms = [];
        if (+fade[0] > 0) fadeTerms.push(`min(1,max(0,(${local})/${T(fade[0])}))`);
        if (+fade[1] > 0) fadeTerms.push(`min(1,max(0,(${T(c.out - c.in)}/${c.speed || 1}-${local})/${T(fade[1])}))`);
        const fadeExpr = fadeTerms.length ? `*${fadeTerms.join('*')}` : '';
        const label = `freev${serial}`;
        const transform = `scale=${width}:${height}:force_original_aspect_ratio=decrease,scale=w='max(2,iw*max(0.05,min(8,${sx})))':h='max(2,ih*max(0.05,min(8,${sy})))':eval=frame${shear},rotate=a='(${rot})*PI/180':ow=rotw(iw):oh=roth(ih):c=black,format=rgba,lut=a='val*max(0,min(1,(${alpha})${fadeExpr}))'`;
        const localMaskTime = `(T-${T(start)})`;
        const effects = effectStackChain(c, state, local, 't').replace(/,$/, '');
        const matte = getAnimatedBezierMatte(c, 'clip', opts, addIn, matteInputs);
        if (matte) {
          const pre = `${label}_pre`, matteLabel = `${label}_matte`, masked = `${label}_masked`;
          f.push(`[${k}:v]trim=start=${T(c.in)}:end=${T(c.out)},setpts=(PTS-STARTPTS)/${c.speed || 1}+${T(start)}/TB,${effects ? `${effects},` : ''}fps=${fps},format=rgba[${pre}]`);
          f.push(`[${matte.index}:v]trim=duration=${T(d)},setpts=PTS-STARTPTS+${T(start)}/TB,fps=${fps},${matte.filters}[${matteLabel}]`);
          f.push(`[${pre}][${matteLabel}]alphamerge[${masked}]`);
          f.push(`[${masked}]${transform}[${label}]`);
        } else {
          const mask = maskChain(c, localMaskTime);
          f.push(`[${k}:v]trim=start=${T(c.in)}:end=${T(c.out)},setpts=(PTS-STARTPTS)/${c.speed || 1}+${T(start)}/TB,${[effects, mask].filter(Boolean).join(',')}${effects || mask ? ',' : ''}${transform}[${label}]`);
        }
        const next = `base${serial + 1}`;
        f.push(`${vCur}[${label}]overlay=x='(W-w)/2+(${x})*W':y='(H-h)/2+(${y})*H':enable='between(t,${T(start)},${T(visual.end)})':eof_action=pass:shortest=0:format=auto[${next}]`);
        vCur = `[${next}]`; serial++;
      } else {
        const l = obj, local = `(t-${T(start)})`, scale = keyframeExpr(l, 'scale', l.scale || 0.3, local), x = keyframeExpr(l, 'x', l.x ?? 0.8, local), y = keyframeExpr(l, 'y', l.y ?? 0.2, local), op = keyframeExpr(l, 'opacity', l.opacity ?? 1, local), rot = keyframeExpr(l, 'rotation', l.rotation || 0, local);
        const chroma = l.chroma ? `,chromakey=color=${String(l.chroma.color || '#00ff00').replace('#', '0x')}:similarity=${l.chroma.sim || 0.12}:blend=0.05` : '';
        const label = `freel${serial}`, next = `base${serial + 1}`;
        const trackState = (tl.trackState || {})[String(Number(l.track) || 2)];
        const localMaskTime = `(T-${T(start)})`;
        const effects = effectStackChain(l, trackState, local, 't').replace(/,$/, '');
        const matte = getAnimatedBezierMatte(l, 'layer', opts, addIn, matteInputs);
        if (matte) {
          const pre = `${label}_pre`, matteLabel = `${label}_matte`, masked = `${label}_masked`;
          f.push(`[${k}:v]trim=start=${T(l.in)}:end=${T(l.out)},setpts=PTS-STARTPTS+${T(start)}/TB,${effects ? `${effects},` : ''}fps=${fps},format=rgba[${pre}]`);
          f.push(`[${matte.index}:v]trim=duration=${T(d)},setpts=PTS-STARTPTS+${T(start)}/TB,fps=${fps},${matte.filters}[${matteLabel}]`);
          f.push(`[${pre}][${matteLabel}]alphamerge[${masked}]`);
          f.push(`[${masked}]scale=w='max(2,2*trunc(${width}*(${scale})/2))':h=-2:eval=frame,rotate=a='(${rot})*PI/180':ow=rotw(iw):oh=roth(ih):c=black,format=rgba${chroma},lut=a='val*max(0,min(1,${op}))'[${label}]`);
        } else {
          const mask = maskChain(l, localMaskTime);
          f.push(`[${k}:v]trim=start=${T(l.in)}:end=${T(l.out)},setpts=PTS-STARTPTS+${T(start)}/TB,${[effects, mask].filter(Boolean).join(',')}${effects || mask ? ',' : ''}scale=w='max(2,2*trunc(${width}*(${scale})/2))':h=-2:eval=frame,rotate=a='(${rot})*PI/180':ow=rotw(iw):oh=roth(ih):c=black,format=rgba${chroma},lut=a='val*max(0,min(1,${op}))'[${label}]`);
        }
        f.push(`${vCur}[${label}]overlay=x='W*(${x})-w/2':y='H*(${y})-h/2':enable='between(t,${T(start)},${T(visual.end)})':eof_action=pass:shortest=0:format=auto[${next}]`);
        vCur = `[${next}]`; serial++;
      }
    }
    if (obj.type !== 'image' && obj.hasAudio && !muted) {
      const af = `freea${serial}`, ms = Math.round(start * 1000), speed = visual.kind === 'clip' ? (obj.speed || 1) : 1;
      f.push(`[${k}:a]atrim=start=${T(obj.in)}:end=${T(obj.out)},asetpts=PTS-STARTPTS${speed !== 1 ? ',' + atempo(speed) : ''},aresample=44100,aformat=channel_layouts=stereo,volume='${keyframeExpr(obj, 'volume', obj.volume ?? 1)}':eval=frame${audioProductionChain(obj, (obj.out - obj.in) / speed)},adelay=${ms}|${ms}[${af}]`);
      audioLabels.push(`[${af}]`);
    }
  }
  let vLabel = vCur;
  if (tl.text && tl.text.length) { const ass = writeAss(tl.text, width, height, path.join(tmpDir, 'text.ass')); f.push(`${vLabel}ass='${fp(ass)}'[freeText]`); vLabel = '[freeText]'; }
  const masterEffects = masterFxChain(tl); if (masterEffects) { f.push(`${vLabel}${masterEffects.replace(/,$/, '')}[masterFx]`); vLabel = '[masterFx]'; }
  (tl.audio || []).forEach((a, i) => { const k = getVid(a.src), label = `freeAudio${i}`, ms = Math.round(a.start * 1000); f.push(`[${k}:a]atrim=start=${T(a.in)}:end=${T(a.out)},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume='${keyframeExpr(a, 'volume', a.volume ?? 1)}':eval=frame${audioProductionChain(a, a.out - a.in)},adelay=${ms}|${ms}[${label}]`); audioLabels.push(`[${label}]`); });
  // A silence bed gives the final mix a stable duration even when the timeline has no audio.
  f.push(`anullsrc=r=44100:cl=stereo,atrim=duration=${T(total)},asetpts=PTS-STARTPTS[freeSilence]`);
  let aLabel = '[freeSilence]';
  if (tl.music && tl.music.src) { const mi = addIn(['-stream_loop', '-1', '-i', tl.music.src]); f.push(`[${mi}:a]atrim=duration=${T(total)},aresample=44100,aformat=channel_layouts=stereo,volume=${Math.max(0, Math.min(2, +tl.music.volume || 0.25))}${audioProductionChain(tl.music, total)}[freeMusic]`); audioLabels.push('[freeMusic]'); }
  if (audioLabels.length) { const inputs = [aLabel, ...audioLabels].join(''); f.push(`${inputs}amix=inputs=${1 + audioLabels.length}:duration=first:dropout_transition=0:normalize=0[freeMix]`); aLabel = '[freeMix]'; }
  const masterAudio = masterAudioChain(tl, opts); if (masterAudio) { f.push(`${aLabel}${masterAudio}[freeMasterAudio]`); aLabel = '[freeMasterAudio]'; }
  const videoCodec = opts.videoCodec || 'libx264', audioCodec = opts.audioCodec || 'aac', audioBitrate = opts.audioBitrate || '192k', videoBitrate = opts.videoBitrate;
  const args = ['-y', ...inArgs, '-filter_complex', f.join(';'), '-map', vLabel, '-map', aLabel, ...videoEncoderArgs(videoCodec, { crf, videoBitrate, width, height, fps }), '-c:a', audioCodec, '-b:a', String(audioBitrate), ...(opts.normalizeAudio ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : (opts.audioLimiter ? ['-af', 'alimiter=limit=0.95:level=false'] : [])), '-movflags', '+faststart', '-t', T(total), '-frames:v', String(outputFrames), outPath];
  return { args, total, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

function buildExport(tl, outPath, opts = {}) {
  const { width = 1280, height = 720, crf = 20, frameCount = undefined, videoCodec = 'libx264', audioCodec = 'aac', audioBitrate = '192k', videoBitrate = '' } = opts;
  const fps = fpsString(opts.fps, tl);
  if (tl.mode === 'free') return buildFreeExport(tl, outPath, { ...opts, width, height, fps, crf, frameCount });
  if (!tl.video.length) throw new Error('Timeline is empty');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-'));
  const inArgs = []; let nIn = 0;
  const addIn = (a) => { inArgs.push(...a); return nIn++; };
  const vidIdx = new Map();
  const matteInputs = new Map();
  const getVid = (src) => { if (!vidIdx.has(src)) vidIdx.set(src, addIn(['-i', src])); return vidIdx.get(src); };
  const imgIn = (src, d) => addIn(['-loop', '1', '-framerate', String(fps), '-t', T(d + 0.5), '-i', src]);
  const f = [];
  const durs = tl.video.map((c) => (c.out - c.in) / (c.speed || 1));
  const clipStarts = [];
  let timelineCursor = 0;
  for (let i = 0; i < tl.video.length; i++) {
    if (i === 0) clipStarts.push(0);
    else {
      const trans = tl.video[i].trans;
      const overlap = trans ? Math.min(trans.dur, timelineCursor, durs[i]) : 0;
      clipStarts.push(Math.max(0, timelineCursor - overlap));
      timelineCursor += durs[i] - overlap;
    }
    if (i === 0) timelineCursor = durs[0];
  }
  tl.video.forEach((c, i) => {
    const img = c.type === 'image', k = img ? imgIn(c.src, durs[i]) : getVid(c.src);
    const d = durs[i], sp = c.speed || 1, z = Math.max(1, c.zoom || 1);
    const zoom = z > 1 ? `crop=iw/${z}:ih/${z},` : '';
    const tr = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alpha: 1, shearX: 0, shearY: 0, ...(c.transform || {}) };
    const tx = [];
    const sxExpr = keyframeExpr(c, 'scaleX', tr.scaleX), syExpr = keyframeExpr(c, 'scaleY', tr.scaleY), rotExpr = keyframeExpr(c, 'rotation', tr.rotation);
    if (Math.abs(+tr.scaleX - 1) > 0.001 || Math.abs(+tr.scaleY - 1) > 0.001 || c.keyframes?.scaleX?.length || c.keyframes?.scaleY?.length) tx.push(`scale=w='iw*max(0.05,min(8,${sxExpr}))':h='ih*max(0.05,min(8,${syExpr}))':eval=frame`);
    if (Math.abs(+tr.shearX) > 0.001 || Math.abs(+tr.shearY) > 0.001) tx.push(`shear=shx=${Math.max(-1.5, Math.min(1.5, +tr.shearX || 0))}:shy=${Math.max(-1.5, Math.min(1.5, +tr.shearY || 0))}`);
    if (Math.abs(+tr.rotation) > 0.001 || c.keyframes?.rotation?.length) tx.push(`rotate=a='(${rotExpr})*PI/180':ow=rotw(iw):oh=roth(ih):c=black`);
    const alphaExpr = keyframeExpr(c, 'alpha', tr.alpha);
    const alphaChain = `format=rgba,lut=a='val*max(0,min(1,${alphaExpr}))'`;
    const transformChain = tx.length ? tx.join(',') + ',' : '';
    const [fi, fo] = c.fade || [0, 0];
    const vfade = (fi > 0 ? `fade=t=in:st=0:d=${T(fi)},` : '') + (fo > 0 ? `fade=t=out:st=${T(Math.max(0, d - fo))}:d=${T(fo)},` : '');
    const pxExpr = keyframeExpr(c, 'x', tr.x), pyExpr = keyframeExpr(c, 'y', tr.y);
    // pad expressions do not expose the timestamp variable on all FFmpeg builds.
    // Composite each transformed clip over a full-canvas background with overlay,
    // whose x/y expressions support timestamps and therefore exact animated motion.
    const trackState = (tl.trackState || {})[String(Number(c.track) || 1)];
    const trackTime = `(t+${T(clipStarts[i])})`;
    const effects = effectStackChain(c, trackState, 't', trackTime).replace(/,$/, '');
    const matte = getAnimatedBezierMatte(c, 'clip', opts, addIn, matteInputs);
    if (matte) {
      const pre = `clipPre${i}`, matteLabel = `clipMatte${i}`, masked = `clipMasked${i}`;
      f.push(`[${k}:v]trim=start=${T(c.in)}:end=${T(c.out)},setpts=(PTS-STARTPTS)/${sp},${zoom}${transformChain}${effects ? `${effects},` : ''}fps=${fps},format=rgba[${pre}]`);
      f.push(`[${matte.index}:v]trim=duration=${T(d)},setpts=PTS-STARTPTS,fps=${fps},${zoom}${transformChain}${matte.filters}[${matteLabel}]`);
      f.push(`[${pre}][${matteLabel}]alphamerge[${masked}]`);
      f.push(`[${masked}]scale=${width}:${height}:force_original_aspect_ratio=decrease,setsar=1,${vfade}${alphaChain}[clip${i}]`);
    } else {
      const mask = maskChain(c);
      f.push(`[${k}:v]trim=start=${T(c.in)}:end=${T(c.out)},setpts=(PTS-STARTPTS)/${sp},${zoom}${transformChain}${[effects, mask].filter(Boolean).join(',')}${effects || mask ? ',' : ''}` +
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,setsar=1,fps=${fps},${vfade}${alphaChain}[clip${i}]`);
    }
    f.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${T(d)},format=rgba[bg${i}]`);
    f.push(`[bg${i}][clip${i}]overlay=x='(W-w)/2+(${pxExpr})*W':y='(H-h)/2+(${pyExpr})*H':eval=frame:shortest=1:format=auto,setsar=1,format=yuv420p[v${i}]`);
    const afade = (fi > 0 ? `,afade=t=in:st=0:d=${T(fi)}` : '') + (fo > 0 ? `,afade=t=out:st=${T(Math.max(0, d - fo))}:d=${T(fo)}` : '');
    if (c.hasAudio && !img) {
      f.push(`[${k}:a]atrim=start=${T(c.in)}:end=${T(c.out)},asetpts=PTS-STARTPTS${sp !== 1 ? ',' + atempo(sp) : ''},aresample=44100,` +
        `aformat=channel_layouts=stereo,volume='${(tl.trackState && tl.trackState['1'] && tl.trackState['1'].muted) ? '0' : keyframeExpr(c, 'volume', c.volume ?? 1)}':eval=frame${afade}${audioProductionChain(c, d / sp)}[a${i}]`);
    } else f.push(`anullsrc=r=44100:cl=stereo,atrim=0:${T(d)},asetpts=PTS-STARTPTS[a${i}]`);
  });
  let vCur = '[v0]', aCur = '[a0]', L = durs[0];
  for (let i = 1; i < tl.video.length; i++) {
    const tr = tl.video[i].trans, ov = tr ? Math.min(tr.dur, L, durs[i]) : 0;
    if (ov > 0.05) {
      f.push(`${vCur}[v${i}]xfade=transition=${tr.type}:duration=${T(ov)}:offset=${T(L - ov)}[vx${i}]`, `${aCur}[a${i}]acrossfade=d=${T(ov)}[ax${i}]`);
    } else f.push(`${vCur}[v${i}]concat=n=2:v=1:a=0[vx${i}]`, `${aCur}[a${i}]concat=n=2:v=0:a=1[ax${i}]`);
    vCur = `[vx${i}]`; aCur = `[ax${i}]`; L += durs[i] - ov;
  }
  const total = L;
  const outputFrames = Number.isFinite(Number(frameCount)) && Number(frameCount) > 0 ? Math.floor(Number(frameCount)) : frameCountFor(total, fps, tl);
  // Overlay layers: picture-in-picture, images, logos, green-screen (chromakey), opacity.
  const extraA = [];
  if (tl.trackState && tl.trackState['1'] && tl.trackState['1'].visible === false) { f.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${T(total)}[hiddenmain]`); vCur = '[hiddenmain]'; }
  [...(tl.layers || [])].filter((l) => !(tl.trackState && tl.trackState[String(Number(l.track) || 2)] && tl.trackState[String(Number(l.track) || 2)].visible === false)).sort((a, b) => (Number(a.track) || 2) - (Number(b.track) || 2)).forEach((l, j) => {
    const d = Math.max(0.05, l.out - l.in), img = l.type === 'image', k = img ? imgIn(l.src, d) : getVid(l.src);
    const localT = `(t-${T(l.start)})`;
    const sx = keyframeExpr(l, 'scale', l.scale || 0.3, localT);
    const xExpr = keyframeExpr(l, 'x', l.x ?? 0.8, localT);
    const yExpr = keyframeExpr(l, 'y', l.y ?? 0.2, localT);
    const opExpr = keyframeExpr(l, 'opacity', l.opacity ?? 1, localT);
    const rotExpr = keyframeExpr(l, 'rotation', l.rotation || 0, localT);
    const chroma = l.chroma ? `,chromakey=color=${String(l.chroma.color || '#00ff00').replace('#', '0x')}:similarity=${l.chroma.sim || 0.12}:blend=0.05` : '';
    const rotate = (Math.abs(+l.rotation || 0) > 0.001 || l.keyframes?.rotation?.length) ? `,rotate=a='(${rotExpr})*PI/180':ow=rotw(iw):oh=roth(ih):c=black` : '';
    const matte = getAnimatedBezierMatte(l, 'layer', opts, addIn, matteInputs);
    if (matte) {
      const pre = `lvPre${j}`, matteLabel = `lvMatte${j}`, masked = `lvMasked${j}`;
      f.push(`[${k}:v]trim=start=${T(l.in)}:end=${T(l.out)},setpts=PTS-STARTPTS+${T(l.start)}/TB,fps=${fps},format=rgba[${pre}]`);
      f.push(`[${matte.index}:v]trim=duration=${T(d)},setpts=PTS-STARTPTS+${T(l.start)}/TB,fps=${fps},${matte.filters}[${matteLabel}]`);
      f.push(`[${pre}][${matteLabel}]alphamerge[${masked}]`);
      f.push(`[${masked}]scale=w='max(2,2*trunc(${width}*(${sx})/2))':h=-2:eval=frame${rotate},format=rgba${chroma},lut=a='val*(${opExpr})'[lv${j}]`);
    } else {
      f.push(`[${k}:v]trim=start=${T(l.in)}:end=${T(l.out)},setpts=PTS-STARTPTS+${T(l.start)}/TB,scale=w='max(2,2*trunc(${width}*(${sx})/2))':h=-2:eval=frame${rotate},format=rgba${chroma},lut=a='val*(${opExpr})'[lv${j}]`);
    }
    f.push(`${vCur}[lv${j}]overlay=x='W*(${xExpr})-w/2':y='H*(${yExpr})-h/2':enable='between(t,${T(l.start)},${T(l.start + d)})':eof_action=pass,format=yuv420p[vo${j}]`);
    vCur = `[vo${j}]`;
    if (!img && l.hasAudio && !(tl.trackState && tl.trackState[String(Number(l.track) || 2)] && tl.trackState[String(Number(l.track) || 2)].muted)) { const ms = Math.round(l.start * 1000); f.push(`[${k}:a]atrim=start=${T(l.in)}:end=${T(l.out)},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume='${keyframeExpr(l, 'volume', l.volume ?? 1)}':eval=frame${audioProductionChain(l, l.out - l.in)},adelay=${ms}|${ms}[la${j}]`); extraA.push(`[la${j}]`); }
  });
  let vLabel = vCur;
  if (tl.text.length) {
    const assFile = writeAss(tl.text, width, height, path.join(tmpDir, 'text.ass'));
    f.push(`${vLabel}ass='${fp(assFile)}'[vt]`);
    vLabel = '[vt]';
  }
  const masterEffects = masterFxChain(tl); if (masterEffects) { f.push(`${vLabel}${masterEffects.replace(/,$/, '')}[masterFx]`); vLabel = '[masterFx]'; }
  // Extra audio tracks (voice-over, SFX, music clips) placed on the timeline.
  (tl.audio || []).forEach((a, j) => {
    const k = addIn(['-i', a.src]), ms = Math.round(a.start * 1000);
    f.push(`[${k}:a]atrim=start=${T(a.in)}:end=${T(a.out)},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume='${keyframeExpr(a, 'volume', a.volume ?? 1)}':eval=frame${audioProductionChain(a, a.out - a.in)},adelay=${ms}|${ms}[ca${j}]`);
    extraA.push(`[ca${j}]`);
  });
  let aLabel = aCur;
  if (tl.music && tl.music.src) {
    const mi = addIn(['-stream_loop', '-1', '-i', tl.music.src]);
    f.push(`[${mi}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${tl.music.volume ?? 0.25}${audioProductionChain(tl.music, total)}[m]`);
    if (tl.music.duck) {
      f.push(`${aCur}asplit=2[amain][asc]`, `[m][asc]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[md]`, `[amain][md]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[am]`);
    } else f.push(`${aCur}[m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[am]`);
    aLabel = '[am]';
  }
  if (extraA.length) { f.push(`${aLabel}${extraA.join('')}amix=inputs=${1 + extraA.length}:duration=first:dropout_transition=0:normalize=0[aall]`); aLabel = '[aall]'; }
  const masterAudio = masterAudioChain(tl, opts); if (masterAudio) { f.push(`${aLabel}${masterAudio}[masterAudio]`); aLabel = '[masterAudio]'; }
  const args = ['-y', ...inArgs, '-filter_complex', f.join(';'), '-map', vLabel, '-map', aLabel,
    ...videoEncoderArgs(videoCodec, { crf, videoBitrate, width, height, fps }), '-c:a', audioCodec, '-b:a', String(audioBitrate), ...(opts.normalizeAudio ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : (opts.audioLimiter ? ['-af', 'alimiter=limit=0.95:level=false'] : [])),
    '-movflags', '+faststart', '-t', T(total), '-frames:v', String(outputFrames), outPath];
  return { args, total, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

// Thumbnail + waveform images for the media bin and timeline.
async function thumb(file, out, t = 0.5) {
  await run(['-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=240:-2', out]);
  return out;
}
async function waveform(file, out, w = 1200, h = 60) {
  await run(['-y', '-i', file, '-filter_complex', `aformat=channel_layouts=mono,showwavespic=s=${w}x${h}:colors=0xcfe8ff`, '-frames:v', '1', out]);
  return out;
}
// Pipe JPEG frames into FFmpeg (used by the HTML scene renderer).
function openFramePipe(outPath, { fps = 30 } = {}) {
  const p = spawn(ffmpegPath(), ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-vf', 'format=yuv420p', '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', outPath], { windowsHide: true });
  let err = ''; p.stderr.on('data', (d) => (err += d));
  const done = new Promise((res, rej) => { p.on('error', rej); p.on('close', (c) => (c === 0 ? res(outPath) : rej(new Error(err.split('\n').slice(-6).join('\n'))))); });
  return { write: (buf) => new Promise((r) => p.stdin.write(buf, r)), end: () => { p.stdin.end(); return done; } };
}

// Scene-cut detection (Kdenlive/Shotcut "split at scenes"): returns SOURCE times.
async function detectSceneEvents(file, threshold = 0.3) {
  const cutThreshold = Math.max(0.05, Math.min(0.95, Number(threshold) || 0.3));
  const log = await run(['-hide_banner', '-i', file, '-an', '-vf', `select='gt(scene,${cutThreshold})',metadata=print:key=lavfi.scene_score,showinfo`, '-f', 'null', '-']);
  // FFmpeg's select filter attaches lavfi.scene_score to each selected frame.
  // showinfo provides its timestamp. Both filters see the same selected frames.
  const times = [...log.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  const scores = [...log.matchAll(/lavfi\.scene_score=([\d.]+)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  return times.map((time, i) => ({ time, score: scores[i] ?? null, threshold: cutThreshold,
    confidence: Number.isFinite(scores[i]) ? (scores[i] >= 0.65 ? 'high' : scores[i] >= 0.4 ? 'medium' : 'low') : 'low' }))
    .filter((event) => event.time >= 0);
}
async function detectScenes(file, threshold = 0.3) {
  // Preserve the established timestamp-only API for existing callers.
  return (await detectSceneEvents(file, threshold)).map((event) => event.time);
}

// Small low-fps proxy (for sending video straight to vision models over OpenRouter).
async function proxyVideo(file, out, { start = 0, maxSec = 40 } = {}) {
  await run(['-y', '-ss', String(start), '-t', String(maxSec), '-i', file, '-vf', 'fps=2,scale=480:-2', '-c:v', 'libx264', '-crf', '32', '-preset', 'veryfast', '-an', out]);
  return out;
}

async function exportTimeline(tl, outPath, opts = {}, onProgress) {
  const choices = videoEncoderCandidates(opts);
  let lastError = null;
  let maskWorkspace = null;
  let exportOpts = opts;
  try {
    const animatedMasks = collectAnimatedBezierMasks(tl);
    if (animatedMasks.length) {
      maskWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-bezier-mattes-'));
      const fps = fpsString(opts.fps, tl);
      const maskFiles = await prepareBezierMaskVideos(tl, { ...opts, fpsValue: fps }, maskWorkspace, { run, probe });
      exportOpts = { ...opts, __bezierMaskFiles: maskFiles };
    }
    for (let i = 0; i < choices.length; i++) {
      const codec = choices[i]; let plan;
      try {
        plan = buildExport(tl, outPath, { ...exportOpts, videoCodec: codec });
        await run(plan.args, { onStderr: (s) => {
          const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(s);
          if (m && onProgress) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / plan.total));
        } });
        if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 512) throw new Error(`FFmpeg ${codec} completed without producing a valid output file.`);
        opts.encoderUsed = codec;
        return outPath;
      } catch (error) {
        lastError = error; try { fs.unlinkSync(outPath); } catch {}
        if (i === choices.length - 1) throw new Error(`Video export failed with ${choices.join(', ')}. Last error: ${error.message}`);
      } finally { plan?.cleanup?.(); }
    }
    throw lastError || new Error('Video export failed: no compatible video encoder was available.');
  } finally {
    if (maskWorkspace) fs.rmSync(maskWorkspace, { recursive: true, force: true });
  }
}

// ---- "Brag" launch video: animated title cards with fade-in + slow push, inspired by /brag ----
async function renderBrag(scenes, outPath, { width = 1280, height = 720, fps = 30, sceneSec = 3 } = {}) {
  if (!scenes.length) throw new Error('No scenes');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-brag-'));
  const f = [], inputs = [], labels = [], overlays = [];
  scenes.forEach((s, i) => {
    const bg = (s.bg || '#101a2b').replace('#', '0x');
    inputs.push('-f', 'lavfi', '-i', `color=c=${bg}:s=${width}x${height}:r=${fps}:d=${sceneSec}`);
    const t0 = i * sceneSec;
    if (s.title) overlays.push({ text: s.title, start: t0, dur: sceneSec, size: 84, color: '#ffffff', pos: 'center', fade: [500, 400] });
    if (s.subtitle) overlays.push({ text: s.subtitle, start: t0 + 0.25, dur: sceneSec - 0.25, size: 40, color: '#9fd3ff', pos: 'bottom', fade: [500, 400] });
    f.push(`[${i}:v]format=yuv420p[s${i}]`);
    labels.push(`[s${i}]`);
  });
  f.push(`${labels.join('')}concat=n=${scenes.length}:v=1:a=0[vc]`);
  const assFile = writeAss(overlays, width, height, path.join(tmpDir, 'brag.ass'));
  f.push(`[vc]ass='${fp(assFile)}',format=yuv420p[v]`);
  try { await run(['-y', ...inputs, '-filter_complex', f.join(';'), '-map', '[v]', '-r', String(fps), '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outPath]); return outPath; }
  finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
}

module.exports = { thumb, waveform, openFramePipe, PRESETS, ffmpegPath, run, probe, detectScenes, proxyVideo, detectSilence, detectSceneEvents, extractAudioWav, extractFrames, buildExport, buildFreeExport, exportTimeline, renderBrag, audioProductionChain, masterAudioChain, availableVideoEncoders, videoEncoderCandidates, videoEncoderArgs };
