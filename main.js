const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const crypto = require('crypto');
const bragPage = require('./lib/brag');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const ff = require('./lib/ffmpeg');
const renderEngine = require('./lib/render-engine');
const ai = require('./lib/ai');
const TL = require('./lib/timeline');
const reach = require('./lib/reach');
const sceneIndex = require('./lib/scene-index');
const { withCooldownEmbedding } = require('./lib/embedding-client');
const mediaWorkflow = require('./lib/media-workflow');
const projectFormat = require('./lib/project-format');
const ReferenceTemplate = require('./lib/reference-template');
const ReferenceComparator = require('./lib/reference-comparator');
const MotionDesign = require('./lib/motion-design');

const analysis = require('./lib/analysis');
const { materializeNestedSequences } = require('./lib/sequence-render');

function useEnabledProxies(timeline) {
  const tl = TL.clone(timeline);
  for (const key of ['video', 'layers', 'audio']) for (const item of tl[key] || []) {
    if (item.proxyEnabled && item.proxySrc && fs.existsSync(item.proxySrc)) item.src = item.proxySrc;
  }
  return tl;
}

let win;
let activePreviewController = null;
let activePreviewMovieController = null;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const secretsFile = () => path.join(app.getPath('userData'), 'settings-secrets.json');
let volatileSecrets = { apiKey: '', reachTokens: { github: '', reddit: '', x: '', youtube: '' } };
const SETTINGS_DEFAULTS = { model: 'google/gemini-2.5-flash', whisper: 'base', apiKey: '', fallbacks: '', sort: '', imageModel: '', reachTokens: { github: '', reddit: '', x: '', youtube: '' } };
function canEncryptSecrets() {
  try { return typeof safeStorage?.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable(); }
  catch { return false; }
}
function readEncryptedSecrets() {
  if (!canEncryptSecrets()) return { ...volatileSecrets, reachTokens: { ...volatileSecrets.reachTokens } };
  try {
    const raw = JSON.parse(fs.readFileSync(secretsFile(), 'utf8'));
    const decode = (value, fallback) => {
      try { return value ? JSON.parse(safeStorage.decryptString(Buffer.from(value, 'base64'))) : fallback; }
      catch { return fallback; }
    };
    return { apiKey: decode(raw.apiKey, ''), reachTokens: decode(raw.reachTokens, { github: '', reddit: '', x: '', youtube: '' }) };
  } catch { return { apiKey: '', reachTokens: { github: '', reddit: '', x: '', youtube: '' } }; }
}
function persistSettings(input) {
  const next = { ...SETTINGS_DEFAULTS, ...input, reachTokens: { ...SETTINGS_DEFAULTS.reachTokens, ...(input.reachTokens || {}) } };
  const secrets = { apiKey: String(next.apiKey || ''), reachTokens: Object.fromEntries(['github','reddit','x','youtube'].map(k => [k, String(next.reachTokens[k] || '').trim().slice(0, 8192)])) };
  const config = { ...next };
  delete config.apiKey; delete config.reachTokens;
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  atomicWriteFileSync(settingsFile(), JSON.stringify(config, null, 2));
  let secretsPersisted = false;
  if (canEncryptSecrets()) {
    const enc = {
      apiKey: safeStorage.encryptString(secrets.apiKey).toString('base64'),
      reachTokens: safeStorage.encryptString(JSON.stringify(secrets.reachTokens)).toString('base64'),
    };
    atomicWriteFileSync(secretsFile(), JSON.stringify(enc));
    secretsPersisted = true;
    volatileSecrets = { apiKey: '', reachTokens: { github: '', reddit: '', x: '', youtube: '' } };
  } else {
    // Never fall back to storing API keys/tokens as plaintext. They remain usable
    // during this process, but are intentionally not persisted without OS crypto.
    volatileSecrets = secrets;
  }
  return { ...config, ...secrets, secretsPersisted };
}
function loadSettings() {
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch {}
  const secrets = readEncryptedSecrets();
  // Migrate older Frosty releases that kept the OpenRouter key in settings.json.
  // The secret is immediately moved into OS-protected storage when available.
  const legacyApiKey = typeof disk.apiKey === 'string' ? disk.apiKey : '';
  const legacyTokens = disk.reachTokens && typeof disk.reachTokens === 'object' ? disk.reachTokens : null;
  if ((legacyApiKey || legacyTokens) && !secrets.apiKey && !Object.values(secrets.reachTokens || {}).some(Boolean)) {
    secrets.apiKey = legacyApiKey;
    if (legacyTokens) secrets.reachTokens = { ...SETTINGS_DEFAULTS.reachTokens, ...legacyTokens };
    delete disk.apiKey; delete disk.reachTokens;
    try { persistSettings({ ...SETTINGS_DEFAULTS, ...disk, ...secrets }); } catch {}
  }
  return { ...SETTINGS_DEFAULTS, ...disk, ...secrets, reachTokens: { ...SETTINGS_DEFAULTS.reachTokens, ...(secrets.reachTokens || {}) } };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 900, minWidth: 1100, minHeight: 700, backgroundColor: '#0b1220', title: 'Frosty',
    icon: path.join(__dirname, 'assets', 'frosty.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  // Keep the legacy Electron renderer in a sandbox and prevent renderer content from
  // navigating away from the trusted local UI or opening arbitrary child windows.
  const rendererEntry = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== rendererEntry) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

const send = (ch, payload) => win && !win.isDestroyed() && win.webContents.send(ch, payload);
const wrap = (fn) => async (_e, ...a) => { try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message }; } };

ipcMain.handle('settings:get', wrap(async () => loadSettings()));
ipcMain.handle('settings:set', wrap(async (s = {}) => {
  const current = loadSettings();
  const next = { ...current, ...s, reachTokens: { ...current.reachTokens, ...(s.reachTokens || {}) } };
  const stored = persistSettings(next);
  return { saved: true, secretsPersisted: stored.secretsPersisted, warning: stored.secretsPersisted ? '' : 'OS credential encryption is unavailable. Credentials are kept in memory only and will not be saved to disk.' };
}));

ipcMain.handle('media:import', wrap(async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mp3', 'wav', 'm4a', 'png', 'jpg', 'jpeg'] }] });
  if (r.canceled) return [];
  const out = [];
  for (const f of r.filePaths) out.push(await ff.probe(f));
  return out;
}));
ipcMain.handle('media:music', wrap(async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac'] }] });
  return r.canceled ? null : r.filePaths[0];
}));

