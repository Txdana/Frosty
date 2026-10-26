// Persistent scene-level media index for semantic/keyword retrieval (Video-RAG foundation).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const terms = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((x) => x.length > 1);
const key = (src, start, end) => crypto.createHash('sha1').update(`${src}|${start.toFixed(3)}|${end.toFixed(3)}`).digest('hex');
function search(index, query, limit = 20) {
  const q = [...new Set(terms(query))];
  if (!q.length) return [];
  return (index.scenes || []).map((s) => {
    const body = `${s.name} ${s.caption || ''} ${s.transcript || ''} ${s.tags || ''}`.toLowerCase();
    const tokens = terms(body), score = q.reduce((n, t) => n + (body.includes(t) ? 1 + Math.min(2, tokens.filter((x) => x === t).length * 0.25) : 0), 0);
    return { ...s, scene_key: s.key, score: +(score / q.length).toFixed(3) };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.start - b.start).slice(0, Math.max(1, limit));
}
async function indexMedia({ src, media, ff, transcribe, caption, indexFile, onProgress = () => {} }) {
  const index = load(indexFile);
  const existing = new Map(index.scenes.map((s) => [s.key, s]));
  const meta = media || await ff.probe(src);
  if (!meta.hasVideo) return { index, added: 0 };
  const cuts = await ff.detectScenes(src, 0.28);
  const points = [0, ...cuts.filter((x) => x > 0.15 && x < meta.duration - 0.15), meta.duration].sort((a,b)=>a-b);
  const spans = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i], end = points[i + 1];
    if (end - start >= 0.35) spans.push({ start: +start.toFixed(3), end: +end.toFixed(3) });
  }
  const transcript = meta.hasAudio ? await transcribe(src).catch(() => []) : [];
  const dir = path.join(path.dirname(indexFile), 'scene-frames'); fs.mkdirSync(dir, { recursive: true });
  let added = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i], k = key(src, span.start, span.end);
    const prior = existing.get(k);
    if (prior && prior.caption && prior.transcript) continue;
    const frame = prior?.frame || path.join(dir, `${k}.jpg`);
    if (!fs.existsSync(frame)) await ff.thumb(src, frame, Math.min(span.end - 0.05, span.start + (span.end-span.start)/2)).catch(() => {});
    const words = transcript.filter((t) => t.end > span.start && t.start < span.end).map((t) => t.text).join(' ');
    let description = prior?.caption || '';
    if (!description && caption && fs.existsSync(frame)) description = await caption(frame).catch(() => '');
    const record = { key: k, src, name: meta.name || path.basename(src), start: span.start, end: span.end,
      duration: +(span.end - span.start).toFixed(3), frame, transcript: words || prior?.transcript || '', caption: description, indexedAt: new Date().toISOString() };
    if (prior) Object.assign(prior, record); else { index.scenes.push(record); existing.set(k, record); }
    added++; onProgress({ current: i + 1, total: spans.length, added });
  }
  index.version = 1; index.updatedAt = new Date().toISOString();
  save(indexFile, index);
  return { index, added };
}
function load(file) { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return { version: d.version || 1, scenes: Array.isArray(d.scenes) ? d.scenes : [] }; } catch { return { version: 1, scenes: [] }; } }
function save(file, index) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(index, null, 2)); fs.renameSync(tmp, file); }
module.exports = { terms, search, indexMedia, load, save };
