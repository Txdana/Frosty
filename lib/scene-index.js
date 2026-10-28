// Persistent scene-level index for local video retrieval. Ranking uses BM25-style
// lexical relevance, phrase matches and exact-token boosts; optional AI captions
// optionally enrich it with embeddings; hybrid search falls back to lexical ranking when embeddings are unavailable.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const terms = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).map(x => x.trim()).filter(x => x.length > 1).map(x => x.length > 5 && x.endsWith('s') ? x.slice(0, -1) : x);
const fingerprint = (src) => {
  try { const st = fs.statSync(src); return `${path.resolve(src)}|${st.size}|${Math.trunc(st.mtimeMs)}`; }
  catch { return path.resolve(src); }
};
const key = (src, start, end, sourceFingerprint = fingerprint(src)) => crypto.createHash('sha256').update(`${sourceFingerprint}|${start.toFixed(3)}|${end.toFixed(3)}`).digest('hex').slice(0, 40);
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return null;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]), y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y; aa += x * x; bb += y * y;
  }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : null;
}
async function ollamaEmbedding(text, { endpoint = 'http://127.0.0.1:11434/api/embed', model = 'nomic-embed-text', timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Math.min(30000, timeoutMs)));
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input: String(text || '').slice(0, 12000) }), signal: controller.signal });
    if (!response.ok) throw new Error(`Embedding service returned HTTP ${response.status}`);
    const payload = await response.json();
    const vector = Array.isArray(payload.embeddings) ? payload.embeddings[0] : payload.embedding;
    if (!Array.isArray(vector) || vector.length < 8 || !vector.every(Number.isFinite)) throw new Error('Embedding service returned an invalid vector');
    return vector;
  } finally { clearTimeout(timer); }
}
async function searchHybrid(index, query, limit = 20, { embed = null, semanticWeight = 0.62 } = {}) {
  const lexical = search(index, query, Math.max(200, Math.min(2000, (index?.scenes || []).length || 200)));
  if (typeof embed !== 'function' || !String(query || '').trim()) return lexical.slice(0, Math.max(1, Math.min(200, Number(limit) || 20)));
  let queryVector;
  try { queryVector = await embed(query); } catch { return lexical.slice(0, Math.max(1, Math.min(200, Number(limit) || 20))); }
  const byKey = new Map(lexical.map((item) => [item.key, item]));
  const scenes = Array.isArray(index?.scenes) ? index.scenes : [];
  const lexicalMax = Math.max(1, ...lexical.map((x) => x.score || 0));
  const ranked = scenes.map((scene) => {
    const sem = cosineSimilarity(queryVector, scene.embedding);
    const lex = byKey.get(scene.key);
    if (sem === null && !lex) return null;
    const normalizedLex = lex ? lex.score / lexicalMax : 0;
    const normalizedSemantic = sem === null ? 0 : Math.max(0, Math.min(1, (sem + 1) / 2));
    const weight = sem === null ? 0 : Math.max(0, Math.min(1, semanticWeight));
    return { ...(lex || scene), score: +((normalizedSemantic * weight + normalizedLex * (1 - weight))).toFixed(5), semanticScore: sem === null ? null : +sem.toFixed(5), matchType: sem === null ? 'lexical' : (lex ? 'semantic+lexical' : 'semantic') };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.start - b.start);
  return ranked.slice(0, Math.max(1, Math.min(200, Number(limit) || 20)));
}
function search(index, query, limit = 20) {
  const rawQuery = String(query || '').trim().toLowerCase();
  const q = [...new Set(terms(rawQuery))];
  if (!q.length) return [];
  const docs = (Array.isArray(index?.scenes) ? index.scenes : []).filter(s => s && typeof s === 'object').map(s => { const tags = Array.isArray(s.tags) ? s.tags.join(' ') : String(s.tags || ''); const text = `${s.name || ''} ${s.caption || ''} ${s.transcript || ''} ${tags}`; return { s, body: text.toLowerCase(), tokens: terms(text) }; });
  const n = Math.max(1, docs.length), avgdl = docs.reduce((a,d)=>a+d.tokens.length,0) / n || 1;
  const df = new Map(q.map(t => [t, docs.filter(d => d.tokens.includes(t)).length]));
  return docs.map(({s, body, tokens}) => {
    let score = 0;
    for (const t of q) {
      const tf = tokens.filter(x=>x===t).length;
      if (!tf) continue;
      const idf = Math.log(1 + (n - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
      score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * tokens.length / avgdl));
    }
    const phrase = rawQuery.length > 2 && body.includes(rawQuery) ? 1.5 : 0;
    const titleBoost = q.some(t => terms(s.name).includes(t)) ? 0.3 : 0;
    const captionBoost = q.some(t => terms(s.caption).includes(t)) ? 0.25 : 0;
    const scoreRaw = score + phrase + titleBoost + captionBoost;
    return { ...s, scene_key: s.key, score: +scoreRaw.toFixed(4), matchType: phrase ? 'phrase+lexical' : 'lexical' };
  }).filter(s => s.score > 0).sort((a,b) => b.score-a.score || a.start-b.start).slice(0, Math.max(1, Math.min(200, Number(limit) || 20)));
}
async function indexMedia({ src, media, ff, transcribe, caption, embed = null, indexFile, onProgress = () => {} }) {
  if (!src || !fs.existsSync(src)) throw new Error(`Cannot index missing media: ${src || '(empty path)'}`);
  const index = load(indexFile);
  const sourceId = fingerprint(src);
  // Remove stale records for the same path after its contents/size/timestamp change.
  const resolved = path.resolve(src);
  index.scenes = index.scenes.filter(s => path.resolve(s.src || '') !== resolved || s.sourceFingerprint === sourceId);
  const existing = new Map(index.scenes.map((s) => [s.key, s]));
  const meta = media || await ff.probe(src);
  if (!meta.hasVideo) return { index, added: 0, skipped: 'no-video' };
  const sceneEvents = typeof ff.detectSceneEvents === 'function'
    ? await ff.detectSceneEvents(src, 0.28)
    : (await ff.detectScenes(src, 0.28)).map(time => ({ time, score: null, confidence: 'low' }));
  const validEvents = sceneEvents.filter(event => Number.isFinite(event.time) && event.time > 0.15 && event.time < meta.duration - 0.15).sort((a, b) => a.time - b.time);
  const cuts = validEvents.map(event => event.time);
  const points = [0, ...cuts, meta.duration].sort((a,b)=>a-b);
  const spans = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i], end = points[i + 1];
    if (end - start >= 0.35) spans.push({ start: +start.toFixed(3), end: +end.toFixed(3) });
  }
  let transcript = [];
  if (meta.hasAudio && transcribe) {
    try { const raw = await transcribe(src); transcript = Array.isArray(raw) ? raw.map(x => typeof x === 'string' ? { start: 0, end: meta.duration, text: x } : x).filter(x => x && typeof x.text === 'string') : []; }
    catch { transcript = []; }
  }
  const dir = path.join(path.dirname(indexFile), 'scene-frames'); fs.mkdirSync(dir, { recursive: true });
  let added = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i], k = key(src, span.start, span.end, sourceId);
    const prior = existing.get(k);
    if (prior && (!caption || prior.caption) && (!meta.hasAudio || !transcribe || Array.isArray(prior.transcriptSegments)) && (typeof embed !== 'function' || Array.isArray(prior.embedding))) continue;
    const frame = prior?.frame || path.join(dir, `${k}.jpg`);
    if (!fs.existsSync(frame)) await ff.thumb(src, frame, Math.min(span.end - 0.05, span.start + (span.end-span.start)/2)).catch(() => {});
    const matchingSegments = transcript.filter(t => Number(t.end) > span.start && Number(t.start) < span.end).map(t => ({ start: Math.max(span.start, Number(t.start)||span.start), end: Math.min(span.end, Number(t.end)||span.end), text: String(t.text || '').trim() })).filter(t=>t.text);
    const words = matchingSegments.map(t => t.text).join(' ');
    let description = prior?.caption || '';
    if (!description && caption && fs.existsSync(frame)) description = await caption(frame).catch(() => '');
    const record = { key: k, sourceFingerprint: sourceId, src: path.resolve(src), name: meta.name || path.basename(src), start: span.start, end: span.end,
      duration: +(span.end - span.start).toFixed(3), frame, transcript: words || prior?.transcript || '', transcriptSegments: matchingSegments, caption: description,
      tags: [...new Set(terms(`${meta.name || path.basename(src)} ${description} ${words}`))].slice(0, 80), indexedAt: new Date().toISOString(),
      boundaryScore: validEvents.find(event => Math.abs(event.time - span.start) <= 0.004)?.score ?? null,
      detectionThreshold: 0.28,
      confidence: { boundaries: span.start <= 0 ? 'high' : (validEvents.find(event => Math.abs(event.time - span.start) <= 0.004)?.confidence || 'low'), transcript: matchingSegments.length ? 'source-transcript' : 'unavailable', visualDescription: description ? (caption ? 'ai-caption' : 'existing-caption') : 'unavailable' } };
    if (typeof embed === 'function') {
      try {
        const vector = await embed(`${record.name}. ${record.caption || ''}. ${record.transcript || ''}. ${(record.tags || []).join(' ')}`);
        if (Array.isArray(vector) && vector.length >= 8 && vector.every(Number.isFinite)) record.embedding = vector;
      } catch { /* Semantic indexing is optional; lexical indexing must still succeed offline. */ }
    }
    if (prior) Object.assign(prior, record); else { index.scenes.push(record); existing.set(k, record); }
    added++; onProgress({ current: i + 1, total: spans.length, added });
  }
  index.version = 2; index.updatedAt = new Date().toISOString();
  save(indexFile, index);
  return { index, added, totalSpans: spans.length, sourceFingerprint: sourceId };
}
function load(file) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return { version: d.version || 1, scenes: Array.isArray(d.scenes) ? d.scenes : [], updatedAt: d.updatedAt || null }; }
  catch { return { version: 2, scenes: [] }; }
}
function save(file, index) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(file, { force: true }); } catch {} fs.renameSync(tmp, file); }
}
module.exports = { terms, fingerprint, key, search, searchHybrid, cosineSimilarity, ollamaEmbedding, indexMedia, load, save };