// Proxy generation, relinking and nested-sequence project helpers.
ipcMain.handle('media:proxy', wrap(async ({ source, width = 640, height = 360 } = {}) => {
  if (!source) throw new Error('Choose a source media file first.');
  const dir = path.join(app.getPath('userData'), 'proxies'); fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(source)) throw new Error(`Source media does not exist: ${source}`);
  const sourceStat = fs.statSync(source);
  const key = crypto.createHash('sha256').update(`${path.resolve(source)}|${sourceStat.size}|${sourceStat.mtimeMs}`).digest('hex').slice(0, 24);
  const output = path.join(dir, `${key}-${Math.round(width)}x${Math.round(height)}.mp4`);
  if (fs.existsSync(output) && fs.statSync(output).size > 0) return { source: path.resolve(source), proxy: output, size: fs.statSync(output).size, cached: true };
  return { ...(await mediaWorkflow.createProxy(source, output, ff, { width, height })), cached: false };
}));
ipcMain.handle('project:relink', wrap(async ({ project, mapping } = {}) => mediaWorkflow.relinkMedia(project, mapping, { verify: true })));
ipcMain.handle('project:relink:scan', wrap(async (project) => {
  const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const candidates = mediaWorkflow.findRelinkCandidates(project, picked.filePaths[0]);
  const relinked = mediaWorkflow.relinkMedia(project, candidates.mapping, { verify: true });
  return { ...candidates, relinked, project };
}));
ipcMain.handle('project:validate', wrap(async (timeline) => mediaWorkflow.validateTimeline(timeline)));
ipcMain.handle('project:repair', wrap(async (timeline) => mediaWorkflow.repairTimeline(timeline)));
ipcMain.handle('project:sequence', wrap(async ({ project, action, parentId, childId, name, start, timeline } = {}) => {
  project.sequences ||= {};
  if (action === 'create') return mediaWorkflow.createSequence(project, name, timeline);
  if (action === 'nest') return mediaWorkflow.addNestedSequence(project, parentId, childId, start);
  if (action === 'canNest') return { allowed: mediaWorkflow.canNest(project, parentId, childId) };
  throw new Error(`Unknown sequence action: ${action}`);
}));

