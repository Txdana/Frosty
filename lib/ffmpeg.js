// Frosty FFmpeg engine (Node side). Plans come from the timeline; FFmpeg does the work.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function ffmpegPath() {
  if (process.env.FROSTY_FFMPEG) return process.env.FROSTY_FFMPEG;
  let p = require('ffmpeg-static');
  return p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
}

function run(args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { const s = d.toString(); err += s; if (onStderr) onStderr(s); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(err.split('\n').slice(-30).join('\n')))));
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
const T = (n) => (+n).toFixed(3);
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

const PRESETS = {
  'YouTube 1080p': { width: 1920, height: 1080, fps: 30, crf: 20 },
  'YouTube 4K': { width: 3840, height: 2160, fps: 30, crf: 21 },
  'Web 720p': { width: 1280, height: 720, fps: 30, crf: 23 },
  'Vertical 9:16 (Reels/TikTok)': { width: 1080, height: 1920, fps: 30, crf: 21 },
  'Square 1:1': { width: 1080, height: 1080, fps: 30, crf: 21 },
};

// Per-clip colour/effect chain (Shotcut/Kdenlive-style filters, implemented on FFmpeg filters).
function fxChain(c) {
  const x = c.fx || {}, f = [], eq = [];
  if (x.flipH) f.push('hflip');
  if (x.flipV) f.push('vflip');
  if (+x.brightness) eq.push(`brightness=${+x.brightness}`);
  if (x.contrast != null && +x.contrast !== 1) eq.push(`contrast=${+x.contrast}`);
  if (x.saturation != null && +x.saturation !== 1) eq.push(`saturation=${+x.saturation}`);
  if (x.gamma != null && +x.gamma !== 1) eq.push(`gamma=${+x.gamma}`);
  if (eq.length) f.push('eq=' + eq.join(':'));
  if (+x.blur > 0) f.push(`gblur=sigma=${+x.blur}`);
  if (+x.sharpen > 0) f.push(`unsharp=5:5:${+x.sharpen}`);
  if (x.grayscale) f.push('hue=s=0');
  if (x.sepia) f.push('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131');
  if (x.invert) f.push('negate');
  if (x.vignette) f.push('vignette');
  return f.length ? f.join(',') + ',' : '';
}
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

