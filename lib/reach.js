// Frosty "Reach": internet access for the editor and its AI agent (agent-reach style, re-implemented).
// Read pages (Jina Reader), search the web (DuckDuckGo HTML), download videos (yt-dlp), health-check everything.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Frosty/0.3';

async function readUrl(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Need a full http(s) URL');
  const res = await fetch('https://r.jina.ai/' + url, { headers: { 'User-Agent': UA, Accept: 'text/plain' } });
  if (!res.ok) throw new Error(`Reader error ${res.status}`);
  return (await res.text()).slice(0, 12000);
}

function parseDDG(html) {
  const out = [];
  const strip = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').trim();
  for (const chunk of html.split('class="result__a"').slice(1)) {
    const m = /href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(chunk);
    if (!m) continue;
    let u = m[1].replace(/&amp;/g, '&');
    const q = /[?&]uddg=([^&]+)/.exec(u);
    if (q) u = decodeURIComponent(q[1]);
    if (u.startsWith('//')) u = 'https:' + u;
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(chunk);
    out.push({ title: strip(m[2]), url: u, snippet: strip(sn && sn[1]) });
    if (out.length >= 8) break;
  }
  return out;
}
async function search(q) {
  const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Search error ${res.status}`);
  return parseDDG(await res.text());
}

// ---- yt-dlp (system install, or auto-fetched into Frosty's data folder) ----
const exeName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
function onPath(cmd) { try { return spawnSync(cmd, ['--version'], { windowsHide: true }).status === 0; } catch { return false; } }
async function ytdlp(binDir) {
  if (onPath('yt-dlp')) return 'yt-dlp';
  const local = path.join(binDir, exeName);
  if (fs.existsSync(local)) return local;
  fs.mkdirSync(binDir, { recursive: true });
  const res = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + exeName, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('Could not fetch yt-dlp (' + res.status + '). Install it from github.com/yt-dlp/yt-dlp.');
  fs.writeFileSync(local, Buffer.from(await res.arrayBuffer()));
  if (process.platform !== 'win32') fs.chmodSync(local, 0o755);
  return local;
}
function runTool(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(err.split('\n').filter(Boolean).slice(-3).join(' ')))));
  });
}
// Download best <=1080p mp4 and return the file path.
async function download(url, { binDir, outDir, ffmpeg }) {
  const bin = await ytdlp(binDir);
  fs.mkdirSync(outDir, { recursive: true });
  const out = await runTool(bin, ['--no-playlist', '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4', '--ffmpeg-location', ffmpeg,
    '-o', path.join(outDir, '%(title).80s.%(ext)s'), '--print', 'after_move:filepath', '--no-warnings', url]);
  const file = out.trim().split(/\r?\n/).pop();
  if (!file || !fs.existsSync(file)) throw new Error('Download finished but file not found');
  return file;
}

async function doctor({ ffmpeg, binDir, apiKey, python }) {
  const r = [];
  const ok = (name, good, note) => r.push({ name, ok: !!good, note });
  ok('FFmpeg', fs.existsSync(ffmpeg) || ffmpeg === 'ffmpeg', ffmpeg);
  const py = python.map((c) => ({ c, s: spawnSync(c[0], [...c.slice(1), '-c', 'import faster_whisper'], { windowsHide: true }) })).find((x) => x.s.status === 0);
  ok('Whisper (python + faster-whisper)', py, py ? py.c.join(' ') : 'run: pip install faster-whisper');
  ok('yt-dlp', onPath('yt-dlp') || fs.existsSync(path.join(binDir, exeName)), 'auto-installs on first download');
  ok('OpenRouter key', !!apiKey, apiKey ? 'set' : 'add in Settings');
  try { await fetch('https://r.jina.ai/https://example.com', { headers: { 'User-Agent': UA } }).then((x) => { if (!x.ok) throw 0; }); ok('Web reader', true, 'r.jina.ai reachable'); }
  catch { ok('Web reader', false, 'no internet or blocked'); }
  return r;
}
module.exports = { readUrl, search, parseDDG, download, doctor, ytdlp };