// ---- AI helpers: map source-time data onto timeline time ----
const transcriptCache = new Map();
async function getTranscript(src) {
  const stat = fs.statSync(src);
  const cacheKey = `${path.resolve(src)}|${stat.size}|${Math.trunc(stat.mtimeMs)}`;
  if (transcriptCache.has(cacheKey)) return transcriptCache.get(cacheKey);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-transcript-'));
  const wav = path.join(dir, 'audio.wav');
  try {
    await ff.extractAudioWav(src, wav);
    const segs = await ai.transcribe(wav, loadSettings().whisper);
    transcriptCache.set(cacheKey, segs);
    while (transcriptCache.size > 30) transcriptCache.delete(transcriptCache.keys().next().value);
    return segs;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function toTimeline(tl, perSrc) {
  const out = [];
  for (const { clip, start } of TL.layout(tl)) {
    for (const item of perSrc[clip.src] || []) {
      const [a, b] = Array.isArray(item) ? item : [item.start, item.end];
      const lo = Math.max(a, clip.in), hi = Math.min(b, clip.out);
      if (hi - lo <= 0.05) continue;
      const sp = clip.speed || 1;
      const m = { start: +(start + (lo - clip.in) / sp).toFixed(2), end: +(start + (hi - clip.in) / sp).toFixed(2) };
      if (!Array.isArray(item)) m.text = item.text;
      out.push(Array.isArray(item) ? [m.start, m.end] : m);
    }
  }
  return out;
}

ipcMain.handle('ai:silence', wrap(async (src, opts) => ff.detectSilence(src, opts)));
ipcMain.handle('ai:transcribe', wrap(async (src) => getTranscript(src)));

ipcMain.handle('ai:plan', wrap(async ({ request, timeline, useTranscript, useFrames }) => {
  const s = loadSettings();
  const srcs = [...new Set(timeline.video.map((c) => c.src))];
  let transcript = [], silences = [], frames = [];
  if (useTranscript) {
    send('ai:status', 'Transcribing audio…');
    const per = {};
    for (const src of srcs) per[src] = await getTranscript(src);
    transcript = toTimeline(timeline, per);
  }
  send('ai:status', 'Detecting silences…');
  const perS = {};
  for (const c of timeline.video) if (c.hasAudio && !perS[c.src]) perS[c.src] = await ff.detectSilence(c.src);
  silences = toTimeline(timeline, perS);
  if (useFrames) {
    send('ai:status', 'Sampling frames…');
    for (const c of timeline.video.slice(0, 3)) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-frames-'));
      frames.push(...(await ff.extractFrames(c.src, dir, 2, c.out - c.in)).slice(0, 2));
    }
  }
  send('ai:status', 'Asking the planner…');
  return ai.planEdit({ apiKey: s.apiKey, model: s.model, request, timeline: TL.summarize(timeline), transcript, silences, frames });
}));

const reachOptions = () => ({ binDir: path.join(app.getPath('userData'), 'bin'), outDir: path.join(app.getPath('userData'), 'downloads'), ffmpeg: ff.ffmpegPath(), tokens: loadSettings().reachTokens });
const downloadMedia = async (url, opts = {}) => {
  send('ai:status', 'Downloading public media…');
  try {
    const f = await reach.download(url, { ...reachOptions(), ...opts });
    const media = await ff.probe(f);
    if (opts.maxDuration && media.duration > opts.maxDuration + 0.5) { try { fs.unlinkSync(f); } catch {} throw new Error(`Video exceeds the ${opts.maxDuration}-second limit.`); }
    return media;
  } finally { send('ai:status', ''); }
};
ipcMain.handle('reach:download', wrap(async (url) => downloadMedia(url)));
ipcMain.handle('reach:inspect-video', wrap(async (url) => reach.inspectVideo(url, reachOptions())));
ipcMain.handle('reach:copy-template', wrap(async ({ url, includeCaptions = true, refineWithAI = true } = {}) => {
  const source = await downloadMedia(url, { maxDuration: 120 });
  const settings = loadSettings();
  // One batched multimodal pass compares temporal samples side by side. This is
  // different from asking the editor agent to guess the style from text metadata.
  // It runs only when the user enables AI refinement and has configured a provider.
  const analyzeVisualFrames = refineWithAI && settings.apiKey ? async (src, frames) => {
    const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-reference-vision-'));
    try {
      const content = [{ type: 'text', text: `You are analysing frames sampled from one reference video to help recreate its editing language in an editable video timeline. Each image has an ID and a temporal phase: start, middle, or end within a detected shot. Compare phases within each shot and across shots. Return JSON only, with this schema:
{
  "styleBible": {"format":"...", "palette":["..."], "typography":"visible font characteristics only; do not invent a font family", "captionTreatment":"...", "layoutLanguage":"...", "motionLanguage":"...", "recurringMotifs":["..."]},
  "frames": [{"id":"exact input ID", "description":"observable scene, composition and overlay description", "visibleText":["exactly legible text only"], "textPosition":"...", "typography":"weight/case/outline/shadow/approximate relative size", "overlayElements":["..."], "palette":["..."], "animationEvidence":"describe only changes supported by this frame and its labelled neighbouring phases", "confidence":"high|medium|low"}],
  "shots": [{"shot":1, "titleAnimation":"...", "entrance":"...", "exit":"...", "easing":"...", "transition":"hypothesis for incoming transition based on neighbouring shot samples", "evidence":["specific observed frame evidence"], "confidence":"high|medium|low"}],
  "notes":["uncertainties and missing evidence"]
}
Do not guess exact keyframes, font names, off-screen motion, or unseen effects. If only a single phase gives evidence, mark confidence low. Distinguish camera/subject motion from text or graphic animation. Treat a dissolve/wipe as a hypothesis unless the supplied frames show it. Include a frame entry for each supplied ID. Shot numbers are one-based source shot indices.` }];
      for (const frame of frames) {
        const file = path.join(frameDir, `${frame.id}.jpg`);
        await ff.run(['-y', '-ss', String(Math.max(0, frame.time)), '-i', src, '-frames:v', '1', '-vf', 'scale=640:-2:flags=lanczos', '-q:v', '4', file]);
        content.push({ type: 'text', text: `FRAME_ID=${frame.id}; SHOT=${frame.shot + 1}; PHASE=${frame.phase}; SOURCE_TIME=${frame.time}s` });
        content.push({ type: 'image_url', image_url: { url: dataUrl(file, 'image/jpeg') } });
      }
      const response = await ai.chatRaw({ apiKey: settings.apiKey, model: settings.model, fallbacks: fb(settings), sort: settings.sort, messages: [{ role: 'user', content }], json: true, temperature: 0.1, maxTokens: 5000 });
      const raw = response.message?.content;
      if (raw && typeof raw === 'object') return raw;
      const text = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
      try { return JSON.parse(text); } catch {
        const start = text.indexOf('{'), end = text.lastIndexOf('}');
        if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
        throw new Error('Vision model did not return the requested structured JSON.');
      }
    } finally { fs.rmSync(frameDir, { recursive: true, force: true }); }
  } : null;
  const analysisResult = await ReferenceTemplate.analyzeReference({
    src: source.path, ff,
    transcribe: async (src) => getTranscript(src),
    analyzeVisualFrames,
    onProgress: (p) => send('ai:status', p.message || p.phase || 'Analyzing reference…')
  });
  // Deterministic structural edit first; AI then refines the same editable object if configured.
  const baseline = ReferenceTemplate.buildTemplate(analysisResult, { includeCaptions: !!includeCaptions, preserveSourceMotion: true });
  const analysisText = JSON.stringify({
    source: analysisResult.source, cuts: analysisResult.cuts, pace: analysisResult.pace,
    transitions: analysisResult.transitions, motion: analysisResult.motion, audio: analysisResult.audio, visualAnalysis: analysisResult.visualAnalysis, animation: analysisResult.animation,
    captions: { transcriptStatus: analysisResult.captions.transcriptStatus, segmentCount: analysisResult.captions.segmentCount, transcript: analysisResult.captions.transcript.slice(0, 160) },
    shots: analysisResult.shots.map((shot) => ({ index: shot.index, start: shot.start, end: shot.end, duration: shot.duration, transition: shot.transition, motion: shot.motion, audioAlignment: shot.audioAlignment, animation: shot.animation, visualAnalysis: shot.visualAnalysis, captionText: shot.captionText })),
    visualSamples: analysisResult.visualSamples, limitations: analysisResult.limitations
  });
  const status = (message) => send('ai:status', message);
  const ctx = {
    status, referenceAnalysis: analysisResult,
    assets: async () => [source],
    assetFrames: async (limit = 12) => {
      const out = [], shots = analysisResult.shots.slice(0, Math.max(1, Math.min(24, limit)));
      for (const shot of shots) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-copy-assets-')); const file = path.join(dir, `shot-${shot.index}.jpg`); await ff.thumb(source.path, file, (shot.start + shot.end) / 2); out.push({ name: `${source.name} · shot ${shot.index + 1} @ ${((shot.start + shot.end) / 2).toFixed(2)}s`, path: source.path, type: 'video frame', dataUrl: dataUrl(file, 'image/jpeg') }); }
      return out;
    },
    search: (q) => reach.search(q, settings.reachTokens), read: (u) => reach.readUrl(u, { tokens: settings.reachTokens }),
    download: (u) => downloadMedia(u), generateImage: (prompt) => generateImageMedia(prompt),
    searchScenes: async (q, n) => sceneIndex.searchHybrid(sceneIndex.load(sceneIndexFile()), q, n, { embed: sceneEmbedding }),
    addScene: async (key) => sceneIndex.load(sceneIndexFile()).scenes.find((x) => x.key === key) || null,
    probe: (src) => ff.probe(src),
    silences: async (tl) => { const per = {}; for (const c of tl.video) if (c.hasAudio && !per[c.src]) per[c.src] = await ff.detectSilence(c.src); return toTimeline(tl, per); },
    transcript: async (tl) => { const per = {}; for (const src of new Set(tl.video.map((c) => c.src))) per[src] = await getTranscript(src); return toTimeline(tl, per); },
    frames: async (tl, perClip = 2) => {
      const out = []; const count = Math.max(1, Math.min(3, Number(perClip) || 2));
      for (const [index, c] of tl.video.slice(0, 20).entries()) {
        const duration = Math.max(0.05, (Number(c.out) || 0) - (Number(c.in) || 0));
        const positions = count === 1 ? [0.5] : count === 2 ? [0.04, 0.96] : [0.04, 0.5, 0.96];
        for (const portion of positions) { const at = Math.max(0, Math.min(Math.max(0, c.out - 0.01), c.in + portion * duration)); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-copy-frames-')); const file = path.join(dir, 'frame.jpg'); await ff.thumb(c.src, file, at); out.push({ url: dataUrl(file, 'image/jpeg'), label: `Clip ${index + 1} · source ${at.toFixed(2)}s · ${portion < .1 ? 'near shot start/cut' : portion > .9 ? 'near shot end/cut' : 'mid-shot'}` }); }
      }
      return out;
    },
    video: async () => null,
    createMotionGraphic: async (opts) => createMotionAsset(opts)
  };
  const log = [
    `Measured ${analysisResult.cuts.count} scene cut(s); median shot ${analysisResult.pace.medianShotSeconds}s (${analysisResult.pace.pace} pacing).`,
    `Motion samples: ${analysisResult.motion.sampleCount}; transitions: ${JSON.stringify(analysisResult.transitions)}.`,
    `Transcript: ${analysisResult.captions.transcriptStatus}; ${analysisResult.captions.segmentCount} timed segment(s).`
  ];
  let result = { timeline: baseline, log, media: [], summary: 'Created an editable reference timeline using detected cuts, source-time trims, pacing metadata and timed captions.' , cost: 0 };
  if (refineWithAI && settings.apiKey) {
    status('AI is comparing sampled frames and refining the editable template…');
    const request = `REFERENCE VIDEO COPY / MOTION ANALYSIS. A deterministic editable baseline was built from measured source cuts and audio transcript. Refine it only where visible evidence supports the edit.

REFERENCE ANALYSIS JSON (measured estimates; not ground truth):
${analysisText}

Inspect get_reference_analysis, get_timeline and view_frames. Use the attached temporal frame-comparison evidence and styleBible if available; compare start/middle/end samples for each selected shot rather than treating one still as proof. Analyze cut rhythm, estimated audio beat/onset alignment, shot pacing, spoken captions versus already-burned-in visible captions, visible typography, zoom/pan candidates, title entrance/exit animation, easing, and transitions from adjacent shot samples. Treat the per-shot blueprint as measured evidence plus explicit hypotheses, not ground truth. Keep source clips/trims; avoid duplicating camera motion already present in footage. Add editable text/graphic overlays, animation keyframes, effects or transitions when supported by sampled visual evidence. Do not invent exact words, fonts or transitions. Use create_motion_graphic for a reusable procedural graphic if that helps. Avoid changing the source content unnecessarily. Re-check the timeline and report inferred vs observed details. When visual evidence is insufficient, preserve the measured baseline and call that out.`;
    try {
      const refined = await ai.runAgent({ apiKey: settings.apiKey, model: settings.model, fallbacks: fb(settings), sort: settings.sort, request, timeline: baseline, ctx, TL, maxSteps: 16 });
      result = { ...refined, log: [...log, ...(refined.log || [])], summary: refined.summary || result.summary };
    } catch (e) {
      result.log = [...log, `AI refinement was unavailable; deterministic template retained: ${e.message}`];
      result.summary += ' AI visual refinement was not available, so the measurable baseline was retained.';
    }
  } else {
    result.log.push('AI visual refinement skipped: ' + (refineWithAI ? 'configure an OpenRouter API key in Settings or disable AI refinement.' : 'disabled by user.'));
  }
  result.timeline.referenceTemplate ||= baseline.referenceTemplate;
  result.timeline.referenceTemplate.analysis = analysisResult;
  result.timeline.referenceTemplate.analysis.visualSamples = analysisResult.visualSamples;
  result.source = source; result.analysis = analysisResult; result.media = [source, ...(result.media || [])];
  return result;
}));
ipcMain.handle('reference:compare-render', wrap(async ({ referencePath, renderedPath, options = {} } = {}) => ReferenceComparator.compareVideos(referencePath, renderedPath, ff, options)));
ipcMain.handle('reach:doctor', wrap(async () => reach.doctor({ ffmpeg: ff.ffmpegPath(), binDir: path.join(app.getPath('userData'), 'bin'), apiKey: loadSettings().apiKey, python: ai.PYTHONS })));
ipcMain.handle('reach:classify', wrap(async (url) => reach.classifyUrl(url)));
ipcMain.handle('reach:platforms', wrap(async () => reach.platformCapabilities(loadSettings().reachTokens)));
ipcMain.handle('reach:transcript', wrap(async (url) => {
  try { return await reach.extractTranscript(url, { binDir: path.join(app.getPath('userData'), 'bin'), outDir: os.tmpdir() }); }
  catch (subtitleError) {
    if (!/No English subtitle track/i.test(subtitleError.message)) throw subtitleError;
    send('ai:status', 'No captions found; downloading source for local Whisper fallback (maximum 15 minutes)…');
    const source = await downloadMedia(url, { maxDuration: 900 });
    const segments = await getTranscript(source.path);
    const transcript = (Array.isArray(segments) ? segments.map((segment) => typeof segment === 'string' ? segment : segment?.text || '').filter(Boolean).join(' ') : String(segments || '')).trim();
    return { transcript, source: 'local Whisper fallback', language: 'auto-detected', fallbackReason: subtitleError.message };
  } finally { send('ai:status', ''); }
}));
ipcMain.handle('reach:diagnostics', wrap(async () => reach.diagnostics({ binDir: path.join(app.getPath('userData'), 'bin'), tokens: loadSettings().reachTokens })));
ipcMain.handle('reach:read', wrap(async (url) => ({ url, text: await reach.readUrl(url, { tokens: loadSettings().reachTokens }), platform: reach.classifyUrl(url) })));
ipcMain.handle('reach:search', wrap(async (query) => reach.search(String(query || '').slice(0, 300), loadSettings().reachTokens)));
ipcMain.handle('reach:open-result', wrap(async (url) => { const safe = reach.validateHttpUrl(url); await reach.assertPublicHostname(safe); await shell.openExternal(safe.toString()); return true; }));
const fb = (s) => (s.fallbacks || '').split(',').map((x) => x.trim()).filter(Boolean);
const dataUrl = (f, mime) => `data:${mime};base64,${fs.readFileSync(f).toString('base64')}`;

ipcMain.handle('models:list', wrap(async () => ai.listModels(loadSettings().apiKey)));
ipcMain.handle('key:info', wrap(async () => ai.keyInfo(loadSettings().apiKey)));
ipcMain.handle('media:scenes', wrap(async (src, thr) => ff.detectScenes(src, thr || 0.3)));
ipcMain.handle('analysis:timeline', wrap(async ({ timeline, options } = {}) => { if (!timeline) throw new Error('No timeline to analyze.'); send('analysis:status', 'Analyzing media, scenes, audio loudness and color scopes…'); try { return await analysis.analyzeTimeline(timeline, ff, { ...(options || {}), transcribe: getTranscript }); } finally { send('analysis:status', ''); } }));
ipcMain.handle('analysis:media', wrap(async ({ source, options } = {}) => { if (!source) throw new Error('Choose a media file first.'); return analysis.analyzeMedia(source, ff, options || {}); }));
ipcMain.handle('analysis:scopes:frame', wrap(async ({ timeline, sequences = {}, frame, preset, fps } = {}) => {
  if (!timeline) throw new Error('No timeline was provided for scope generation.');
  const materialized = await materializeNestedSequences(timeline, sequences, { crf: 28, audioBitrate: '96k', useProxies: true }, { useEnabledProxies });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-scope-frame-'));
  try {
    const tl = materialized.timeline;
    const profile = ff.PRESETS[preset] || ff.PRESETS['Web 720p'];
    const longest = Math.max(profile.width || 1280, profile.height || 720);
    const scale = Math.min(1, 960 / longest);
    const rendered = await renderEngine.renderPreviewFrame(tl, frame, { width: Math.max(16, Math.round((profile.width || 1280) * scale)), height: Math.max(16, Math.round((profile.height || 720) * scale)), fps: fps || TL.frameRateString(tl) });
    const framePath = path.join(temp, 'playhead.jpg');
    fs.writeFileSync(framePath, Buffer.from(rendered.dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    const result = await analysis.generateScopesFromFrame(framePath, ff);
    return { frame: rendered.frame, time: rendered.time, scopes: result.scopes };
  } finally { materialized.cleanup(); fs.rmSync(temp, { recursive: true, force: true }); }
}));
ipcMain.handle('analysis:mixdown', wrap(async ({ timeline, sequences = {}, options = {} } = {}) => {
  if (!timeline) throw new Error('No timeline was provided for mix measurement.');
  const materialized = await materializeNestedSequences(timeline, sequences, {}, { useEnabledProxies: () => false });
  try { return await analysis.measureTimelineMix(materialized.timeline, ff, { fps: 12, width: 320, height: 180, crf: 35, ...options }); }
  finally { materialized.cleanup(); }
}));
ipcMain.handle('analysis:save-report', wrap(async (report) => { const r = await dialog.showSaveDialog(win, { defaultPath: 'frosty-analysis-report.json', filters: [{ name: 'JSON report', extensions: ['json'] }, { name: 'CSV report', extensions: ['csv'] }, { name: 'HTML report', extensions: ['html'] }] }); if (r.canceled) return null; const ext = path.extname(r.filePath).slice(1).toLowerCase() || 'json'; const content = analysis.exportReport(report, ext); fs.writeFileSync(r.filePath, content, 'utf8'); shell.showItemInFolder(r.filePath); return r.filePath; }));

const sceneIndexFile = () => path.join(app.getPath('userData'), 'scene-index.json');
// Optional local semantic search. A cooldown keeps an absent Ollama service from
// adding an 8-second timeout for every scene/query; lexical retrieval remains available.
const sceneEmbedding = process.env.FROSTY_EMBEDDING_DISABLED === '1' ? null : withCooldownEmbedding(
  (text) => sceneIndex.ollamaEmbedding(text, {
    endpoint: process.env.FROSTY_EMBEDDING_URL || 'http://127.0.0.1:11434/api/embed',
    model: process.env.FROSTY_EMBEDDING_MODEL || 'nomic-embed-text',
    timeoutMs: 8000
  }), { cooldownMs: 30000 });
ipcMain.handle('media:index', wrap(async ({ files, useVision = false } = {}) => {
  const all = files && files.length ? files : [];
  if (!all.length) throw new Error('Import media before indexing.');
  const s = loadSettings(); let total = 0, reports = [];
  try {
    for (const src of all) {
      send('ai:status', `Indexing scenes: ${path.basename(src)}…`);
      const report = await sceneIndex.indexMedia({ src, ff, indexFile: sceneIndexFile(), embed: sceneEmbedding || undefined,
        transcribe: getTranscript,
        caption: useVision && s.apiKey ? async (frame) => {
          const b64 = fs.readFileSync(frame).toString('base64');
          const r = await ai.chatRaw({ apiKey: s.apiKey, model: s.model, maxTokens: 120,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe visible actions, people, objects, setting, camera framing and mood in one concise searchable sentence. State only visible evidence; do not guess identities.' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }] }] });
          return typeof r.message.content === 'string' ? r.message.content : '';
        } : null,
        onProgress: (p) => send('ai:status', `Indexing ${path.basename(src)}: ${p.current}/${p.total} scenes…`)
      });
      total += report.added; reports.push({ src, added: report.added, totalSpans: report.totalSpans || 0, skipped: report.skipped || null });
    }
    const storedIndex = sceneIndex.load(sceneIndexFile());
    return { added: total, reports, totalScenes: storedIndex.scenes.length, embeddedScenes: storedIndex.scenes.filter((scene) => Array.isArray(scene.embedding)).length, embeddingMode: sceneEmbedding ? 'optional-hybrid' : 'lexical-only', embeddingStatus: sceneEmbedding ? sceneEmbedding.status() : null };
  } finally { send('ai:status', ''); }
}));
ipcMain.handle('media:search-scenes', wrap(async (query) => sceneIndex.searchHybrid(sceneIndex.load(sceneIndexFile()), query, 30, { embed: sceneEmbedding })));

async function createMotionAsset(input = {}) {
  const options = { ...input };
  const svg = MotionDesign.generateSvg(options);
  const width = Math.max(320, Math.min(3840, Math.round(Number(options.width) || 1920)));
  const height = Math.max(240, Math.min(3840, Math.round(Number(options.height) || 1080)));
  const dir = path.join(app.getPath('userData'), 'motion-graphics'); fs.mkdirSync(dir, { recursive: true });
  const stem = `motion-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const pngPath = path.join(dir, `${stem}.png`), svgPath = path.join(dir, `${stem}.svg`), htmlPath = path.join(dir, `${stem}.html`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:transparent}svg{display:block;width:${width}px;height:${height}px}</style></head><body>${svg}</body></html>`;
  fs.writeFileSync(svgPath, svg, 'utf8'); fs.writeFileSync(htmlPath, html, 'utf8');
  const raster = new BrowserWindow({ width, height, show: false, frame: false, transparent: true, backgroundColor: '#00000000', useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try {
    await raster.loadFile(htmlPath);
    await raster.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
    const image = await raster.webContents.capturePage({ x: 0, y: 0, width, height });
    if (image.isEmpty()) throw new Error('Chromium returned an empty motion-graphic frame.');
    fs.writeFileSync(pngPath, image.toPNG());
  } finally { if (!raster.isDestroyed()) raster.destroy(); try { fs.unlinkSync(htmlPath); } catch {} }
  const duration = Math.max(0.2, Math.min(120, Number(options.duration) || 4));
  return { path: pngPath, designPath: svgPath, name: String(options.name || options.title || options.type || 'Motion graphic').slice(0, 120), type: 'image', duration, width, height, hasVideo: false, hasAudio: false, generated: true, motionDesign: { type: options.type || 'title-card', theme: options.theme || 'studio', animation: options.animation || 'none', options: { ...options, width, height, duration, name: String(options.name || options.title || options.type || 'Motion graphic').slice(0, 120) } } };
}

async function generateImageMedia(prompt) {
  const s = loadSettings();
  const dir = path.join(app.getPath('userData'), 'generated'); fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `img-${Date.now()}.png`);
  await ai.generateImage({ apiKey: s.apiKey, model: s.imageModel || 'google/gemini-2.5-flash-image', prompt, outFile: out });
  return ff.probe(out);
}
ipcMain.handle('ai:image', wrap(async (prompt) => generateImageMedia(prompt)));
ipcMain.handle('motion:preview', wrap(async (options) => ({ svg: MotionDesign.generateSvg(options || {}) })));
ipcMain.handle('motion:create', wrap(async (options) => createMotionAsset(options || {})));

// Tool-calling agent: the model inspects and edits a working copy of the timeline, then we return it.
ipcMain.handle('ai:agent', wrap(async ({ request, timeline, history, video, assets = [], permissions = {} }) => {
  const s = loadSettings();
  const ctx = {
    status: (m) => send('ai:status', m),
    assets: async () => assets,
    assetFrames: async (limit = 12) => { const out = []; for (const m of assets.slice(0, Math.max(1, Math.min(20, limit)))) { try { if (m.type === 'image' || /\.(png|jpe?g|webp|bmp|gif)$/i.test(m.path)) out.push({ name: m.name, path: m.path, type: 'image', dataUrl: dataUrl(m.path, 'image/png') }); else if (m.hasVideo) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-assets-')); const frames = await ff.extractFrames(m.path, dir, 1, Math.min(5, m.duration || 5)); if (frames[0]) out.push({ name: m.name, path: m.path, type: 'video frame', dataUrl: dataUrl(frames[0], 'image/jpeg') }); } } catch {} } return out; },
    search: (q) => reach.search(q, s.reachTokens), read: (u) => reach.readUrl(u, { tokens: s.reachTokens }),
    download: (u) => downloadMedia(u),
    generateImage: (prompt) => generateImageMedia(prompt),
    searchScenes: async (query, limit) => sceneIndex.searchHybrid(sceneIndex.load(sceneIndexFile()), query, limit, { embed: sceneEmbedding }),
    addScene: async (sceneKey) => sceneIndex.load(sceneIndexFile()).scenes.find((x) => x.key === sceneKey) || null,
    probe: (src) => ff.probe(src),
    silences: async (tl) => { const per = {}; for (const c of tl.video) if (c.hasAudio && !per[c.src]) per[c.src] = await ff.detectSilence(c.src); return toTimeline(tl, per); },
    transcript: async (tl) => { send('ai:status', 'Transcribing audio…'); const per = {}; for (const src of new Set(tl.video.map((c) => c.src))) per[src] = await getTranscript(src); return toTimeline(tl, per); },
    frames: async (tl, n) => { const out = []; const perClip = Math.max(1, Math.min(3, Number(n) || 2)); for (const [index, c] of tl.video.slice(0, 20).entries()) { const duration = Math.max(.05, (Number(c.out) || 0) - (Number(c.in) || 0)); const positions = perClip === 1 ? [.5] : perClip === 2 ? [.04,.96] : [.04,.5,.96]; for (const portion of positions) { const at = Math.max(0, Math.min(Math.max(0, c.out - .01), c.in + portion * duration)); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-frames-')); const f = path.join(dir, 'frame.jpg'); await ff.thumb(c.src, f, at); out.push({ url: dataUrl(f, 'image/jpeg'), label: `Clip ${index + 1} · source ${at.toFixed(2)}s · ${portion < .1 ? 'near shot start/cut' : portion > .9 ? 'near shot end/cut' : 'mid-shot'}` }); } } return out; },
    createMotionGraphic: async (opts) => createMotionAsset(opts),
    video: async (tl) => { if (!video || !tl.video[0]) return null; const p = path.join(os.tmpdir(), `frosty-proxy-${Date.now()}.mp4`); const c = tl.video[0]; await ff.proxyVideo(c.src, p, { start: c.in, maxSec: Math.min(40, c.out - c.in) }); return dataUrl(p, 'video/mp4'); },
  };
  return ai.runAgent({ apiKey: s.apiKey, model: s.model, fallbacks: fb(s), sort: s.sort, request, timeline, history, ctx, TL, permissions });
}));

// Render HTML/CSS scenes by capturing an offscreen window frame by frame into FFmpeg.
async function renderHtmlBrag(scenes, out, { width = 1280, height = 720, fps = 30, sceneSec = 3 } = {}) {
  const htmlFile = path.join(os.tmpdir(), `frosty-scenes-${Date.now()}.html`);
  fs.writeFileSync(htmlFile, bragPage.pageHtml(scenes, { width, height, sceneSec }));
  const w = new BrowserWindow({ width, height, show: false, useContentSize: true, frame: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  try {
    await w.loadFile(htmlFile);
    const pipe = ff.openFramePipe(out, { fps });
    const frames = Math.round(scenes.length * sceneSec * fps);
    for (let n = 0; n < frames; n++) {
      await w.webContents.executeJavaScript(`window.__seek(${(n / fps).toFixed(4)})`);
      await new Promise((r) => setTimeout(r, 16)); // let the compositor paint the new state
      const img = await w.webContents.capturePage();
      await pipe.write(img.resize({ width, height }).toJPEG(92));
      if (n % 15 === 0) send('ai:status', `Rendering scenes ${Math.round((n / frames) * 100)}%`);
    }
    await pipe.end();
  } finally { w.destroy(); fs.rmSync(htmlFile, { force: true }); }
  return out;
}

// Cached thumbnail + waveform for the media bin and timeline.
ipcMain.handle('media:assets', wrap(async (file) => {
  const dir = path.join(app.getPath('userData'), 'cache'); fs.mkdirSync(dir, { recursive: true });
  const key = crypto.createHash('md5').update(file).digest('hex');
  const th = path.join(dir, key + '.jpg'), wv = path.join(dir, key + '.png');
  const m = await ff.probe(file);
  if (!fs.existsSync(th)) await ff.thumb(file, th, m.type === 'image' ? 0 : Math.min(1, m.duration / 3)).catch(() => {});
  if (m.hasAudio && !fs.existsSync(wv)) await ff.waveform(file, wv).catch(() => {});
  return { thumb: fs.existsSync(th) ? th : null, wave: fs.existsSync(wv) ? wv : null };
}));

ipcMain.handle('ai:brag', wrap(async ({ name, tagline, features, useAI, draftOnly = false }) => {
  const s = loadSettings();
  send('ai:status', 'Writing storyboard…');
  let scenes;
  try { scenes = useAI && s.apiKey ? await ai.planBrag({ apiKey: s.apiKey, model: s.model, name, tagline, features }) : ai.simpleBrag({ name, tagline, features }); }
  catch (e) { scenes = ai.simpleBrag({ name, tagline, features }); }
  scenes = bragPage.validateStoryboard(scenes);
  if (draftOnly) return { scenes };
  const dir = path.join(app.getPath('userData'), 'generated'); fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `brag-${Date.now()}.mp4`);
  send('ai:status', 'Rendering launch video…');
  try { await renderHtmlBrag(scenes, out); } catch (e) { send('ai:status', 'HTML renderer failed, using simple renderer…'); await ff.renderBrag(scenes, out); }
  return { media: await ff.probe(out), scenes };
}));
ipcMain.handle('brag:save-draft', wrap(async ({ name = 'launch-storyboard', scenes = [], soundtrack = '', metadata = {} } = {}) => {
  const payload = bragPage.createDraft({ name, scenes, soundtrack, metadata });
  const r = await dialog.showSaveDialog(win, { title: 'Save Brag storyboard', defaultPath: `${payload.name.replace(/[\\/:*?"<>|]/g, '_')}.brag.json`, filters: [{ name: 'Frosty Brag storyboard', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(payload, null, 2), 'utf8');
  return { path: r.filePath, name: path.basename(r.filePath) };
}));
ipcMain.handle('brag:open-draft', wrap(async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Frosty Brag storyboard', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const file = r.filePaths[0];
  const parsed = bragPage.parseDraft(JSON.parse(fs.readFileSync(file, 'utf8')));
  return { path: file, ...parsed, name: parsed.name || path.basename(file) };
}));
ipcMain.handle('brag:pick-soundtrack', wrap(async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }] });
  return r.canceled ? null : r.filePaths[0];
}));
ipcMain.handle('brag:render', wrap(async ({ scenes, soundtrack = '', sceneSec = 3, width = 1280, height = 720, fps = 30 } = {}) => {
  scenes = bragPage.validateStoryboard(scenes);
  ({ sceneSec, width, height, fps } = bragPage.normalizeRenderOptions({ sceneSec, width, height, fps }));
  const warnings = [];
  scenes.forEach((scene, i) => { if (scene.imagePath && !(/\.(png|jpe?g|webp)$/i.test(scene.imagePath) && fs.existsSync(scene.imagePath))) warnings.push(`Scene ${i + 1}: product image is missing or unsupported and will be omitted.`); });
  if (soundtrack && !fs.existsSync(soundtrack)) warnings.push('The saved soundtrack path is missing; rendering without a soundtrack.');
  scenes = scenes.map((scene) => {
    if (scene.imagePath && /\.(png|jpe?g|webp)$/i.test(scene.imagePath) && fs.existsSync(scene.imagePath) && fs.statSync(scene.imagePath).isFile()) {
      const ext = path.extname(scene.imagePath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      return { ...scene, imageData: `data:${mime};base64,${fs.readFileSync(scene.imagePath).toString('base64')}` };
    }
    return scene;
  });
  const dir = path.join(app.getPath('userData'), 'generated'); fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `brag-${Date.now()}.mp4`), silent = path.join(dir, `brag-${Date.now()}-silent.mp4`);
  send('ai:status', 'Rendering storyboard…');
  try { await renderHtmlBrag(scenes, silent, { width, height, fps, sceneSec }); }
  catch (e) { send('ai:status', `HTML renderer fallback: ${e.message}`); await ff.renderBrag(scenes, silent, { width, height, fps, sceneSec }); }
  if (soundtrack && fs.existsSync(soundtrack)) {
    await ff.run(['-y', '-i', silent, '-stream_loop', '-1', '-i', soundtrack, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out]);
    fs.rmSync(silent, { force: true });
  } else { fs.renameSync(silent, out); }
  return { media: await ff.probe(out), scenes, warnings, output: { width, height, fps, sceneSec, duration: scenes.length * sceneSec }, shareCopy: bragPage.makeShareCopy({ name: scenes[0]?.title || 'Launch', tagline: scenes[0]?.subtitle || '', features: scenes.slice(1).map((x) => x.title) }) };
}));
ipcMain.handle('brag:share-copy', wrap(async (options) => bragPage.makeShareCopy(options || {})));

ipcMain.on('preview:cancel', () => { activePreviewController?.abort(); });
ipcMain.on('preview:movie:cancel', () => { activePreviewMovieController?.abort(); });
ipcMain.handle('preview:movie', wrap(async ({ timeline, sequences = {}, preset } = {}) => {
  if (!timeline || typeof timeline !== 'object') throw new Error('A timeline is required to build the playback preview.');
  const materialized = await materializeNestedSequences(timeline, sequences, { crf: 30, audioBitrate: '96k', useProxies: true }, { useEnabledProxies });
  const tl = TL.ensure(materialized.timeline);
  const profile = ff.PRESETS[preset] || ff.PRESETS['Web 720p'];
  const fps = TL.frameRateString(tl);
  const maxEdge = 960;
  const longest = Math.max(Number(profile.width) || 1280, Number(profile.height) || 720);
  const scale = Math.min(1, maxEdge / longest);
  const width = Math.max(16, Math.round(((Number(profile.width) || 1280) * scale) / 2) * 2);
  const height = Math.max(16, Math.round(((Number(profile.height) || 720) * scale) / 2) * 2);
  const sourcePaths = new Set();
  for (const group of [tl.video, tl.layers, tl.audio]) for (const item of group || []) if (item.src) sourcePaths.add(item.src);
  if (tl.music?.src) sourcePaths.add(tl.music.src);
  const sourceState = [...sourcePaths].sort().map((src) => {
    try { const st = fs.statSync(src); return [src, st.size, st.mtimeMs]; }
    catch { throw new Error(`Preview source is missing: ${src}`); }
  });
  const key = crypto.createHash('sha256').update(JSON.stringify({ timeline: tl, preset, fps, width, height, sourceState })).digest('hex');
  const cacheDir = path.join(app.getPath('userData'), 'preview-movies');
  fs.mkdirSync(cacheDir, { recursive: true });
  const output = path.join(cacheDir, `${key}.mp4`);
  if (fs.existsSync(output) && fs.statSync(output).size > 1024) {
    materialized.cleanup();
    return { url: pathToFileURL(output).href, path: output, fps, width, height, duration: TL.duration(tl), cached: true };
  }
  activePreviewMovieController?.abort();
  const controller = new AbortController();
  activePreviewMovieController = controller;
  try {
    const options = { ...profile, width, height, fps, crf: 30, audioBitrate: '96k', videoBitrate: '' };
    const graph = ff.buildExport(tl, output, options);
    const total = graph.total;
    send('preview:movie:progress', { progress: 0, time: 0, total, phase: 'rendering' });
    try { await ff.run(graph.args, { signal: controller.signal, onStderr: (chunk) => {
      const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(chunk);
      if (!m) return;
      const time = (+m[1] * 3600) + (+m[2] * 60) + (+m[3]);
      send('preview:movie:progress', { progress: total > 0 ? Math.max(0, Math.min(1, time / total)) : 0, time, total, phase: 'rendering' });
    }}); } finally { graph.cleanup?.(); }
    if (!fs.existsSync(output) || fs.statSync(output).size < 1024) throw new Error('FFmpeg did not create a valid playback preview.');
    send('preview:movie:progress', { progress: 1, time: total, total, phase: 'ready' });
    // Keep a small bounded cache; active preview file remains valid while the renderer plays it.
    const entries = fs.readdirSync(cacheDir).map((name) => ({ name, file: path.join(cacheDir, name) })).filter((x) => x.name.endsWith('.mp4')).map((x) => ({ ...x, mtime: fs.statSync(x.file).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    for (const stale of entries.slice(4)) if (stale.file !== output) { try { fs.unlinkSync(stale.file); } catch {} }
    return { url: pathToFileURL(output).href, path: output, fps, width, height, duration: total, cached: false };
  } catch (error) {
    try { fs.unlinkSync(output); } catch {}
    throw error;
  } finally {
    materialized.cleanup();
    if (activePreviewMovieController === controller) activePreviewMovieController = null;
  }
}));
ipcMain.handle('preview:frame', wrap(async ({ timeline, sequences = {}, frame, preset, fps } = {}) => {
  if (!timeline) throw new Error('No timeline was provided for preview rendering.');
  const materialized = await materializeNestedSequences(timeline, sequences, { crf: 28, audioBitrate: '96k', useProxies: true }, { useEnabledProxies });
  timeline = materialized.timeline;
  activePreviewController?.abort();
  const controller = new AbortController();
  activePreviewController = controller;
  const profile = ff.PRESETS[preset] || ff.PRESETS['Web 720p'];
  // The preview preserves the chosen profile's aspect ratio, while capping its
  // longest edge to keep scrubbing responsive. Export still uses full profile size.
  const longest = Math.max(profile.width || 1280, profile.height || 720);
  const scale = Math.min(1, 1280 / longest);
  try {
    return await renderEngine.renderPreviewFrame(timeline, frame, {
      ...profile,
      width: Math.max(16, Math.round((profile.width || 1280) * scale)),
      height: Math.max(16, Math.round((profile.height || 720) * scale)),
      fps: fps || TL.frameRateString(timeline),
      signal: controller.signal,
    });
  } finally {
    materialized.cleanup();
    if (activePreviewController === controller) activePreviewController = null;
  }
}));

ipcMain.handle('export:run', wrap(async (payload, opts) => {
  const timeline = payload?.timeline || payload;
  const sequences = payload?.timeline ? (payload.sequences || {}) : {};
  opts = { ...(ff.PRESETS[opts && opts.preset] || {}), ...(opts || {}) };
  if (opts.fps == null) opts.fps = TL.frameRateString(timeline);
  const r = await dialog.showSaveDialog(win, { defaultPath: 'frosty-export.mp4', filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
  if (r.canceled) return null;
  const materialized = await materializeNestedSequences(timeline, sequences, opts, { useEnabledProxies });
  try { await ff.exportTimeline(materialized.timeline, r.filePath, opts, (p) => send('export:progress', p)); send('export:encoder', { codec: opts.encoderUsed || opts.videoCodec || 'libx264' }); }
  finally { materialized.cleanup(); }
  shell.showItemInFolder(r.filePath);
  return r.filePath;
}));

// Crash-safe write: temp file in the same folder, fsync, keep previous copy as .bak, then atomic rename.
function atomicWriteFileSync(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'wx');
  try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
ipcMain.handle('project:save', wrap(async (data) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: 'project.frosty', filters: [{ name: 'Frosty project', extensions: ['frosty'] }] });
  if (r.canceled) return null;
  atomicWriteFileSync(r.filePath, JSON.stringify(data, null, 2));
  return r.filePath;
}));
ipcMain.handle('project:open', wrap(async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Frosty project', extensions: ['frosty'] }] });
  return r.canceled ? null : projectFormat.nativeProjectToElectron(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')));
}));