function buildFreeExport(tl, outPath, { width = 1280, height = 720, fps = 30, crf = 20 } = {}) {
  const items = require('./timeline').layout(tl);
  if (!items.length) throw new Error('Timeline is empty');
  const total = Math.max(0.1, ...items.map((i) => i.end), ...(tl.layers || []).map((l) => l.start + l.out - l.in), ...(tl.audio || []).map((a) => a.start + a.out - a.in), ...(tl.text || []).map((t) => t.start + t.dur));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-free-'));
  const inArgs = []; let nIn = 0;
  const addIn = (args) => { inArgs.push(...args); return nIn++; };
  const cache = new Map();
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
        const c = obj, tr = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alpha: 1, ...(c.transform || {}) };
        const local = `(t-${T(start)})`;
        const sx = keyframeExpr(c, 'scaleX', tr.scaleX, local), sy = keyframeExpr(c, 'scaleY', tr.scaleY, local);
        const rot = keyframeExpr(c, 'rotation', tr.rotation, local), alpha = keyframeExpr(c, 'alpha', tr.alpha, local);
        const x = keyframeExpr(c, 'x', tr.x, local), y = keyframeExpr(c, 'y', tr.y, local);
        const label = `freev${serial}`;
        const transform = `scale=${width}:${height}:force_original_aspect_ratio=decrease,scale=w='max(2,iw*max(0.05,min(8,${sx})))':h='max(2,ih*max(0.05,min(8,${sy})))':eval=frame,rotate=a='(${rot})*PI/180':ow=rotw(iw):oh=roth(ih):c=black,format=rgba,lut=a='val*max(0,min(1,${alpha}))'`;
        f.push(`[${k}:v]trim=start=${T(c.in)}:end=${T(c.out)},setpts=(PTS-STARTPTS)/${c.speed || 1}+${T(start)}/TB,${fxChain(c)}${transform}[${label}]`);
        const next = `base${serial + 1}`;
        f.push(`${vCur}[${label}]overlay=x='(W-w)/2+(${x})*W':y='(H-h)/2+(${y})*H':enable='between(t,${T(start)},${T(visual.end)})':eof_action=pass:shortest=0:format=auto[${next}]`);
        vCur = `[${next}]`; serial++;
      } else {
        const l = obj, local = `(t-${T(start)})`, scale = keyframeExpr(l, 'scale', l.scale || 0.3, local), x = keyframeExpr(l, 'x', l.x ?? 0.8, local), y = keyframeExpr(l, 'y', l.y ?? 0.2, local), op = keyframeExpr(l, 'opacity', l.opacity ?? 1, local), rot = keyframeExpr(l, 'rotation', l.rotation || 0, local);
        const chroma = l.chroma ? `,chromakey=color=${String(l.chroma.color || '#00ff00').replace('#', '0x')}:similarity=${l.chroma.sim || 0.12}:blend=0.05` : '';
        const label = `freel${serial}`, next = `base${serial + 1}`;
        f.push(`[${k}:v]trim=start=${T(l.in)}:end=${T(l.out)},setpts=PTS-STARTPTS+${T(start)}/TB,scale=w='max(2,2*trunc(${width}*(${scale})/2))':h=-2:eval=frame,rotate=a='(${rot})*PI/180':ow=rotw(iw):oh=roth(ih):c=black,format=rgba${chroma},lut=a='val*max(0,min(1,${op}))'[${label}]`);
        f.push(`${vCur}[${label}]overlay=x='W*(${x})-w/2':y='H*(${y})-h/2':enable='between(t,${T(start)},${T(visual.end)})':eof_action=pass:shortest=0:format=auto[${next}]`);
        vCur = `[${next}]`; serial++;
      }
    }
    if (obj.type !== 'image' && obj.hasAudio && !muted) {
      const af = `freea${serial}`, ms = Math.round(start * 1000), speed = visual.kind === 'clip' ? (obj.speed || 1) : 1;
      f.push(`[${k}:a]atrim=start=${T(obj.in)}:end=${T(obj.out)},asetpts=PTS-STARTPTS${speed !== 1 ? ',' + atempo(speed) : ''},aresample=44100,aformat=channel_layouts=stereo,volume='${keyframeExpr(obj, 'volume', obj.volume ?? 1)}':eval=frame,adelay=${ms}|${ms}[${af}]`);
      audioLabels.push(`[${af}]`);
    }
  }
  let vLabel = vCur;
  if (tl.text && tl.text.length) { const ass = writeAss(tl.text, width, height, path.join(tmpDir, 'text.ass')); f.push(`${vLabel}ass='${fp(ass)}'[freeText]`); vLabel = '[freeText]'; }
  (tl.audio || []).forEach((a, i) => { const k = getVid(a.src), label = `freeAudio${i}`, ms = Math.round(a.start * 1000); f.push(`[${k}:a]atrim=start=${T(a.in)}:end=${T(a.out)},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume='${keyframeExpr(a, 'volume', a.volume ?? 1)}':eval=frame,adelay=${ms}|${ms}[${label}]`); audioLabels.push(`[${label}]`); });
  // A silence bed gives the final mix a stable duration even when the timeline has no audio.
  f.push(`anullsrc=r=44100:cl=stereo,atrim=duration=${T(total)},asetpts=PTS-STARTPTS[freeSilence]`);
  let aLabel = '[freeSilence]';
  if (tl.music && tl.music.src) { const mi = addIn(['-stream_loop', '-1', '-i', tl.music.src]); f.push(`[${mi}:a]atrim=duration=${T(total)},aresample=44100,aformat=channel_layouts=stereo,volume=${Math.max(0, Math.min(2, +tl.music.volume || 0.25))}[freeMusic]`); audioLabels.push('[freeMusic]'); }
  if (audioLabels.length) { const inputs = [aLabel, ...audioLabels].join(''); f.push(`${inputs}amix=inputs=${1 + audioLabels.length}:duration=first:dropout_transition=0:normalize=0[freeMix]`); aLabel = '[freeMix]'; }
  const args = ['-y', ...inArgs, '-filter_complex', f.join(';'), '-map', vLabel, '-map', aLabel, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', T(total), outPath];
  return { args, total };
}

