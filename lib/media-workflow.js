'use strict';
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const TL = require('./timeline');

const uid = (prefix = 'id') => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
function walkMediaRefs(project, visit) {
  const seen = new Set();
  const walk = (tl) => {
    if (!tl || typeof tl !== 'object' || seen.has(tl)) return;
    seen.add(tl);
    for (const key of ['video', 'layers', 'audio']) for (const item of tl[key] || []) if (item && typeof item.src === 'string') visit(item, key, tl);
    if (tl.music && typeof tl.music.src === 'string') visit(tl.music, 'music', tl);
    for (const seq of Object.values(tl.sequences || {})) walk(seq);
  };
  walk(project.tl || project.timeline || project);
  for (const seq of Object.values(project.sequences || {})) walk(seq);
}
function relinkMedia(project, mapping, { verify = true } = {}) {
  if (!project || typeof project !== 'object') throw new TypeError('A project/timeline object is required');
  if (!mapping || typeof mapping !== 'object') throw new TypeError('A source-to-path mapping is required');
  const changes = [], missing = [];
  walkMediaRefs(project, (item, kind) => {
    const old = item.src; const next = mapping[old] ?? mapping[path.basename(old)];
    if (next) {
      if (verify && !fs.existsSync(next)) { missing.push({ source: old, target: next, kind }); return; }
      item.src = path.resolve(next); if (item.proxySrc) item.proxyEnabled = false; changes.push({ from: old, to: item.src, kind });
    } else if (verify && !fs.existsSync(old)) missing.push({ source: old, kind });
  });
  for (const item of project.media || []) {
    if (!item || typeof item.path !== 'string') continue;
    const next = mapping[item.path] ?? mapping[path.basename(item.path)];
    if (next && (!verify || fs.existsSync(next))) { changes.push({ from: item.path, to: path.resolve(next), kind: 'media-bin' }); item.path = path.resolve(next); }
  }
  return { changed: changes.length, changes, missing };
}
function createSequence(project, name = 'Sequence', timeline = null) {
  project.sequences ||= {};
  const id = uid('seq');
  const seq = timeline ? TL.ensure(TL.clone(timeline)) : TL.empty();
  seq.id = id; seq.name = String(name || 'Sequence').slice(0, 120); seq.sequences ||= {};
  project.sequences[id] = seq;
  return seq;
}
function sequenceGraph(project) { return { ...(project.sequences || project.tl?.sequences || {}), ...(project.tl ? { root: project.tl } : {}) }; }
function canNest(project, parentId, childId) {
  const graph = sequenceGraph(project); if (!graph[parentId] || !graph[childId] || parentId === childId) return false;
  const visit = (id, seen = new Set()) => {
    if (id === parentId) return true;
    if (seen.has(id)) return false; seen.add(id);
    const seq = graph[id]; if (!seq) return false;
    return (seq.video || []).some(c => c.sequenceId && visit(c.sequenceId, seen));
  };
  return !visit(childId);
}
function addNestedSequence(project, parentId, childId, start = 0) {
  const graph = sequenceGraph(project); const parent = parentId === 'root' ? project.tl : graph[parentId], child = graph[childId];
  if (!parent || !child) throw new Error('Parent or nested sequence was not found');
  if (!canNest(project, parentId, childId)) throw new Error('Nested sequences cannot contain themselves or create a cycle');
  const duration = TL.duration(child); if (!(duration > 0)) throw new Error('Cannot nest an empty sequence');
  parent.video ||= [];
  const clip = { id: uid('nested'), type: 'sequence', sequenceId: childId, src: '', name: child.name || 'Nested sequence', in: 0, out: duration, start: Math.max(0, Number(start) || 0), speed: 1, track: 1, hasAudio: true, volume: 1, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alpha: 1 }, fx: {}, keyframes: {} };
  parent.video.push(clip); parent.mode = 'free'; return clip;
}
function validateTimeline(tl) {
  const errors = [], warnings = [], ids = new Set();
  if (!tl || typeof tl !== 'object') return { valid: false, errors: ['Timeline must be an object'], warnings };
  if (tl.mode != null && !['free', 'sequential'].includes(tl.mode)) errors.push(`Unknown timeline mode: ${tl.mode}`);
  for (const key of ['video', 'layers', 'audio', 'text']) {
    if (tl[key] != null && !Array.isArray(tl[key])) { errors.push(`${key} must be an array`); continue; }
    for (const item of tl[key] || []) {
      if (!item || typeof item !== 'object') { errors.push(`${key} contains an invalid item`); continue; }
      if (!item.id) warnings.push(`${key} item has no stable ID`);
      else if (ids.has(item.id)) errors.push(`Duplicate item id: ${item.id}`); else ids.add(item.id);
      if (['video', 'layers', 'audio'].includes(key) && item.type !== 'sequence' && typeof item.src !== 'string') errors.push(`${key} item ${item.id || '(unnamed)'} has no source`);
      if (key === 'video' && item.type === 'sequence' && !item.sequenceId) errors.push(`Nested sequence clip ${item.id || '(unnamed)'} has no sequence reference`);
      if (key === 'video' && !(Number(item.out) > Number(item.in))) errors.push(`Clip ${item.id || '(unnamed)'} has invalid source range`);
      if (['layers', 'audio'].includes(key) && item.in != null && item.out != null && !(Number(item.out) > Number(item.in))) errors.push(`${key} item ${item.id || '(unnamed)'} has invalid source range`);
      const start = item.start == null && key === 'video' && tl.mode !== 'free' ? 0 : Number(item.start ?? 0);
      if (!Number.isFinite(start) || start < 0) errors.push(`${key} item ${item.id || '(unnamed)'} has invalid timeline start`);
      if (key === 'text' && (!Number.isFinite(Number(item.dur)) || Number(item.dur) <= 0)) errors.push(`Text item ${item.id || '(unnamed)'} has invalid duration`);
      if (item.track != null && (!Number.isInteger(Number(item.track)) || Number(item.track) < 1 || (Number(tl.trackCount) > 0 && Number(item.track) > Number(tl.trackCount)))) errors.push(`Item ${item.id || '(unnamed)'} has invalid track`);
    }
  }
  if (tl.settings && (!Number.isFinite(+tl.settings.width) || !Number.isFinite(+tl.settings.height) || +tl.settings.width < 16 || +tl.settings.height < 16)) errors.push('Invalid project dimensions');
  if (tl.settings?.frameRate) {
    const fps = Number(tl.settings.frameRate.numerator) / Number(tl.settings.frameRate.denominator);
    if (!Number.isFinite(fps) || fps <= 0 || fps > 240) errors.push('Invalid project frame rate');
  }
  if (tl.mode === 'free') {
    try { for (const item of TL.layout(tl)) if (!Number.isFinite(item.start) || item.start < 0 || !Number.isFinite(item.end) || item.end <= item.start) errors.push(`Invalid timing for clip ${item.clip.id || '(unnamed)'}`); }
    catch (e) { errors.push(`Could not calculate timeline layout: ${e.message}`); }
  }
  if (!tl.settings) warnings.push('Project settings are missing and will use defaults');
  if (!Array.isArray(tl.video) || !tl.video.length) warnings.push('Timeline has no video clips');
  return { valid: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
function repairTimeline(tl) {
  const report = { removed: [], adjusted: [] }; TL.ensure(tl);
  for (const key of ['video', 'layers', 'audio', 'text']) {
    const used = new Set();
    tl[key] = (tl[key] || []).filter((item) => {
      if (!item || typeof item !== 'object') { report.removed.push(`${key}: invalid item`); return false; }
      if (item.id && used.has(item.id)) { report.removed.push(`${key}: duplicate ${item.id}`); return false; }
      if (item.id) used.add(item.id);
      if (key === 'video' && item.type !== 'sequence' && !item.src) { report.removed.push(`${key}: missing source`); return false; }
      if (key === 'video' && !(Number(item.out) > Number(item.in))) { item.in = Math.max(0, Number(item.in) || 0); item.out = item.in + 0.1; report.adjusted.push(`${item.id}: repaired source range`); }
      if (item.track != null) item.track = Math.max(1, Math.trunc(Number(item.track) || 1));
      return true;
    });
  }
  return { report, validation: validateTimeline(tl) };
}
async function createProxy(source, output, ffmpeg, { width = 640, height = 360, crf = 28 } = {}) {
  if (!fs.existsSync(source)) throw new Error(`Source media does not exist: ${source}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temp = `${output}.partial-${process.pid}.mp4`;
  try {
    await ffmpeg.run(['-y', '-i', source, '-map', '0:v:0', '-map', '0:a?', '-vf', `scale='min(${Math.max(16, Math.round(width / 2) * 2)},iw)':'min(${Math.max(16, Math.round(height / 2) * 2)},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(Math.max(18, Math.min(40, Math.round(crf)))), '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', temp]);
    fs.renameSync(temp, output); return { source: path.resolve(source), proxy: path.resolve(output), size: fs.statSync(output).size };
  } catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}
function findRelinkCandidates(project, rootDir) {
  const files = [];
  const walk = (dir) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mp4|mov|mkv|webm|avi|m4v|mp3|wav|m4a|aac|png|jpe?g|webp)$/i.test(entry.name)) files.push(full);
    }
  };
  walk(rootDir);
  const byName = new Map();
  for (const file of files) { const key = path.basename(file).toLowerCase(); if (!byName.has(key)) byName.set(key, []); byName.get(key).push(file); }
  const refs = [];
  walkMediaRefs(project, (item, kind) => { if (item.src && !fs.existsSync(item.src)) refs.push({ source: item.src, basename: path.basename(item.src), kind, candidates: byName.get(path.basename(item.src).toLowerCase()) || [] }); });
  for (const item of project.media || []) if (item?.path && !fs.existsSync(item.path)) refs.push({ source: item.path, basename: path.basename(item.path), kind: 'media-bin', candidates: byName.get(path.basename(item.path).toLowerCase()) || [] });
  const mapping = {};
  const ambiguous = [];
  for (const ref of refs) if (ref.candidates.length === 1) mapping[ref.source] = ref.candidates[0]; else if (ref.candidates.length > 1) ambiguous.push(ref);
  return { mapping, missing: refs.filter(r => !r.candidates.length), ambiguous, scanned: files.length };
}

function setProxy(item, proxyPath, enabled = true) {
  if (!item || typeof item !== 'object' || !item.src) throw new Error('Select a media item with an original source first');
  if (!fs.existsSync(proxyPath)) throw new Error(`Proxy file does not exist: ${proxyPath}`);
  item.proxySrc = path.resolve(proxyPath); item.proxyEnabled = !!enabled;
  return { source: item.src, proxy: item.proxySrc, enabled: item.proxyEnabled };
}

module.exports = { relinkMedia, findRelinkCandidates, createSequence, canNest, addNestedSequence, validateTimeline, repairTimeline, createProxy, setProxy, walkMediaRefs };
