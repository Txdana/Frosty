const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const crypto = require('crypto');
const bragPage = require('./lib/brag');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ff = require('./lib/ffmpeg');
const ai = require('./lib/ai');
const TL = require('./lib/timeline');
const reach = require('./lib/reach');
const sceneIndex = require('./lib/scene-index');

let win;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const loadSettings = () => {
  try { return { model: 'google/gemini-2.5-flash', whisper: 'base', apiKey: '', fallbacks: '', sort: '', ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; }
  catch { return { model: 'google/gemini-2.5-flash', whisper: 'base', apiKey: '' }; }
};

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 900, minWidth: 1100, minHeight: 700, backgroundColor: '#0b1220', title: 'Frosty',
    icon: path.join(__dirname, 'assets', 'frosty.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

const send = (ch, payload) => win && !win.isDestroyed() && win.webContents.send(ch, payload);
const wrap = (fn) => async (_e, ...a) => { try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message }; } };

ipcMain.handle('settings:get', wrap(async () => loadSettings()));
ipcMain.handle('settings:set', wrap(async (s) => { fs.writeFileSync(settingsFile(), JSON.stringify({ ...loadSettings(), ...s })); return true; }));

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

// ---- AI helpers: map source-time data onto timeline time ----
const transcriptCache = new Map();
async function getTranscript(src) {
  if (transcriptCache.has(src)) return transcriptCache.get(src);
  const wav = path.join(os.tmpdir(), 'frosty-' + path.basename(src) + '.wav');
  await ff.extractAudioWav(src, wav);
  const segs = await ai.transcribe(wav, loadSettings().whisper);
  transcriptCache.set(src, segs);
  return segs;
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

const downloadMedia = async (url) => {
  send('ai:status', 'Downloading video…');
  const f = await reach.download(url, { binDir: path.join(app.getPath('userData'), 'bin'), outDir: path.join(app.getPath('userData'), 'downloads'), ffmpeg: ff.ffmpegPath() });
  return ff.probe(f);
};
ipcMain.handle('reach:download', wrap(async (url) => downloadMedia(url)));
ipcMain.handle('reach:doctor', wrap(async () => reach.doctor({ ffmpeg: ff.ffmpegPath(), binDir: path.join(app.getPath('userData'), 'bin'), apiKey: loadSettings().apiKey, python: ai.PYTHONS })));
const fb = (s) => (s.fallbacks || '').split(',').map((x) => x.trim()).filter(Boolean);
const dataUrl = (f, mime) => `data:${mime};base64,${fs.readFileSync(f).toString('base64')}`;

ipcMain.handle('models:list', wrap(async () => ai.listModels(loadSettings().apiKey)));
ipcMain.handle('key:info', wrap(async () => ai.keyInfo(loadSettings().apiKey)));
ipcMain.handle('media:scenes', wrap(async (src, thr) => ff.detectScenes(src, thr || 0.3)));

const sceneIndexFile = () => path.join(app.getPath('userData'), 'scene-index.json');
ipcMain.handle('media:index', wrap(async ({ files, useVision = false } = {}) => {
  const all = files && files.length ? files : [];
  if (!all.length) throw new Error('Import media before indexing.');
  const s = loadSettings(); let total = 0, reports = [];
  for (const src of all) {
    send('ai:status', `Indexing scenes: ${path.basename(src)}…`);
    const report = await sceneIndex.indexMedia({ src, ff, indexFile: sceneIndexFile(),
      transcribe: getTranscript,
      caption: useVision && s.apiKey ? async (frame) => {
        const b64 = fs.readFileSync(frame).toString('base64');
        const r = await ai.chatRaw({ apiKey: s.apiKey, model: s.model, maxTokens: 120,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe visible actions, people, objects, setting, camera framing and mood in one concise searchable sentence. Do not guess identities.' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }] }] });
        return typeof r.message.content === 'string' ? r.message.content : '';
      } : null,
      onProgress: (p) => send('ai:status', `Indexing ${path.basename(src)}: ${p.current}/${p.total} scenes…`)
    });
    total += report.added; reports.push({ src, added: report.added });
  }
  send('ai:status', '');
  return { added: total, reports, totalScenes: sceneIndex.load(sceneIndexFile()).scenes.length };
}));
ipcMain.handle('media:search-scenes', wrap(async (query) => sceneIndex.search(sceneIndex.load(sceneIndexFile()), query, 30)));

async function generateImageMedia(prompt) {
  const s = loadSettings();
  const dir = path.join(app.getPath('userData'), 'generated'); fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `img-${Date.now()}.png`);
  await ai.generateImage({ apiKey: s.apiKey, model: s.imageModel || 'google/gemini-2.5-flash-image', prompt, outFile: out });
  return ff.probe(out);
}
ipcMain.handle('ai:image', wrap(async (prompt) => generateImageMedia(prompt)));

// Tool-calling agent: the model inspects and edits a working copy of the timeline, then we return it.
ipcMain.handle('ai:agent', wrap(async ({ request, timeline, history, video }) => {
  const s = loadSettings();
  const ctx = {
    status: (m) => send('ai:status', m),
    search: (q) => reach.search(q), read: (u) => reach.readUrl(u),
    download: (u) => downloadMedia(u),
    generateImage: (prompt) => generateImageMedia(prompt),
    searchScenes: async (query, limit) => sceneIndex.search(sceneIndex.load(sceneIndexFile()), query, limit),
    addScene: async (sceneKey) => sceneIndex.load(sceneIndexFile()).scenes.find((x) => x.key === sceneKey) || null,
    probe: (src) => ff.probe(src),
    silences: async (tl) => { const per = {}; for (const c of tl.video) if (c.hasAudio && !per[c.src]) per[c.src] = await ff.detectSilence(c.src); return toTimeline(tl, per); },
    transcript: async (tl) => { send('ai:status', 'Transcribing audio…'); const per = {}; for (const src of new Set(tl.video.map((c) => c.src))) per[src] = await getTranscript(src); return toTimeline(tl, per); },
    frames: async (tl, n) => { const out = []; for (const c of tl.video.slice(0, 4)) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-frames-')); for (const f of (await ff.extractFrames(c.src, dir, n, (c.out - c.in))).slice(0, n)) out.push(dataUrl(f, 'image/jpeg')); } return out; },
    video: async (tl) => { if (!video || !tl.video[0]) return null; const p = path.join(os.tmpdir(), `frosty-proxy-${Date.now()}.mp4`); const c = tl.video[0]; await ff.proxyVideo(c.src, p, { start: c.in, maxSec: Math.min(40, c.out - c.in) }); return dataUrl(p, 'video/mp4'); },
  };
  return ai.runAgent({ apiKey: s.apiKey, model: s.model, fallbacks: fb(s), sort: s.sort, request, timeline, history, ctx, TL });
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

ipcMain.handle('ai:brag', wrap(async ({ name, tagline, features, useAI }) => {
  const s = loadSettings();
  send('ai:status', 'Writing scenes…');
  let scenes;
  try { scenes = useAI && s.apiKey ? await ai.planBrag({ apiKey: s.apiKey, model: s.model, name, tagline, features }) : ai.simpleBrag({ name, tagline, features }); }
  catch (e) { scenes = ai.simpleBrag({ name, tagline, features }); }
  const dir = path.join(app.getPath('userData'), 'generated');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `brag-${Date.now()}.mp4`);
  send('ai:status', 'Rendering launch video…');
  try { await renderHtmlBrag(scenes, out); } catch (e) { send('ai:status', 'HTML renderer failed, using simple renderer…'); await ff.renderBrag(scenes, out); }
  return { media: await ff.probe(out), scenes };
}));

ipcMain.handle('export:run', wrap(async (timeline, opts) => {
  opts = { ...(opts || {}), ...(ff.PRESETS[opts && opts.preset] || {}) };
  const r = await dialog.showSaveDialog(win, { defaultPath: 'frosty-export.mp4', filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
  if (r.canceled) return null;
  await ff.exportTimeline(timeline, r.filePath, opts, (p) => send('export:progress', p));
  shell.showItemInFolder(r.filePath);
  return r.filePath;
}));

ipcMain.handle('project:save', wrap(async (data) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: 'project.frosty', filters: [{ name: 'Frosty project', extensions: ['frosty'] }] });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2));
  return r.filePath;
}));
ipcMain.handle('project:open', wrap(async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Frosty project', extensions: ['frosty'] }] });
  return r.canceled ? null : JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
}));