function buildExport(tl, outPath, { width = 1280, height = 720, fps = 30, crf = 20 } = {}) {
  if (tl.mode === 'free') return buildFreeExport(tl, outPath, { width, height, fps, crf });
  if (!tl.video.length) throw new Error('Timeline is empty');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-'));
  const inArgs = []; let nIn = 0;
  const addIn = (a) => { inArgs.push(...a); return nIn++; };
  const vidIdx = new Map();
  const getVid = (src) => { if (!vidIdx.has(src)) vidIdx.set(src, addIn(['-i', src])); return vidIdx.get(src); };
  const imgIn = (src, d) => addIn(['-loop', '1', '-framerate', String(fps), '-t', T(d + 0.5), '-i', src]);
  const f = [];
  const durs = tl.video.map((c) => (c.out - c.in) / (c.speed || 1));
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
    const transformChain = tx.length ? tx.join(',') + ',' : '';
    const [fi, fo] = c.fade || [0, 0];
    const vfade = (fi > 0 ? `fade=t=in:st=0:d=${T(fi)},` : '') + (fo > 0 ? `fade=t=out:st=${T(Math.max(0, d - fo))}:d=${T(fo)},` : '');
    // Static position is applied by pad; animated position remains available in preview until animated compositing is added.
    const px = Math.round(Math.max(-width * 0.45, Math.min(width * 0.45, (+tr.x || 0) * width)));
    const py = Math.round(Math.max(-height * 0.45, Math.min(height * 0.45, (+tr.y || 0) * height)));
    f.push(`[${k}:v]trim=start=${T(c.in)}:end=${T(c.out)},setpts=(PTS-STARTPTS)/${sp},${zoom}${transformChain}${fxChain(c)}` +
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:x='max(0,min(ow-iw,(ow-iw)/2+(${px})))':y='max(0,min(oh-ih,(oh-ih)/2+(${py})))',setsar=1,fps=${fps},${vfade}format=yuv420p[v${i}]`);
    const afade = (fi > 0 ? `,afade=t=in:st=0:d=${T(fi)}` : '') + (fo > 0 ? `,afade=t=out:st=${T(Math.max(0, d - fo))}:d=${T(fo)}` : '');
    if (c.hasAudio && !img) {
      f.push(`[${k}:a]atrim=start=${T(c.in)}:end=${T(c.out)},asetpts=PTS-STARTPTS${sp !== 1 ? ',' + atempo(sp) : ''},aresample=44100,` +
        `aformat=channel_layouts=stereo,volume='${(tl.trackState && tl.trackState['1'] && tl.trackState['1'].muted) ? '0' : keyframeExpr(c, 'volume', c.volume ?? 1)}':eval=frame${afade}[a${i}]`);
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
    f.push(`[${k}:v]trim=start=${T(l.in)}:end=${T(l.out)},setpts=PTS-STARTPTS+${T(l.start)}/TB,scale=w='max(2,2*trunc(${width}*(${sx})/2))':h=-2:eval=frame${rotate},format=rgba${chroma},lut=a='val*(${opExpr})'[lv${j}]`);
    f.push(`${vCur}[lv${j}]overlay=x='W*(${xExpr})-w/2':y='H*(${yExpr})-h/2':enable='between(t,${T(l.start)},${T(l.start + d)})':eof_action=pass,format=yuv420p[vo${j}]`);
    vCur = `[vo${j}]`;
    if (!img && l.hasAudio && !(tl.trackState && tl.trackState[String(Number(l.track) || 2)] && tl.trackState[String(Number(l.track) || 2)].muted)) { const ms = Math.round(l.start * 1000); f.push(`[${k}:a]atrim=start=${T(l.in)}:end=${T(l.out)},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume='${keyframeExpr(l, 'volume', l.volume ?? 1)}':eval=frame,adelay=${ms}|${ms}[la${j}]`); extraA.push(`[la${j}]`); }
  });
  let vLabel = vCur;
  if (tl.text.length) {
    const assFile = writeAss(tl.text, width, height, path.join(tmpDir, 'text.ass'));
    f.push(`${vLabel}ass='${fp(assFile)}'[vt]`);
    vLabel = '[vt]';
  }
  // Extra audio tracks (voice-over, SFX, music clips) placed on the timeline.
  (tl.audio || []).forEach((a, j) => {
    const k = addIn(['-i', a.src]), ms = Math.round(a.start * 1000);
    f.push(`[${k}:a]atrim=start=${T(a.in)}:end=${T(a.out)},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume='${keyframeExpr(a, 'volume', a.volume ?? 1)}':eval=frame,adelay=${ms}|${ms}[ca${j}]`);
    extraA.push(`[ca${j}]`);
  });
  let aLabel = aCur;
  if (tl.music && tl.music.src) {
    const mi = addIn(['-stream_loop', '-1', '-i', tl.music.src]);
    f.push(`[${mi}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${tl.music.volume ?? 0.25}[m]`);
    if (tl.music.duck) {
      f.push(`${aCur}asplit=2[amain][asc]`, `[m][asc]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[md]`, `[amain][md]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[am]`);
    } else f.push(`${aCur}[m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[am]`);
    aLabel = '[am]';
  }
  if (extraA.length) { f.push(`${aLabel}${extraA.join('')}amix=inputs=${1 + extraA.length}:duration=first:dropout_transition=0:normalize=0[aall]`); aLabel = '[aall]'; }
  const args = ['-y', ...inArgs, '-filter_complex', f.join(';'), '-map', vLabel, '-map', aLabel,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', '-t', T(total), outPath];
  return { args, total };
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
async function detectScenes(file, threshold = 0.3) {
  const log = await run(['-hide_banner', '-i', file, '-an', '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-']);
  return [...log.matchAll(/pts_time:([\d.]+)/g)].map((m) => +m[1]);
}

// Small low-fps proxy (for sending video straight to vision models over OpenRouter).
async function proxyVideo(file, out, { start = 0, maxSec = 40 } = {}) {
  await run(['-y', '-ss', String(start), '-t', String(maxSec), '-i', file, '-vf', 'fps=2,scale=480:-2', '-c:v', 'libx264', '-crf', '32', '-preset', 'veryfast', '-an', out]);
  return out;
}

async function exportTimeline(tl, outPath, opts, onProgress) {
  const { args, total } = buildExport(tl, outPath, opts);
  await run(args, { onStderr: (s) => {
    const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(s);
    if (m && onProgress) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / total));
  } });
  return outPath;
}

// ---- "Brag" launch video: animated title cards with fade-in + slow push, inspired by /brag ----
async function renderBrag(scenes, outPath, { width = 1280, height = 720, sceneSec = 3 } = {}) {
  if (!scenes.length) throw new Error('No scenes');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-brag-'));
  const f = [], inputs = [], labels = [], overlays = [];
  scenes.forEach((s, i) => {
    const bg = (s.bg || '#101a2b').replace('#', '0x');
    inputs.push('-f', 'lavfi', '-i', `color=c=${bg}:s=${width}x${height}:r=30:d=${sceneSec}`);
    const t0 = i * sceneSec;
    if (s.title) overlays.push({ text: s.title, start: t0, dur: sceneSec, size: 84, color: '#ffffff', pos: 'center', fade: [500, 400] });
    if (s.subtitle) overlays.push({ text: s.subtitle, start: t0 + 0.25, dur: sceneSec - 0.25, size: 40, color: '#9fd3ff', pos: 'bottom', fade: [500, 400] });
    f.push(`[${i}:v]format=yuv420p[s${i}]`);
    labels.push(`[s${i}]`);
  });
  f.push(`${labels.join('')}concat=n=${scenes.length}:v=1:a=0[vc]`);
  const assFile = writeAss(overlays, width, height, path.join(tmpDir, 'brag.ass'));
  f.push(`[vc]ass='${fp(assFile)}',format=yuv420p[v]`);
  await run(['-y', ...inputs, '-filter_complex', f.join(';'), '-map', '[v]', '-c:v', 'libx264', '-crf', '20', outPath]);
  return outPath;
}

module.exports = { thumb, waveform, openFramePipe, PRESETS, ffmpegPath, run, probe, detectScenes, proxyVideo, detectSilence, extractAudioWav, extractFrames, buildExport, buildFreeExport, exportTimeline, renderBrag };
