/* Frosty renderer */
const TL = window.FrostyTimeline;
const $ = (id) => document.getElementById(id);
const S = { media: [], sequences: {}, mainTimeline: null, editingSequenceId: null, tl: TL.empty(), sel: null, t: 0, playing: false, pps: 60, undo: [], redo: [], cur: null, busy: false, hist: [], models: [], targetTrack: 2, motionEditTarget: null, previewToken: 0, previewTimer: null, bragScenes: [], bragSoundtrack: '', bragName: '', bragTagline: '', bragFeatures: [] };

const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
const fileUrl = (p) => 'file:///' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23');
const log = (m) => { const l = $('log'); l.textContent = m + '\n' + l.textContent; };
const status = (m) => ($('status').textContent = m || '');

function commit() { if (S.playing) stopTimelinePlayback(false); S.previewRenderToken++; window.frosty.cancelPreviewMovie?.(); S.previewMovieKey = ''; S.undo.push(JSON.stringify(S.tl)); if (S.undo.length > 100) S.undo.shift(); S.redo = []; }
function undo() { if (!S.undo.length) return; S.redo.push(JSON.stringify(S.tl)); S.tl = JSON.parse(S.undo.pop()); renderAll(); }
function redo() { if (!S.redo.length) return; S.undo.push(JSON.stringify(S.tl)); S.tl = JSON.parse(S.redo.pop()); renderAll(); }
async function call(p) { const r = await p; if (!r.ok) throw new Error(r.error); return r.data; }
async function guard(fn) { if (S.busy) return; S.busy = true; try { await fn(); } catch (e) { log('⚠ ' + e.message); status(''); } finally { S.busy = false; } }

// ---------- rendering ----------
function decorate(m) {
  if (m.thumb !== undefined) return; m.thumb = null;
  call(window.frosty.assets(m.path)).then((r) => { m.thumb = r.thumb; m.wave = r.wave; renderAll(); }).catch(() => {});
}
function renderMusicMixer() {
  const host = $('musicMixer'); if (!host) return;
  host.textContent = '';
  const music = S.tl.music;
  if (!music?.src) return;
  const title = document.createElement('strong'); title.textContent = 'Music track mixer'; host.append(title);
  const addNumber = (labelText, key, min, max, step, fallback) => {
    const label = document.createElement('label'); label.textContent = labelText;
    const input = document.createElement('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step; input.value = music[key] ?? fallback;
    input.onchange = () => { commit(); music[key] = Math.max(min, Math.min(max, Number(input.value) || 0)); renderAll(); };
    label.append(input); host.append(label);
  };
  addNumber('Volume (0–2)', 'volume', 0, 2, 0.05, 0.25);
  addNumber('Gain (dB)', 'gainDb', -36, 24, 0.5, 0);
  addNumber('Balance (−1…+1)', 'pan', -1, 1, 0.1, 0);
  addNumber('Bass shelf (dB)', 'lowShelfDb', -18, 18, 1, 0);
  addNumber('Treble shelf (dB)', 'highShelfDb', -18, 18, 1, 0);
  addNumber('Fade in (s)', 'fadeIn', 0, 120, 0.1, 0);
  addNumber('Fade out (s)', 'fadeOut', 0, 120, 0.1, 0);
  const row = document.createElement('label'); row.className = 'chk'; const comp = document.createElement('input'); comp.type = 'checkbox'; comp.checked = !!music.compressor; comp.onchange = () => { commit(); music.compressor = comp.checked; renderAll(); }; row.append(comp, ' Compressor'); host.append(row);
  const clear = document.createElement('button'); clear.className = 'small'; clear.textContent = 'Remove music'; clear.onclick = () => { commit(); S.tl.music = null; renderAll(); }; host.append(clear);
}

function renderBin() {
  const l = $('binList'); l.textContent = '';
  S.media.forEach((m) => {
    decorate(m);
    const d = document.createElement('div'); d.className = 'item'; d.title = S.tl.mode === 'free' ? 'Click: add at playhead on main track' : 'Click: append to main track';
    const a = document.createElement('span'); a.className = 'nm2';
    if (m.thumb) { const im = document.createElement('img'); im.src = fileUrl(m.thumb); a.append(im); }
    a.append(m.name);
    const b = document.createElement('span'); b.className = 'muted'; b.textContent = m.type === 'image' ? 'img' : fmt(m.duration);
    const mk = (txt, tip, fn) => { const x = document.createElement('button'); x.className = 'small mini'; x.textContent = txt; x.title = tip; x.onclick = (e) => { e.stopPropagation(); commit(); fn(); renderAll(); }; return x; };
    d.append(a, b, mk('PiP', 'Add as overlay layer at playhead', () => { const ly = TL.addLayer(S.tl, m, S.t, S.targetTrack); S.sel = ly.id; }), mk('♪', 'Add to audio track at playhead', () => { const au = TL.addAudio(S.tl, m, S.t); S.sel = au.id; }));
    d.onclick = () => { commit(); const c = TL.addClip(S.tl, m); if (S.tl.mode === 'free') c.start = S.t; renderAll(); };
    l.append(d);
  });
}

// Drag helper: onMove(state, dtSeconds) while the mouse is down; one undo step per drag.
function dragTL(el, onStart, onMove) {
  el.onmousedown = (e) => {
    e.stopPropagation(); e.preventDefault();
    const x0 = e.clientX; commit(); const st = onStart();
    const mv = (ev) => { onMove(st, (ev.clientX - x0) / S.pps); renderTimeline(); };
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); renderAll(); };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  };
}
// Snap to playhead / clip edges (Shotcut-style) when within ~8px.
function snap(t) {
  const pts = [S.t, 0, ...TL.layout(S.tl).flatMap((i) => [i.start, i.end])];
  const best = pts.reduce((b, p) => (Math.abs(p - t) < Math.abs(b - t) ? p : b), Infinity);
  return Math.abs(best - t) * S.pps < 8 ? best : t;
}
const mediaOf = (src) => S.media.find((m) => m.path === src);
function bgLayers(el, src) {
  const m = mediaOf(src); if (!m) return;
  if (m.thumb) { const t = document.createElement('div'); t.className = 'th'; t.style.backgroundImage = `url("${fileUrl(m.thumb)}")`; el.append(t); }
  if (m.wave) { const w = document.createElement('div'); w.className = 'wv'; w.style.backgroundImage = `url("${fileUrl(m.wave)}")`; el.append(w); }
}
function label(el, txt) { const n = document.createElement('span'); n.className = 'nm'; n.textContent = txt; el.append(n); }

function renderTimeline() {
  TL.ensure(S.tl);
  $('bTimelineMode').textContent = S.tl.mode === 'free' ? 'Use sequential mode' : 'Enable free timeline';
  $('timelineModeHelp').textContent = S.tl.mode === 'free' ? 'Free timeline · drag main clips horizontally; overlaps are composited.' : 'Sequential edit mode · select a track row, then use PiP to add overlays.';
  const dur = Math.max(TL.duration(S.tl), 10), w = (dur + 5) * S.pps;
  $('tl').style.width = w + 'px';
  const ruler = $('ruler'); ruler.textContent = '';
  const step = S.pps >= 100 ? 1 : S.pps >= 40 ? 5 : 10;
  for (let t = 0; t < dur + 5; t += step) { const k = document.createElement('div'); k.className = 'tick'; k.style.left = t * S.pps + 'px'; k.textContent = fmt(t); ruler.append(k); }
  const place = (c, start, d) => { c.style.left = start * S.pps + 'px'; c.style.width = Math.max(4, d * S.pps - 2) + 'px'; };
  const mkHandles = (c, onL, onR) => { const r = document.createElement('div'); r.className = 'hdl r'; onR(r); if (onL) { const l = document.createElement('div'); l.className = 'hdl l'; onL(l); c.append(l); } c.append(r); };

  TL.ensure(S.tl);
  const tracksHost = $('videoTracks'); tracksHost.textContent = '';
  for (let track = S.tl.trackCount; track >= 2; track--) {
    const row = document.createElement('div'); row.className = 'video-track-row';
    const state = S.tl.trackState[String(track)] || { visible: true, muted: false, locked: false };
    const controls = document.createElement('div'); controls.className = 'track-controls';
    const head = document.createElement('button'); head.className = 'track-target small' + (S.targetTrack === track ? ' active' : ''); head.textContent = state.name || `V${track}`; head.title = 'Set target track for new PiP clips';
    head.onclick = () => { S.targetTrack = track; renderTimeline(); };
    const control = (txt, tip, key, value) => { const b = document.createElement('button'); b.className = 'small mini track-toggle' + (value ? ' active' : ''); b.textContent = txt; b.title = tip; b.onclick = (e) => { e.stopPropagation(); commit(); TL.setTrackState(S.tl, track, { [key]: !value }); renderAll(); }; return b; };
    controls.append(head, control(state.visible === false ? '○' : '◉', 'Toggle track visibility in preview/export', 'visible', state.visible !== false), control(state.muted ? '🔇' : '♪', 'Mute/unmute this track audio', 'muted', !!state.muted), control(state.locked ? '🔒' : '🔓', 'Lock/unlock track editing', 'locked', !!state.locked));
    const del = document.createElement('button'); del.className = 'small mini danger'; del.textContent = '×'; del.title = 'Delete track and its overlays'; del.onclick = (e) => { e.stopPropagation(); if (!confirm(`Delete V${track} and all clips on it?`)) return; commit(); const r = TL.deleteVideoTrack(S.tl, track); if (S.targetTrack >= track) S.targetTrack = Math.max(2, S.targetTrack - 1); log(`Deleted V${track} (${r.removed} clips removed)`); renderAll(); }; controls.append(del);
    const rename = document.createElement('button'); rename.className = 'small mini'; rename.textContent = '✎'; rename.title = 'Rename track'; rename.onclick = (e) => { e.stopPropagation(); const name = prompt('Track name', state.name || `V${track}`); if (name == null || !name.trim()) return; commit(); TL.setTrackState(S.tl, track, { name: name.trim().slice(0, 64) }); renderAll(); }; controls.append(rename);
    for (const [txt, to] of [['↑', track + 1], ['↓', track - 1]]) { const move = document.createElement('button'); move.className = 'small mini'; move.textContent = txt; move.title = `Move track to V${to}`; move.disabled = to < 2 || to > S.tl.trackCount; move.onclick = (e) => { e.stopPropagation(); commit(); TL.reorderVideoTrack(S.tl, track, to); if (S.targetTrack === track) S.targetTrack = to; else if (S.targetTrack === to) S.targetTrack = track; renderAll(); }; controls.append(move); }
    row.append(controls);
    const lane = document.createElement('div'); lane.className = 'trk l' + (state.visible === false ? ' track-hidden' : '') + (state.locked ? ' track-locked' : ''); lane.dataset.track = String(track);
    lane.onclick = () => { S.targetTrack = track; renderTimeline(); };
    (S.tl.layers || []).filter((o) => (Number(o.track) || 2) === track).forEach((o) => {
      const c = document.createElement('div'); c.className = 'clip lay' + (S.sel === o.id ? ' sel' : '');
      place(c, o.start, o.out - o.in); bgLayers(c, o.src); label(c, o.name);
      c.onclick = (e) => { e.stopPropagation(); S.sel = o.id; S.targetTrack = track; renderAll(); };
      if (!state.locked) { dragTL(c, () => ({ s: o.start }), (st, dt) => { o.start = Math.max(0, snap(st.s + dt)); });
      mkHandles(c, (h) => dragTL(h, () => ({ i: o.in }), (st, dt) => { o.in = Math.max(0, Math.min(st.i + dt, o.out - 0.1)); }), (h) => dragTL(h, () => ({ d: o.out - o.in }), (st, dt) => { o.out = Math.max(o.in + 0.1, st.d + dt + o.in); })); }
      lane.append(c);
    });
    if (S.tl.mode === 'free') TL.layout(S.tl).filter((i) => (Number(i.clip.track) || 1) === track).forEach(({ clip, start, end }) => {
      const c = document.createElement('div'); c.className = 'clip main-layer-clip' + (S.sel === clip.id ? ' sel' : ''); place(c, start, end - start); bgLayers(c, clip.src); label(c, clip.name);
      c.onclick = (e) => { e.stopPropagation(); S.sel = clip.id; seek(start + 0.01); renderAll(); };
      if (!state.locked) { dragTL(c, () => ({ s: start }), (st, dt) => { clip.start = Math.max(0, snap(st.s + dt)); }); const max = clip.type === 'image' ? 3600 : (mediaOf(clip.src)?.duration || 3600), sp = clip.speed || 1; mkHandles(c, (h) => dragTL(h, () => ({ i: clip.in }), (st, dt) => { clip.in = Math.max(0, Math.min(st.i + dt * sp, clip.out - 0.1)); }), (h) => dragTL(h, () => ({ o: clip.out }), (st, dt) => { clip.out = Math.max(clip.in + 0.1, Math.min(st.o + dt * sp, max)); })); }
      lane.append(c);
    });
    row.append(lane); tracksHost.append(row);
  }
  const mainState = S.tl.trackState['1'] || { name: 'V1 · Main', visible: true, muted: false, locked: false };
  const mainHead = $('mainTrackHead'); mainHead.textContent = ''; const mainLabel = document.createElement('button'); mainLabel.className = 'track-target small'; mainLabel.textContent = mainState.name || 'V1 · Main'; mainHead.append(mainLabel);
  const mainControl = (txt, tip, key, value) => { const b = document.createElement('button'); b.className = 'small mini track-toggle' + (value ? ' active' : ''); b.textContent = txt; b.title = tip; b.onclick = () => { commit(); TL.setTrackState(S.tl, 1, { [key]: !value }); renderAll(); }; return b; };
  mainHead.append(mainControl(mainState.visible === false ? '○' : '◉', 'Toggle main track visibility in preview/export', 'visible', mainState.visible !== false), mainControl(mainState.muted ? '🔇' : '♪', 'Mute/unmute main-track audio', 'muted', !!mainState.muted), mainControl(mainState.locked ? '🔒' : '🔓', 'Lock/unlock main-track editing', 'locked', !!mainState.locked));
  const v = $('trkV'); v.textContent = ''; v.classList.toggle('track-hidden', mainState.visible === false); v.classList.toggle('track-locked', !!mainState.locked);
  TL.layout(S.tl).filter((i) => (Number(i.clip.track) || 1) === 1).forEach(({ clip, start, end }) => {
    const c = document.createElement('div'); c.className = 'clip' + (S.sel === clip.id ? ' sel' : '') + (mainState.locked ? ' clip-locked' : '');
    place(c, start, end - start); bgLayers(c, clip.src);
    if (S.tl.mode === 'free' && !mainState.locked) dragTL(c, () => ({ s: start }), (st, dt) => { clip.start = Math.max(0, snap(st.s + dt)); });
    label(c, clip.name + (clip.zoom > 1 ? `  ×${clip.zoom}` : '') + (clip.speed && clip.speed !== 1 ? `  ${clip.speed}×` : '') + (clip.trans ? '  ⇄' : ''));
    c.onclick = (e) => { e.stopPropagation(); S.sel = clip.id; seek(start + 0.01); renderAll(); };
    const max = clip.type === 'image' ? 3600 : (mediaOf(clip.src)?.duration || 3600), sp = clip.speed || 1;
    if (!mainState.locked) mkHandles(c,
      (h) => dragTL(h, () => ({ i: clip.in }), (st, dt) => { clip.in = Math.max(0, Math.min(st.i + dt * sp, clip.out - 0.1)); }),
      (h) => dragTL(h, () => ({ o: clip.out }), (st, dt) => { clip.out = Math.max(clip.in + 0.1, Math.min(st.o + dt * sp, max)); }));
    v.append(c);
  });

  const lane = (id, items, cls, getDur, setDur, name, wave) => {
    const el = $(id); el.textContent = '';
    items.forEach((o) => {
      const c = document.createElement('div'); c.className = 'clip ' + cls + (S.sel === o.id ? ' sel' : '');
      place(c, o.start, getDur(o)); if (wave) bgLayers(c, o.src); label(c, name(o));
      c.onclick = (e) => { e.stopPropagation(); S.sel = o.id; renderAll(); };
      dragTL(c, () => { S.sel = o.id; return { s: o.start }; }, (st, dt) => { o.start = Math.max(0, snap(st.s + dt)); });
      mkHandles(c, null, (h) => dragTL(h, () => ({ d: getDur(o) }), (st, dt) => setDur(o, Math.max(0.1, st.d + dt))));
      el.append(c);
    });
  };
  lane('trkA', S.tl.audio, 'aud', (o) => o.out - o.in, (o, d) => (o.out = o.in + d), (o) => '♪ ' + o.name, true);
  lane('trkT', S.tl.text, 'txt', (o) => o.dur, (o, d) => (o.dur = d), (o) => o.text, false);
  moveHead();
}

function moveHead() { $('head').style.left = S.t * S.pps + 'px'; const frame = TL.secondsToFrame(S.t, S.tl); $('tc').textContent = `${fmt(S.t)} · F${String(frame).padStart(6, '0')} / ${fmt(TL.duration(S.tl))}`; }

function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
function clampMaskValue(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function ensureBezierMask(mask) {
  const BM = window.FrostyBezierMask;
  mask.enabled = mask.enabled !== false;
  mask.shape = 'bezier';
  if (!Array.isArray(mask.nodes) || mask.nodes.length < 3) {
    mask.nodes = mask.shape === 'bezier' && Array.isArray(mask.points) && mask.points.length >= 3
      ? BM.polygonToNodes(mask.points)
      : BM.defaultBezierNodes();
  }
  mask.nodes = BM.normalizeNodes(mask.nodes);
  mask.pathKeyframes = Array.isArray(mask.pathKeyframes) ? mask.pathKeyframes : [];
  return mask;
}
function splitBezierSegment(nodes, index, amount) {
  const n = nodes.map((v) => cloneJson(v));
  const nextIndex = (index + 1) % n.length;
  const a = n[index], b = n[nextIndex], t = Math.max(.02, Math.min(.98, amount));
  const mix = (p, q) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const p0 = { x: a.x, y: a.y }, p1 = { ...a.out }, p2 = { ...b.in }, p3 = { x: b.x, y: b.y };
  const p01 = mix(p0, p1), p12 = mix(p1, p2), p23 = mix(p2, p3);
  const p012 = mix(p01, p12), p123 = mix(p12, p23), anchor = mix(p012, p123);
  n[index].out = p01; n[nextIndex].in = p23;
  const node = { ...anchor, in: p012, out: p123 };
  n.splice(index + 1, 0, node);
  // A segment crossing the closing edge is inserted at the end, preserving segment order.
  return { nodes: n, insertedIndex: index + 1 };
}
function nearestBezierSegment(nodes, p) {
  let best = { distance: Infinity, index: 0, t: .5 };
  const mix = (a, b, t) => a + (b - a) * t;
  const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i], b = nodes[(i + 1) % nodes.length];
    for (let k = 0; k <= 40; k++) {
      const t = k / 40, u = 1 - t;
      const q = { x: u*u*u*a.x + 3*u*u*t*a.out.x + 3*u*t*t*b.in.x + t*t*t*b.x,
        y: u*u*u*a.y + 3*u*u*t*a.out.y + 3*u*t*t*b.in.y + t*t*t*b.y };
      const d = dist2(q, p); if (d < best.distance) best = { distance: d, index: i, t };
    }
  }
  return best;
}
function renderBezierMaskEditor(owner, mask, localStart, title) {
  const BM = window.FrostyBezierMask;
  ensureBezierMask(mask);
  const box = document.createElement('div'); box.className = 'bezier-mask-editor';
  const hint = document.createElement('div'); hint.className = 'muted';
  hint.textContent = 'Drag anchors (large circles) and Bézier handles (small circles). Click the curve to insert an anchor; double-click an anchor to remove it.'; box.append(hint);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 1000 562.5'); svg.setAttribute('preserveAspectRatio', 'xMidYMid meet'); svg.setAttribute('role', 'application'); svg.setAttribute('aria-label', `${title} editor`); svg.classList.add('bezier-mask-canvas');
  box.append(svg);
  const toolbar = document.createElement('div'); toolbar.className = 'row wrap'; box.append(toolbar);
  const interpolation = document.createElement('select'); ['linear', 'bezier', 'constant'].forEach(v => interpolation.add(new Option(`Keyframe: ${v}`, v))); interpolation.value = 'bezier'; toolbar.append(interpolation);
  const add = document.createElement('button'); add.className = 'small'; add.textContent = '+ Anchor'; add.title = 'Adds an anchor by clicking directly on the curve'; toolbar.append(add);
  const remove = document.createElement('button'); remove.className = 'small'; remove.textContent = 'Remove selected'; toolbar.append(remove);
  const keyframe = document.createElement('button'); keyframe.className = 'small'; keyframe.textContent = '◆ Keyframe path'; toolbar.append(keyframe);
  const clearKeys = document.createElement('button'); clearKeys.className = 'small'; clearKeys.textContent = 'Clear path keys'; toolbar.append(clearKeys);
  const info = document.createElement('div'); info.className = 'muted'; box.append(info);
  let selected = 0, drag = null, adding = true; add.classList.add('active');
  const px = p => ({ x: clampMaskValue(p.x) * 1000, y: clampMaskValue(p.y) * 562.5 });
  const toNormal = ev => { const r = svg.getBoundingClientRect(); return { x: clampMaskValue((ev.clientX - r.left) / Math.max(1, r.width)), y: clampMaskValue((ev.clientY - r.top) / Math.max(1, r.height)) }; };
  const nodeForAtTime = () => BM.evaluateNodes(mask, Math.max(0, S.t - localStart));
  const pathData = nodes => BM.toSvgPath(nodes, 1000, 562.5);
  const svgEl = (tag, attrs) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k,v] of Object.entries(attrs)) el.setAttribute(k, String(v)); return el; };
  const draw = () => {
    const nodes = nodeForAtTime(); svg.replaceChildren();
    svg.append(svgEl('path', { d: pathData(nodes), class: 'bezier-mask-fill', 'data-role': 'curve' }));
    nodes.forEach((n, i) => {
      const a = px(n), input = px(n.in), output = px(n.out);
      svg.append(svgEl('line', { x1: a.x, y1: a.y, x2: input.x, y2: input.y, class: 'bezier-handle-line' }));
      svg.append(svgEl('line', { x1: a.x, y1: a.y, x2: output.x, y2: output.y, class: 'bezier-handle-line' }));
      svg.append(svgEl('circle', { cx: input.x, cy: input.y, r: 9, class: 'bezier-handle' , 'data-role': 'in', 'data-node': i }));
      svg.append(svgEl('circle', { cx: output.x, cy: output.y, r: 9, class: 'bezier-handle', 'data-role': 'out', 'data-node': i }));
      svg.append(svgEl('circle', { cx: a.x, cy: a.y, r: 13, class: `bezier-anchor${selected === i ? ' selected' : ''}`, 'data-role': 'anchor', 'data-node': i }));
      const label = svgEl('text', { x: a.x + 15, y: a.y - 14, class: 'bezier-anchor-label', 'pointer-events': 'none' }); label.textContent = String(i + 1); svg.append(label);
    });
    const keys = BM.normalizePathKeyframes(mask);
    info.textContent = `${nodes.length} anchors · ${keys.length} animated path keyframe(s) · playhead ${Math.max(0, S.t - localStart).toFixed(3)}s · normalized frame coordinates`;
    remove.disabled = nodes.length <= 3;
    add.disabled = nodes.length >= BM.MAX_NODES;
    clearKeys.disabled = !keys.length;
  };
  const updateKey = (mask, t, nodes, interpolationName) => {
    const keys = BM.normalizePathKeyframes(mask);
    const key = { t: Math.max(0, t), nodes: cloneJson(nodes), interpolation: interpolationName };
    const at = keys.findIndex(k => Math.abs(k.t - key.t) < 1e-4);
    if (at >= 0) keys[at] = key; else keys.push(key);
    keys.sort((a,b) => a.t - b.t); mask.pathKeyframes = keys;
  };
  const updatePathNode = (index, role, p, shift) => {
    const nodes = mask.nodes; const current = nodes[index];
    if (role === 'anchor') {
      const dx = p.x - current.x, dy = p.y - current.y;
      current.x = p.x; current.y = p.y;
      current.in = { x: clampMaskValue(current.in.x + dx), y: clampMaskValue(current.in.y + dy) };
      current.out = { x: clampMaskValue(current.out.x + dx), y: clampMaskValue(current.out.y + dy) };
    } else {
      current[role] = p;
      if (shift) { const other = role === 'in' ? 'out' : 'in'; current[other] = { x: clampMaskValue(2 * current.x - p.x), y: clampMaskValue(2 * current.y - p.y) }; }
    }
  };
  svg.addEventListener('pointerdown', ev => {
    const target = ev.target; const role = target?.dataset?.role;
    if (role === 'curve') {
      if (!adding) return;
      ev.preventDefault(); const p = toNormal(ev), near = nearestBezierSegment(nodeForAtTime(), p);
      if (near.distance > .012) return;
      commit();
      const t = Math.max(0, S.t - localStart);
      const oldKeys = BM.normalizePathKeyframes(mask);
      const insert = (nodes) => splitBezierSegment(nodes, near.index, near.t).nodes;
      const nextNodes = insert(mask.nodes);
      mask.pathKeyframes = oldKeys.map(k => ({ ...k, nodes: insert(k.nodes) }));
      mask.nodes = nextNodes;
      selected = near.index + 1; renderAll(); return;
    }
    if (!['anchor', 'in', 'out'].includes(role)) return;
    ev.preventDefault(); commit(); selected = Number(target.dataset.node);
    drag = { index: selected, role, shift: ev.shiftKey }; svg.setPointerCapture?.(ev.pointerId); draw();
  });
  svg.addEventListener('pointermove', ev => {
    if (!drag) return; ev.preventDefault(); const index = drag.index;
    const nodes = nodeForAtTime();
    updatePathNode(index, drag.role, toNormal(ev), ev.shiftKey || drag.shift);
    // The editor's base shape is the authoritative pose when not animating; when animated,
    // edits at the playhead edit or create a path keyframe instead of silently moving all time.
    if (BM.normalizePathKeyframes(mask).length) updateKey(mask, Math.max(0, S.t - localStart), nodes, interpolation.value);
    else mask.nodes = nodes;
    draw();
  });
  const endDrag = () => { if (!drag) return; drag = null; renderAll(); };
  svg.addEventListener('pointerup', endDrag); svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('dblclick', ev => {
    const target = ev.target; if (target?.dataset?.role !== 'anchor' || mask.nodes.length <= 3) return;
    ev.preventDefault(); commit(); const index = Number(target.dataset.node); const oldKeys = BM.normalizePathKeyframes(mask);
    mask.nodes.splice(index, 1);
    mask.pathKeyframes = oldKeys.map(k => ({ ...k, nodes: k.nodes.filter((_,i) => i !== index) }));
    selected = Math.max(0, Math.min(mask.nodes.length - 1, index - 1)); renderAll();
  });
  add.onclick = () => { adding = !adding; add.classList.toggle('active', adding); status(adding ? 'Click a point on the Bézier curve to insert an anchor.' : ''); };
  remove.onclick = () => {
    const nodes = nodeForAtTime(); if (nodes.length <= 3) return; commit();
    const oldKeys = BM.normalizePathKeyframes(mask); mask.pathKeyframes = oldKeys.map(k => ({ ...k, nodes: k.nodes.filter((_,i) => i !== selected) })); mask.nodes.splice(selected, 1);
    selected = Math.max(0, Math.min(mask.nodes.length - 1, selected - 1)); renderAll();
  };
  keyframe.onclick = () => { commit(); updateKey(mask, Math.max(0, S.t - localStart), nodeForAtTime(), interpolation.value); log(`${title}: path keyframe at ${Math.max(0,S.t-localStart).toFixed(3)}s`); renderAll(); };
  clearKeys.onclick = () => { commit(); delete mask.pathKeyframes; renderAll(); };
  // The toolbar toggles edit-on-curve; when enabled, only an actual curve stroke accepts insertion.
  svg.addEventListener('click', ev => { if (ev.target?.dataset?.role === 'curve' && adding) { adding = false; add.classList.remove('active'); status(''); } });
  draw(); return box;
}

function renderInspector() {
  const el = $('insp'); el.textContent = '';
  const clip = S.tl.video.find((c) => c.id === S.sel), txt = S.tl.text.find((o) => o.id === S.sel);
  const lay = (S.tl.layers || []).find((o) => o.id === S.sel), aud = (S.tl.audio || []).find((o) => o.id === S.sel);
  const field = (label, val, type, on) => {
    const l = document.createElement('label'); l.textContent = label;
    const i = document.createElement('input'); i.type = type; i.value = val; if (type === 'number') i.step = '0.1';
    i.onchange = () => { commit(); on(i.value); renderAll(); }; l.append(i); el.append(l);
  };
  const audioProductionControls = (target) => {
    const h = document.createElement('h4'); h.textContent = 'Audio production'; el.append(h);
    field('Gain (dB, −36 to +24)', target.gainDb ?? 0, 'number', (v) => { target.gainDb = Math.max(-36, Math.min(24, +v || 0)); });
    field('Stereo balance (−1 left to +1 right)', target.pan ?? 0, 'number', (v) => { target.pan = Math.max(-1, Math.min(1, +v || 0)); });
    field('Bass shelf (dB)', target.lowShelfDb ?? 0, 'number', (v) => { target.lowShelfDb = Math.max(-18, Math.min(18, +v || 0)); });
    field('Treble shelf (dB)', target.highShelfDb ?? 0, 'number', (v) => { target.highShelfDb = Math.max(-18, Math.min(18, +v || 0)); });
    field('Fade in (s)', target.fadeIn ?? 0, 'number', (v) => { target.fadeIn = Math.max(0, Math.min(120, +v || 0)); });
    field('Fade out (s)', target.fadeOut ?? 0, 'number', (v) => { target.fadeOut = Math.max(0, Math.min(120, +v || 0)); });
    const row = document.createElement('label'); row.className = 'chk'; const check = document.createElement('input'); check.type = 'checkbox'; check.checked = !!target.compressor; check.onchange = () => { commit(); target.compressor = check.checked; renderAll(); }; row.append(check, ' Compressor'); el.append(row);
  };
  if (clip) {
    if (S.tl.mode === 'free') field('Video track', clip.track || 1, 'number', (v) => { const n = Math.max(1, Math.min(S.tl.trackCount, Math.round(+v || 1))); if (n > 1 && S.tl.trackState[String(n)]?.locked) { log('That track is locked'); return; } clip.track = n; });
    if (S.tl.mode === 'free') field('Timeline start (s)', (clip.start || 0).toFixed(2), 'number', (v) => { clip.start = Math.max(0, +v || 0); });
    field('In (s)', clip.in.toFixed(2), 'number', (v) => (clip.in = Math.max(0, Math.min(+v, clip.out - 0.1))));
    field('Out (s)', clip.out.toFixed(2), 'number', (v) => (clip.out = Math.max(clip.in + 0.1, +v)));
    field('Zoom (1-3×)', clip.zoom, 'number', (v) => (clip.zoom = Math.min(3, Math.max(1, +v))));
    field('Volume (0-2)', clip.volume, 'number', (v) => (clip.volume = Math.min(2, Math.max(0, +v))));
    audioProductionControls(clip);
    field('Speed (0.25-4×)', clip.speed || 1, 'number', (v) => (clip.speed = Math.min(4, Math.max(0.25, +v || 1))));
    const editHead = document.createElement('h4'); editHead.textContent = 'Editorial tools'; el.append(editHead);
    const editRow = document.createElement('div'); editRow.className = 'row wrap';
    const editButton = (text, title, action, disabled = false) => { const b = document.createElement('button'); b.className = 'small'; b.textContent = text; b.title = title; b.disabled = disabled; b.onclick = () => { commit(); const r = action(); if (r && r.ok === false) log(r.reason); else log(title); renderAll(); }; editRow.append(b); };
    editButton('Slip −0.5s', 'Slip source backward by 0.5 seconds', () => TL.slipEdit(S.tl, clip.id, -0.5, mediaOf(clip.src)?.duration || Infinity));
    editButton('Slip +0.5s', 'Slip source forward by 0.5 seconds', () => TL.slipEdit(S.tl, clip.id, 0.5, mediaOf(clip.src)?.duration || Infinity));
    editButton('Roll −0.5s', 'Roll edit with previous sequential clip', () => TL.rollEdit(S.tl, clip.id, -0.5), S.tl.mode === 'free' || TL.layout(S.tl).findIndex((x) => x.clip.id === clip.id) <= 0);
    editButton('Roll +0.5s', 'Roll edit with previous sequential clip', () => TL.rollEdit(S.tl, clip.id, 0.5), S.tl.mode === 'free' || TL.layout(S.tl).findIndex((x) => x.clip.id === clip.id) <= 0);
    const clipIdx = TL.layout(S.tl).findIndex((x) => x.clip.id === clip.id), clipLayout = TL.layout(S.tl);
    editButton('Slide −0.5s', 'Slide selected clip left against its neighbours', () => TL.slideEdit(S.tl, clip.id, -0.5), S.tl.mode === 'free' || clipIdx <= 0 || clipIdx >= clipLayout.length - 1);
    editButton('Slide +0.5s', 'Slide selected clip right against its neighbours', () => TL.slideEdit(S.tl, clip.id, 0.5), S.tl.mode === 'free' || clipIdx <= 0 || clipIdx >= clipLayout.length - 1);
    editButton('Rate stretch…', 'Change clip duration while preserving source range', () => { const v = prompt('New timeline duration (seconds)', TL.clipDur(clip).toFixed(2)); if (v == null) return { ok: true }; return TL.rateStretch(S.tl, clip.id, +v); });
    el.append(editRow);
    const th = document.createElement('h4'); th.textContent = 'Transform & keyframes'; el.append(th);
    clip.transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alpha: 1, shearX: 0, shearY: 0, ...(clip.transform || {}) };
    const keyInterp = document.createElement('select'); ['linear', 'bezier', 'constant'].forEach((v) => keyInterp.add(new Option('Keyframe: ' + v, v))); keyInterp.value = 'linear'; el.append(keyInterp);
    const transformField = (title, prop, min, max, step = '0.1') => {
      const row = document.createElement('div'); row.className = 'transform-row';
      const lab = document.createElement('label'); lab.textContent = title;
      const input = document.createElement('input'); input.type = 'number'; input.step = step; input.min = min; input.max = max; input.value = clip.transform[prop];
      input.onchange = () => { commit(); clip.transform[prop] = Math.max(min, Math.min(max, +input.value || 0)); renderAll(); };
      const kf = document.createElement('button'); kf.className = 'small'; kf.textContent = '◆'; kf.title = 'Add keyframe at playhead';
      kf.onclick = () => { commit(); TL.setKeyframe(clip, prop, Math.max(0, S.t - (TL.layout(S.tl).find((x) => x.clip.id === clip.id)?.start || 0)), +input.value, keyInterp.value); log(`Keyframe ${prop} added`); renderAll(); };
      lab.append(input); row.append(lab, kf); el.append(row);
    };
    transformField('Position X (frame fraction)', 'x', -0.45, 0.45);
    transformField('Position Y (frame fraction)', 'y', -0.45, 0.45);
    transformField('Scale X', 'scaleX', 0.05, 8);
    transformField('Scale Y', 'scaleY', 0.05, 8);
    transformField('Rotation (degrees)', 'rotation', -3600, 3600, '1');
    transformField('Opacity (0–1)', 'alpha', 0, 1, '0.05');
    transformField('Shear X', 'shearX', -1.5, 1.5, '0.05');
    transformField('Shear Y', 'shearY', -1.5, 1.5, '0.05');
    const kfCount = Object.values(clip.keyframes || {}).reduce((n, a) => n + a.length, 0);
    const kfInfo = document.createElement('div'); kfInfo.className = 'muted'; kfInfo.textContent = `${kfCount} keyframes · add diamonds at different playhead positions`; el.append(kfInfo);
    field('Fade in (s)', clip.fade?.[0] || 0, 'number', (v) => (clip.fade = [Math.max(0, +v), clip.fade?.[1] || 0]));
    field('Fade out (s)', clip.fade?.[1] || 0, 'number', (v) => (clip.fade = [clip.fade?.[0] || 0, Math.max(0, +v)]));
    const tl = document.createElement('label'); tl.textContent = 'Transition in';
    const ts = document.createElement('select'); ['none', ...TL.TRANS].forEach((t) => ts.add(new Option(t, t)));
    ts.value = clip.trans ? clip.trans.type : 'none'; ts.disabled = S.tl.mode === 'free'; ts.title = S.tl.mode === 'free' ? 'Transitions currently require sequential mode' : 'Incoming transition';
    ts.onchange = () => { commit(); clip.trans = ts.value === 'none' ? null : { type: ts.value, dur: clip.trans?.dur || 0.6 }; renderAll(); };
    tl.append(ts); el.append(tl);
    clip.fx = clip.fx || {};
    [['Brightness (-1..1)', 'brightness', 0], ['Contrast (0-3)', 'contrast', 1], ['Saturation (0-3)', 'saturation', 1], ['Blur', 'blur', 0], ['Sharpen', 'sharpen', 0]].forEach(([n, k, d]) =>
      field(n, clip.fx[k] ?? d, 'number', (v) => (clip.fx[k] = +v)));
    const fr = document.createElement('div'); fr.className = 'row wrap';
    ['grayscale', 'sepia', 'invert', 'vignette', 'flipH', 'flipV'].forEach((k) => { const l = document.createElement('label'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!clip.fx[k]; cb.onchange = () => { commit(); clip.fx[k] = cb.checked; renderAll(); }; l.append(cb, k); fr.append(l); });
    el.append(fr);
    // Ordered effect stack: effects are preserved in project data and rendered in stack order.
    clip.effects = Array.isArray(clip.effects) ? clip.effects : [];
    const stackHead = document.createElement('h4'); stackHead.textContent = 'Effect stack'; el.append(stackHead);
    const stackList = document.createElement('div'); stackList.className = 'column';
    clip.effects.forEach((effect, index) => {
      const line = document.createElement('div'); line.className = 'row wrap';
      const label = document.createElement('span'); label.textContent = `${index + 1}. ${effect.type || 'effect'}`; line.append(label);
      const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = effect.enabled !== false; enabled.title = 'Enable effect'; enabled.onchange = () => { commit(); effect.enabled = enabled.checked; renderAll(); }; line.append(enabled);
      const up = document.createElement('button'); up.className = 'small'; up.textContent = '↑'; up.disabled = index === 0; up.onclick = () => { commit(); [clip.effects[index - 1], clip.effects[index]] = [clip.effects[index], clip.effects[index - 1]]; renderAll(); }; line.append(up);
      const down = document.createElement('button'); down.className = 'small'; down.textContent = '↓'; down.disabled = index === clip.effects.length - 1; down.onclick = () => { commit(); [clip.effects[index + 1], clip.effects[index]] = [clip.effects[index], clip.effects[index + 1]]; renderAll(); }; line.append(down);
      const remove = document.createElement('button'); remove.className = 'small'; remove.textContent = 'Remove'; remove.onclick = () => { commit(); clip.effects.splice(index, 1); renderAll(); }; line.append(remove); stackList.append(line);
      const effectParams = ({
        brightness: [['value', 'Brightness', -1, 1, 0.1]], contrast: [['value', 'Contrast', 0, 3, 0.1]],
        saturation: [['value', 'Saturation', 0, 3, 0.1]], gamma: [['value', 'Gamma', 0.1, 10, 0.1]],
        blur: [['amount', 'Blur', 0, 50, 0.5]], sharpen: [['amount', 'Sharpen', 0, 5, 0.1]],
        hue: [['degrees', 'Hue degrees', -180, 180, 1]],
        color: [['brightness', 'Brightness', -1, 1, 0.1], ['contrast', 'Contrast', 0, 3, 0.1], ['saturation', 'Saturation', 0, 3, 0.1]]
      })[effect.type] || [];
      effect.params = effect.params || {};
      effect.keyframes = effect.keyframes || {};
      const clipStart = TL.layout(S.tl).find((x) => x.clip.id === clip.id)?.start || 0;
      effectParams.forEach(([param, title, min, max, step]) => {
        const row = document.createElement('div'); row.className = 'transform-row';
        const label = document.createElement('label'); label.textContent = title;
        const input = document.createElement('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step;
        input.value = effect.params[param] ?? ({ contrast: 1, saturation: 1, gamma: 1, brightness: 0, blur: 2, sharpen: 0.5, hue: 0 })[param] ?? 0;
        input.onchange = () => { commit(); effect.params[param] = Math.max(min, Math.min(max, Number(input.value) || 0)); renderAll(); };
        const addKf = document.createElement('button'); addKf.className = 'small'; addKf.textContent = '◆'; addKf.title = `Keyframe ${title} at playhead`;
        addKf.onclick = () => {
          commit(); const points = effect.keyframes[param] || (effect.keyframes[param] = []);
          const t = Math.max(0, S.t - clipStart), v = Math.max(min, Math.min(max, Number(input.value) || 0));
          const point = { t, v, interpolation: keyInterp.value }; const at = points.findIndex((p) => Math.abs(p.t - t) < 0.0001);
          if (at >= 0) points[at] = point; else points.push(point); points.sort((a, b) => a.t - b.t);
          log(`Effect ${effect.type}: ${title} keyframe at ${t.toFixed(3)}s`); renderAll();
        };
        label.append(input); row.append(label, addKf); stackList.append(row);
        const points = effect.keyframes[param] || [];
        if (points.length) {
          const info = document.createElement('div'); info.className = 'muted';
          info.textContent = `${points.length} keyframe(s): ` + points.map((p) => `${Number(p.t).toFixed(2)}s → ${Number(p.v).toFixed(2)}`).join(' · ');
          const clear = document.createElement('button'); clear.className = 'small'; clear.textContent = 'Clear keyframes';
          clear.onclick = () => { commit(); delete effect.keyframes[param]; renderAll(); };
          stackList.append(info, clear);
        }
      });
    });
    el.append(stackList);
    const addEffectRow = document.createElement('div'); addEffectRow.className = 'row wrap';
    const effectType = document.createElement('select');
    ['brightness','contrast','saturation','color','gamma','blur','sharpen','grayscale','sepia','invert','vignette','flip-h','flip-v','hue'].forEach((type) => effectType.add(new Option(type, type)));
    const addEffect = document.createElement('button'); addEffect.className = 'small'; addEffect.textContent = '+ Add effect'; addEffect.onclick = () => { commit(); clip.effects.push({ id: `fx-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, type: effectType.value, enabled: true, params: ({ brightness: { value: 0.1 }, contrast: { value: 1.1 }, saturation: { value: 1.1 }, color: { brightness: 0, contrast: 1, saturation: 1 }, gamma: { value: 1 }, blur: { amount: 2 }, sharpen: { amount: 0.5 }, hue: { degrees: 15 } })[effectType.value] || {} }); renderAll(); };
    addEffectRow.append(effectType, addEffect); el.append(addEffectRow);
    const maskHead = document.createElement('h4'); maskHead.textContent = 'Clip mask'; el.append(maskHead);
    clip.mask = clip.mask || { enabled: false, shape: 'rectangle', x: 0, y: 0, width: 1, height: 1, invert: false };
    const maskEnable = document.createElement('label'); const maskCheck = document.createElement('input'); maskCheck.type = 'checkbox'; maskCheck.checked = clip.mask.enabled; maskCheck.onchange = () => { commit(); clip.mask.enabled = maskCheck.checked; renderAll(); }; maskEnable.append(maskCheck, document.createTextNode(' Enable mask')); el.append(maskEnable);
    const maskShape = document.createElement('select'); ['rectangle','ellipse','path','bezier'].forEach((shape) => maskShape.add(new Option(shape, shape))); maskShape.value = clip.mask.shape || 'rectangle'; maskShape.onchange = () => { commit(); const next = maskShape.value; if (next === 'bezier') { if (!Array.isArray(clip.mask.nodes)) clip.mask.nodes = Array.isArray(clip.mask.points) && clip.mask.points.length >= 3 ? window.FrostyBezierMask.polygonToNodes(clip.mask.points) : window.FrostyBezierMask.defaultBezierNodes(); clip.mask.pathKeyframes = Array.isArray(clip.mask.pathKeyframes) ? clip.mask.pathKeyframes : []; } clip.mask.shape = next; renderAll(); }; el.append(maskShape);
    const clipFeatherRow = document.createElement('div'); clipFeatherRow.className = 'transform-row'; const clipFeatherLabel = document.createElement('label'); clipFeatherLabel.textContent = 'Mask feather (px)'; const clipFeather = document.createElement('input'); clipFeather.type = 'number'; clipFeather.min = 0; clipFeather.max = 100; clipFeather.step = 1; clipFeather.value = clip.mask.feather || 0; clipFeather.onchange = () => { commit(); clip.mask.feather = Math.max(0, Math.min(100, Number(clipFeather.value) || 0)); renderAll(); }; clipFeatherLabel.append(clipFeather); clipFeatherRow.append(clipFeatherLabel); el.append(clipFeatherRow);
    if (clip.mask.shape === 'bezier') { const maskClipStart = TL.layout(S.tl).find((x) => x.clip.id === clip.id)?.start || 0; el.append(renderBezierMaskEditor(clip, clip.mask, maskClipStart, 'Clip mask')); }
    if (clip.mask.shape === 'path') {
      const pathLabel = document.createElement('label'); pathLabel.textContent = 'Polygon points (normalized X/Y, 0–1)'; const pathPoints = document.createElement('textarea'); pathPoints.rows = 3; pathPoints.value = JSON.stringify(clip.mask.points || [], null, 2); pathPoints.placeholder = '[[0.1,0.1],[0.9,0.1],[0.5,0.9]]'; pathPoints.onchange = () => { try { const parsed = JSON.parse(pathPoints.value); if (!Array.isArray(parsed) || parsed.length < 3 || parsed.length > 32) throw new Error('Use 3–32 polygon points.'); const points = parsed.map((point) => { const px = Array.isArray(point) ? Number(point[0]) : Number(point?.x); const py = Array.isArray(point) ? Number(point[1]) : Number(point?.y); if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('Each point needs numeric X and Y values.'); return [Math.max(0, Math.min(1, px)), Math.max(0, Math.min(1, py))]; }); commit(); clip.mask.points = points; renderAll(); } catch (err) { log(`Invalid mask polygon: ${err.message}`); pathPoints.value = JSON.stringify(clip.mask.points || [], null, 2); } }; pathLabel.append(pathPoints); el.append(pathLabel);
    }
    clip.mask.keyframes = clip.mask.keyframes || {};
    const clipStartForMask = TL.layout(S.tl).find((x) => x.clip.id === clip.id)?.start || 0;
    [['X','x'],['Y','y'],['Width','width'],['Height','height']].forEach(([labelText,key]) => {
      const row = document.createElement('div'); row.className = 'transform-row';
      const label = document.createElement('label'); label.textContent = labelText;
      const input = document.createElement('input'); input.type = 'number'; input.min = 0; input.max = 1; input.step = 0.05;
      input.value = clip.mask[key] ?? (key === 'width' || key === 'height' ? 1 : 0);
      input.onchange = () => { commit(); clip.mask[key] = Math.max(0, Math.min(1, +input.value || 0)); renderAll(); };
      const addMaskKf = document.createElement('button'); addMaskKf.className = 'small'; addMaskKf.textContent = '◆'; addMaskKf.title = `Keyframe mask ${labelText}`;
      addMaskKf.onclick = () => {
        commit(); const points = clip.mask.keyframes[key] || (clip.mask.keyframes[key] = []);
        const t = Math.max(0, S.t - clipStartForMask), v = Math.max(0, Math.min(1, Number(input.value) || 0));
        const point = { t, v, interpolation: keyInterp.value }; const at = points.findIndex((p) => Math.abs(p.t - t) < 0.0001);
        if (at >= 0) points[at] = point; else points.push(point); points.sort((a, b) => a.t - b.t); renderAll();
      };
      label.append(input); row.append(label, addMaskKf); el.append(row);
      const points = clip.mask.keyframes[key] || [];
      if (points.length) { const info = document.createElement('div'); info.className = 'muted'; info.textContent = `Mask ${key}: ` + points.map((p) => `${Number(p.t).toFixed(2)}s → ${Number(p.v).toFixed(2)}`).join(' · '); el.append(info); }
    });
    const invertMask = document.createElement('label'); const invertCheck = document.createElement('input'); invertCheck.type = 'checkbox'; invertCheck.checked = !!clip.mask.invert; invertCheck.onchange = () => { commit(); clip.mask.invert = invertCheck.checked; renderAll(); }; invertMask.append(invertCheck, document.createTextNode(' Invert mask')); el.append(invertMask);
    const r = document.createElement('div'); r.className = 'row';
    [['◀ Move', -1], ['Move ▶', 1]].forEach(([n, d]) => { const b = document.createElement('button'); b.className = 'small'; b.textContent = n; b.onclick = () => { commit(); TL.moveClip(S.tl, clip.id, d); renderAll(); }; r.append(b); });
    el.append(r);
  } else if (lay) {
    field('Video track', lay.track || 2, 'number', (v) => { const next = Math.max(2, Math.min(S.tl.trackCount, Math.round(+v || 2))); if (S.tl.trackState[String(next)]?.locked) { log('That track is locked'); return; } lay.track = next; S.targetTrack = lay.track; });
    field('Start (s)', lay.start.toFixed(2), 'number', (v) => (lay.start = Math.max(0, +v)));
    field('Source In (s)', lay.in.toFixed(2), 'number', (v) => (lay.in = Math.max(0, Math.min(+v, lay.out - 0.1))));
    field('Source Out (s)', lay.out.toFixed(2), 'number', (v) => (lay.out = Math.max(lay.in + 0.1, +v)));
    field('Speed (0.1-10×)', lay.speed || 1, 'number', (v) => (lay.speed = Math.max(0.1, Math.min(10, +v || 1))));
    field('Position X (0-1)', lay.x, 'number', (v) => (lay.x = +v));
    field('Position Y (0-1)', lay.y, 'number', (v) => (lay.y = +v));
    field('Size (0.05-1 of width)', lay.scale, 'number', (v) => (lay.scale = Math.min(1, Math.max(0.05, +v))));
    field('Opacity (0-1)', lay.opacity, 'number', (v) => (lay.opacity = Math.min(1, Math.max(0, +v))));
    field('Rotation (degrees)', lay.rotation || 0, 'number', (v) => (lay.rotation = Math.max(-3600, Math.min(3600, +v))));
    field('Volume (0-2)', lay.volume, 'number', (v) => (lay.volume = Math.min(2, Math.max(0, +v))));
    if (lay.hasAudio) audioProductionControls(lay);
    const lh = document.createElement('h4'); lh.textContent = 'Overlay animation'; el.append(lh);
    const li = document.createElement('select'); ['linear', 'bezier', 'constant'].forEach((v) => li.add(new Option('Keyframe: ' + v, v))); el.append(li);
    const layerKey = (title, prop, min, max, step = '0.05') => {
      const row = document.createElement('div'); row.className = 'transform-row';
      const lab = document.createElement('label'); lab.textContent = title;
      const input = document.createElement('input'); input.type = 'number'; input.step = step; input.min = min; input.max = max; input.value = lay[prop] ?? (prop === 'opacity' || prop === 'volume' ? 1 : 0);
      input.onchange = () => { commit(); lay[prop] = Math.max(min, Math.min(max, +input.value || 0)); renderAll(); };
      const kf = document.createElement('button'); kf.className = 'small'; kf.textContent = '◆'; kf.title = 'Add keyframe at playhead';
      kf.onclick = () => { commit(); TL.setKeyframe(lay, prop, Math.max(0, S.t - lay.start), +input.value, li.value); log(`Overlay keyframe ${prop} added`); renderAll(); };
      lab.append(input); row.append(lab, kf); el.append(row);
    };
    layerKey('Animate X (0-1)', 'x', 0, 1); layerKey('Animate Y (0-1)', 'y', 0, 1); layerKey('Animate size', 'scale', 0.05, 1); layerKey('Animate opacity', 'opacity', 0, 1); layerKey('Animate rotation', 'rotation', -3600, 3600, '1');
    const ah = document.createElement('h4'); ah.textContent = 'Audio automation'; el.append(ah);
    const av = document.createElement('input'); av.type = 'number'; av.min = 0; av.max = 2; av.step = '0.05'; av.value = lay.volume ?? 1;
    const ak = document.createElement('button'); ak.className = 'small'; ak.textContent = '◆'; ak.title = 'Add volume keyframe at playhead';
    ak.onclick = () => { commit(); TL.setKeyframe(lay, 'volume', Math.max(0, S.t - lay.start), +av.value, li.value); log('Overlay volume keyframe added'); renderAll(); };
    const ar = document.createElement('div'); ar.className = 'transform-row'; const al = document.createElement('label'); al.textContent = 'Volume keyframe'; al.append(av); ar.append(al, ak); el.append(ar);
    const l = document.createElement('label'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!lay.chroma;
    cb.onchange = () => { commit(); lay.chroma = cb.checked ? { color: '#00ff00', sim: 0.12 } : null; renderAll(); }; l.append(cb, ' Green-screen (chroma key)'); el.append(l);
    if (lay.chroma) { field('Key colour', lay.chroma.color, 'color', (v) => (lay.chroma.color = v)); field('Similarity', lay.chroma.sim, 'number', (v) => (lay.chroma.sim = +v)); }
    const layerMaskHead = document.createElement('h4'); layerMaskHead.textContent = 'Overlay mask'; el.append(layerMaskHead);
    lay.mask = lay.mask || { enabled: false, shape: 'rectangle', x: 0, y: 0, width: 1, height: 1, invert: false, keyframes: {} };
    lay.mask.keyframes = lay.mask.keyframes || {};
    const layerMaskEnabled = document.createElement('label'); const layerMaskCheck = document.createElement('input'); layerMaskCheck.type = 'checkbox'; layerMaskCheck.checked = !!lay.mask.enabled;
    layerMaskCheck.onchange = () => { commit(); lay.mask.enabled = layerMaskCheck.checked; renderAll(); }; layerMaskEnabled.append(layerMaskCheck, ' Enable overlay mask'); el.append(layerMaskEnabled);
    const layerMaskShape = document.createElement('select'); ['rectangle','ellipse','path','bezier'].forEach((shape) => layerMaskShape.add(new Option(shape, shape))); layerMaskShape.value = lay.mask.shape || 'rectangle';
    layerMaskShape.onchange = () => { commit(); const next = layerMaskShape.value; if (next === 'bezier') { if (!Array.isArray(lay.mask.nodes)) lay.mask.nodes = Array.isArray(lay.mask.points) && lay.mask.points.length >= 3 ? window.FrostyBezierMask.polygonToNodes(lay.mask.points) : window.FrostyBezierMask.defaultBezierNodes(); lay.mask.pathKeyframes = Array.isArray(lay.mask.pathKeyframes) ? lay.mask.pathKeyframes : []; } lay.mask.shape = next; renderAll(); }; el.append(layerMaskShape);
    const layerFeatherRow = document.createElement('div'); layerFeatherRow.className = 'transform-row'; const layerFeatherLabel = document.createElement('label'); layerFeatherLabel.textContent = 'Mask feather (px)'; const layerFeather = document.createElement('input'); layerFeather.type = 'number'; layerFeather.min = 0; layerFeather.max = 100; layerFeather.step = 1; layerFeather.value = lay.mask.feather || 0; layerFeather.onchange = () => { commit(); lay.mask.feather = Math.max(0, Math.min(100, Number(layerFeather.value) || 0)); renderAll(); }; layerFeatherLabel.append(layerFeather); layerFeatherRow.append(layerFeatherLabel); el.append(layerFeatherRow);
    if (lay.mask.shape === 'bezier') el.append(renderBezierMaskEditor(lay, lay.mask, lay.start || 0, 'Overlay mask'));
    if (lay.mask.shape === 'path') {
      const layerPathLabel = document.createElement('label'); layerPathLabel.textContent = 'Polygon points (normalized X/Y, 0–1)'; const layerPathPoints = document.createElement('textarea'); layerPathPoints.rows = 3; layerPathPoints.value = JSON.stringify(lay.mask.points || [], null, 2); layerPathPoints.placeholder = '[[0.1,0.1],[0.9,0.1],[0.5,0.9]]'; layerPathPoints.onchange = () => { try { const parsed = JSON.parse(layerPathPoints.value); if (!Array.isArray(parsed) || parsed.length < 3 || parsed.length > 32) throw new Error('Use 3–32 polygon points.'); const points = parsed.map((point) => { const px = Array.isArray(point) ? Number(point[0]) : Number(point?.x); const py = Array.isArray(point) ? Number(point[1]) : Number(point?.y); if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('Each point needs numeric X and Y values.'); return [Math.max(0, Math.min(1, px)), Math.max(0, Math.min(1, py))]; }); commit(); lay.mask.points = points; renderAll(); } catch (err) { log(`Invalid mask polygon: ${err.message}`); layerPathPoints.value = JSON.stringify(lay.mask.points || [], null, 2); } }; layerPathLabel.append(layerPathPoints); el.append(layerPathLabel);
    }
    [['X','x'],['Y','y'],['Width','width'],['Height','height']].forEach(([caption, key]) => {
      const line = document.createElement('div'); line.className = 'transform-row'; const lab = document.createElement('label'); lab.textContent = caption;
      const input = document.createElement('input'); input.type = 'number'; input.min = 0; input.max = 1; input.step = 0.05; input.value = lay.mask[key] ?? (key === 'width' || key === 'height' ? 1 : 0);
      input.onchange = () => { commit(); lay.mask[key] = Math.max(0, Math.min(1, Number(input.value) || 0)); renderAll(); };
      const kf = document.createElement('button'); kf.className = 'small'; kf.textContent = '◆'; kf.title = `Keyframe overlay mask ${caption}`;
      kf.onclick = () => { commit(); const points = lay.mask.keyframes[key] || (lay.mask.keyframes[key] = []); const t = Math.max(0, S.t - lay.start), v = Math.max(0, Math.min(1, Number(input.value) || 0)); const point = { t, v, interpolation: li.value }; const at = points.findIndex((p) => Math.abs(p.t - t) < 0.0001); if (at >= 0) points[at] = point; else points.push(point); points.sort((a, b) => a.t - b.t); renderAll(); };
      lab.append(input); line.append(lab, kf); el.append(line);
    });
    const layerMaskInvert = document.createElement('label'); const layerMaskInvertCheck = document.createElement('input'); layerMaskInvertCheck.type = 'checkbox'; layerMaskInvertCheck.checked = !!lay.mask.invert;
    layerMaskInvertCheck.onchange = () => { commit(); lay.mask.invert = layerMaskInvertCheck.checked; renderAll(); }; layerMaskInvert.append(layerMaskInvertCheck, ' Invert overlay mask'); el.append(layerMaskInvert);
  } else if (aud) {
    field('Start (s)', aud.start.toFixed(2), 'number', (v) => (aud.start = Math.max(0, +v)));
    field('Source In (s)', aud.in.toFixed(2), 'number', (v) => (aud.in = Math.max(0, Math.min(+v, aud.out - 0.1))));
    field('Source Out (s)', aud.out.toFixed(2), 'number', (v) => (aud.out = Math.max(aud.in + 0.1, +v)));
    field('Volume (0-2)', aud.volume, 'number', (v) => (aud.volume = Math.min(2, Math.max(0, +v))));
    audioProductionControls(aud);
    const ah = document.createElement('h4'); ah.textContent = 'Volume automation'; el.append(ah);
    const av = document.createElement('input'); av.type = 'number'; av.min = 0; av.max = 2; av.step = '0.05'; av.value = aud.volume ?? 1;
    const ai = document.createElement('select'); ['linear', 'bezier', 'constant'].forEach((v) => ai.add(new Option('Keyframe: ' + v, v))); el.append(ai);
    const ak = document.createElement('button'); ak.className = 'small'; ak.textContent = '◆ Add at playhead'; ak.onclick = () => { commit(); TL.setKeyframe(aud, 'volume', Math.max(0, S.t - aud.start), +av.value, ai.value); log('Audio volume keyframe added'); renderAll(); }; el.append(av, ak);
  } else if (txt) {
    field('Text', txt.text, 'text', (v) => (txt.text = v));
    field('Start (s)', txt.start.toFixed(2), 'number', (v) => (txt.start = Math.max(0, +v)));
    field('Duration (s)', txt.dur.toFixed(2), 'number', (v) => (txt.dur = Math.max(0.2, +v)));
    field('Size', txt.size, 'number', (v) => (txt.size = Math.max(12, +v)));
    field('Color', txt.color, 'color', (v) => (txt.color = v));
  } else { el.textContent = 'Select a clip or text.'; el.className = 'muted'; return; }
  el.className = '';
}

function renderGlobalEffects() {
  const host = $('globalEffects'); if (!host) return;
  host.textContent = ''; host.className = '';
  const target = document.createElement('select');
  target.add(new Option('Master output', 'master'));
  for (let track = 1; track <= Math.max(1, Number(S.tl.trackCount) || 1); track++) {
    const state = S.tl.trackState[String(track)] || {};
    target.add(new Option(`Track ${track}${state.name ? ` · ${state.name}` : ''}`, String(track)));
  }
  target.value = S.globalEffectTarget || 'master';
  target.onchange = () => { S.globalEffectTarget = target.value; renderGlobalEffects(); };
  host.append(target);
  const bus = S.tl.audioMaster || (S.tl.audioMaster = { gainDb: 0, compressor: false });
  const busTitle = document.createElement('h4'); busTitle.textContent = 'Master audio bus'; host.append(busTitle);
  const busGainLabel = document.createElement('label'); busGainLabel.textContent = 'Master gain (dB)'; const busGain = document.createElement('input'); busGain.type = 'number'; busGain.min = -36; busGain.max = 18; busGain.step = 0.5; busGain.value = bus.gainDb ?? 0; busGain.onchange = () => { commit(); bus.gainDb = Math.max(-36, Math.min(18, Number(busGain.value) || 0)); renderAll(); }; busGainLabel.append(busGain); host.append(busGainLabel);
  const busCompLabel = document.createElement('label'); busCompLabel.className = 'chk'; const busComp = document.createElement('input'); busComp.type = 'checkbox'; busComp.checked = !!bus.compressor; busComp.onchange = () => { commit(); bus.compressor = busComp.checked; renderAll(); }; busCompLabel.append(busComp, ' Master compressor'); host.append(busCompLabel);
  let effects;
  if (target.value === 'master') effects = S.tl.masterEffects || (S.tl.masterEffects = S.tl.settings.masterEffects || []);
  else {
    const state = S.tl.trackState[String(Number(target.value))] || (S.tl.trackState[String(Number(target.value))] = { visible: true, muted: false, locked: false });
    effects = state.effects || (state.effects = []);
  }
  const stack = document.createElement('div'); stack.className = 'column'; host.append(stack);
  const descriptors = {
    brightness: [['value', 'Brightness', -1, 1, 0.1, 0]], contrast: [['value', 'Contrast', 0, 3, 0.1, 1]],
    saturation: [['value', 'Saturation', 0, 3, 0.1, 1]], gamma: [['value', 'Gamma', 0.1, 10, 0.1, 1]],
    blur: [['amount', 'Blur', 0, 50, 0.5, 2]], sharpen: [['amount', 'Sharpen', 0, 5, 0.1, 0.5]],
    hue: [['degrees', 'Hue', -180, 180, 1, 0]],
    color: [['brightness', 'Brightness', -1, 1, 0.1, 0], ['contrast', 'Contrast', 0, 3, 0.1, 1], ['saturation', 'Saturation', 0, 3, 0.1, 1]]
  };
  effects.forEach((effect, index) => {
    effect.params = effect.params || {}; effect.keyframes = effect.keyframes || {};
    const row = document.createElement('div'); row.className = 'row wrap';
    const name = document.createElement('strong'); name.textContent = `${index + 1}. ${effect.type}`; row.append(name);
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = effect.enabled !== false; enabled.title = 'Enable effect';
    enabled.onchange = () => { commit(); effect.enabled = enabled.checked; renderAll(); }; row.append(enabled);
    [['↑', -1], ['↓', 1]].forEach(([symbol, delta]) => { const b = document.createElement('button'); b.className = 'small'; b.textContent = symbol; b.disabled = index + delta < 0 || index + delta >= effects.length; b.onclick = () => { commit(); [effects[index], effects[index + delta]] = [effects[index + delta], effects[index]]; renderGlobalEffects(); }; row.append(b); });
    const remove = document.createElement('button'); remove.className = 'small'; remove.textContent = 'Remove'; remove.onclick = () => { commit(); effects.splice(index, 1); renderGlobalEffects(); }; row.append(remove); stack.append(row);
    (descriptors[effect.type] || []).forEach(([key, title, min, max, step, fallback]) => {
      const line = document.createElement('div'); line.className = 'transform-row'; const label = document.createElement('label'); label.textContent = title;
      const input = document.createElement('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step; input.value = effect.params[key] ?? fallback;
      input.onchange = () => { commit(); effect.params[key] = Math.max(min, Math.min(max, Number(input.value) || 0)); renderAll(); };
      const kf = document.createElement('button'); kf.className = 'small'; kf.textContent = '◆'; kf.title = `Add ${title} keyframe at timeline playhead`;
      kf.onclick = () => { commit(); const points = effect.keyframes[key] || (effect.keyframes[key] = []); const t = Math.max(0, S.t), v = Math.max(min, Math.min(max, Number(input.value) || 0)); const point = { t, v, interpolation: S.globalEffectInterpolation || 'linear' }; const at = points.findIndex((p) => Math.abs(p.t - t) < 0.0001); if (at >= 0) points[at] = point; else points.push(point); points.sort((a, b) => a.t - b.t); renderGlobalEffects(); };
      label.append(input); line.append(label, kf); stack.append(line);
      const points = effect.keyframes[key] || [];
      if (points.length) { const info = document.createElement('div'); info.className = 'muted'; info.textContent = `${points.length} keyframe(s): ` + points.map((p) => `${Number(p.t).toFixed(2)}s → ${Number(p.v).toFixed(2)}`).join(' · '); stack.append(info); }
    });
  });
  const addRow = document.createElement('div'); addRow.className = 'row wrap';
  const type = document.createElement('select'); ['brightness','contrast','saturation','color','gamma','blur','sharpen','grayscale','sepia','invert','vignette','flip-h','flip-v','hue'].forEach((t) => type.add(new Option(t, t)));
  const interpolation = document.createElement('select'); ['linear','bezier','constant'].forEach((v) => interpolation.add(new Option(`Keyframe: ${v}`, v))); interpolation.value = S.globalEffectInterpolation || 'linear'; interpolation.onchange = () => { S.globalEffectInterpolation = interpolation.value; };
  const add = document.createElement('button'); add.className = 'small'; add.textContent = '+ Add effect'; add.onclick = () => { commit(); const defaults = { brightness: { value: 0.1 }, contrast: { value: 1.1 }, saturation: { value: 1.1 }, color: { brightness: 0, contrast: 1, saturation: 1 }, gamma: { value: 1 }, blur: { amount: 2 }, sharpen: { amount: 0.5 }, hue: { degrees: 15 } }; effects.push({ id: `global-fx-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, type: type.value, enabled: true, params: defaults[type.value] || {}, keyframes: {} }); renderGlobalEffects(); };
  addRow.append(type, interpolation, add); host.append(addRow);
}

function renderAll() {
  TL.ensure(S.tl);
  const referenceReportButton = $('bReferenceReport');
  if (referenceReportButton) referenceReportButton.disabled = !(S.tl?.referenceTemplate?.analysis);
  const fps = TL.frameRateString(S.tl);
  const fpsSelect = $('projectFps');
  if (fpsSelect && ![...fpsSelect.options].some((o) => o.value === fps)) fpsSelect.add(new Option(`${fps} fps`, fps));
  if (fpsSelect) fpsSelect.value = fps;
  renderBin(); renderMusicMixer(); renderTimeline(); renderInspector(); renderGlobalEffects(); updatePreview(true);
  $('musicName').textContent = S.tl.music ? '♪ ' + S.tl.music.src.split(/[\\/]/).pop() : '';
  $('musicDuck').checked = !!S.tl.music?.duck;
  requestCanonicalPreview();
}

// ---------- preview ----------
const vid = $('vid');
const canonicalPreview = $('canonicalPreview');
const timelinePlayback = $('timelinePlayback');
S.previewMovie = null; S.previewMovieKey = ''; S.previewRenderToken = 0;
function previewTransform(c, localTime) {
  const tr = c.transform || {};
  const v = (k, d) => TL.evaluateKeyframes(c, k, localTime, tr[k] == null ? d : tr[k]);
  return `translate(${v('x', 0) * 100}%,${v('y', 0) * 100}%) rotate(${v('rotation', 0)}deg) skew(${Math.atan(v('shearX', 0)) * 180 / Math.PI}deg,${Math.atan(v('shearY', 0)) * 180 / Math.PI}deg) scale(${v('scaleX', 1) * (c.zoom || 1)},${v('scaleY', 1)})`;
}
function updatePreview(force) {
  if (!S.playing) { vid.style.visibility = 'visible'; $('ov').style.visibility = 'visible'; }
  if (S.tl.mode === 'free') {
    vid.style.visibility = 'hidden'; vid.pause(); drawFreeMainClips(); drawText(); S.cur = '__free__'; return;
  }
  $('ov').querySelectorAll('[data-fcid]').forEach((e) => e.remove());
  const item = TL.locate(S.tl, Math.min(S.t, Math.max(0, TL.duration(S.tl) - 0.001)));
  if (!item) { vid.removeAttribute('src'); vid.load(); S.cur = null; $('ov').textContent = ''; return; }
  vid.style.visibility = S.tl.trackState && S.tl.trackState['1'] && S.tl.trackState['1'].visible === false ? 'hidden' : 'visible';
  if (item.clip.type === 'image') { vid.removeAttribute('src'); vid.dataset.src = ''; vid.poster = fileUrl(item.clip.src); S.cur = item.clip.id; vid.style.transform = previewTransform(item.clip, S.t - item.start); vid.style.opacity = String(TL.evaluateKeyframes(item.clip, 'alpha', S.t - item.start, (item.clip.transform || {}).alpha ?? 1)); drawText(); return; }
  vid.removeAttribute('poster');
  const c = item.clip;
  if (S.cur !== c.id || force) {
    const url = fileUrl(c.src);
    if (vid.dataset.src !== url) { vid.src = url; vid.dataset.src = url; }
    S.cur = c.id;
  }
  const sp = c.speed || 1, want = c.in + (S.t - item.start) * sp;
  vid.playbackRate = sp;
  if (!S.playing || Math.abs(vid.currentTime - want) > 0.3) vid.currentTime = Math.max(0, want);
  vid.style.transform = previewTransform(c, S.t - item.start);
  vid.style.opacity = String(TL.evaluateKeyframes(c, 'alpha', S.t - item.start, (c.transform || {}).alpha ?? 1));
  vid.volume = Math.min(1, c.volume ?? 1);
  drawText();
}
function drawFreeMainClips() {
  const ov = $('ov'), live = new Set();
  const items = TL.layout(S.tl).filter((i) => S.t >= i.start && S.t < i.end && !(S.tl.trackState?.[String(Number(i.clip.track) || 1)]?.visible === false)).sort((a, b) => (Number(a.clip.track) || 1) - (Number(b.clip.track) || 1));
  items.forEach(({ clip: c, start }) => {
    live.add(c.id); let e = ov.querySelector(`[data-fcid="${c.id}"]`);
    if (!e) { e = document.createElement(c.type === 'image' ? 'img' : 'video'); e.className = 'free-main-clip'; e.dataset.fcid = c.id; e.src = fileUrl(c.src); if (e.tagName === 'VIDEO') { e.playsInline = true; e.muted = true; } ov.insertBefore(e, ov.firstChild); }
    e.style.display = 'block'; e.style.zIndex = String(10 + (Number(c.track) || 1) * 10);
    const local = (S.t - start) * (c.speed || 1), tr = c.transform || {};
    e.style.transformOrigin = 'center center'; e.style.transform = `translate(calc(-50% + ${TL.evaluateKeyframes(c, 'x', local, tr.x || 0) * 100}%), calc(-50% + ${TL.evaluateKeyframes(c, 'y', local, tr.y || 0) * 100}%)) rotate(${TL.evaluateKeyframes(c, 'rotation', local, tr.rotation || 0)}deg) scale(${TL.evaluateKeyframes(c, 'scaleX', local, tr.scaleX || 1) * (c.zoom || 1)}, ${TL.evaluateKeyframes(c, 'scaleY', local, tr.scaleY || 1)})`;
    e.style.opacity = String(Math.max(0, Math.min(1, TL.evaluateKeyframes(c, 'alpha', local, tr.alpha ?? 1))));
    if (e.tagName === 'VIDEO') { const want = c.in + local; e.muted = true; e.volume = Math.max(0, Math.min(1, TL.evaluateKeyframes(c, 'volume', local, c.volume ?? 1))); if (Math.abs(e.currentTime - want) > 0.25) e.currentTime = Math.max(0, want); if (S.playing) e.play().catch(() => {}); else e.pause(); }
  });
  ov.querySelectorAll('[data-fcid]').forEach((e) => { if (!live.has(e.dataset.fcid)) { e.pause?.(); e.remove(); } });
}

function drawLayers() {
  const ov = $('ov'), live = new Set();
  (S.tl.layers || []).filter((o) => (!(S.tl.trackState && S.tl.trackState[String(Number(o.track) || 2)] && S.tl.trackState[String(Number(o.track) || 2)].visible === false) && S.t >= o.start && S.t < o.start + (o.out - o.in))).forEach((o) => {
    live.add(o.id);
    let e = ov.querySelector(`[data-lid="${o.id}"]`);
    if (!e) { e = document.createElement(o.type === 'image' ? 'img' : 'video'); e.className = 'lay'; e.dataset.lid = o.id; e.src = fileUrl(o.src); if (o.type !== 'image') e.muted = true; ov.append(e); }
    const lt = S.t - o.start;
    e.style.left = TL.evaluateKeyframes(o, 'x', lt, o.x) * 100 + '%'; e.style.top = TL.evaluateKeyframes(o, 'y', lt, o.y) * 100 + '%';
    e.style.width = TL.evaluateKeyframes(o, 'scale', lt, o.scale) * 100 + '%'; e.style.opacity = TL.evaluateKeyframes(o, 'opacity', lt, o.opacity);
    e.style.transform = `translate(-50%, -50%) rotate(${TL.evaluateKeyframes(o, 'rotation', lt, o.rotation || 0)}deg)`;
    if (o.type !== 'image') { const want = o.in + lt; e.muted = !!S.tl.trackState?.[String(Number(o.track) || 2)]?.muted || !o.hasAudio; e.volume = Math.max(0, Math.min(1, TL.evaluateKeyframes(o, 'volume', lt, o.volume ?? 1))); if (Math.abs(e.currentTime - want) > 0.4) e.currentTime = want; if (S.playing) e.play().catch(() => {}); else e.pause(); }
  });
  ov.querySelectorAll('[data-lid]').forEach((e) => { if (!live.has(e.dataset.lid)) e.remove(); });
}
function drawAudioTracks() {
  const ov = $('ov'), live = new Set();
  const sources = [
    ...(S.tl.mode === 'free' ? TL.layout(S.tl).filter((i) => S.t >= i.start && S.t < i.end && i.clip.hasAudio && i.clip.type !== 'image').map((i) => ({ id: 'main-' + i.clip.id, src: i.clip.src, start: i.start, in: i.clip.in, out: i.clip.out, speed: i.clip.speed || 1, volume: i.clip.volume ?? 1, keyframes: i.clip.keyframes || {}, muted: !!S.tl.trackState?.[String(Number(i.clip.track) || 1)]?.muted })) : []),
    ...(S.tl.audio || []).filter((a) => S.t >= a.start && S.t < a.start + a.out - a.in).map((a) => ({ id: a.id, src: a.src, start: a.start, in: a.in, out: a.out, speed: 1, volume: a.volume ?? 1, keyframes: a.keyframes || {}, muted: false })),
    ...(S.tl.music?.src ? [{ id: '__music__', src: S.tl.music.src, start: 0, in: 0, out: Math.max(1, TL.duration(S.tl)), speed: 1, volume: S.tl.music.volume ?? 0.25, keyframes: {}, muted: false, loop: true }] : [])
  ];
  sources.forEach((a) => { live.add(a.id); let e = ov.querySelector(`[data-aid="${a.id}"]`); if (!e) { e = document.createElement('audio'); e.dataset.aid = a.id; e.src = fileUrl(a.src); e.preload = 'auto'; e.loop = !!a.loop; ov.append(e); } const local = S.t - a.start; const want = a.in + local * (a.speed || 1); e.playbackRate = a.speed || 1; if (Number.isFinite(e.duration) && e.duration > 0 && a.loop) { const target = want % e.duration; if (Math.abs(e.currentTime - target) > 0.7) e.currentTime = target; } else if (Math.abs(e.currentTime - want) > 0.5) e.currentTime = Math.max(0, want); e.volume = Math.max(0, Math.min(1, TL.evaluateKeyframes(a, 'volume', local, a.volume))); if (S.playing && !a.muted) e.play().catch(() => {}); else e.pause(); });
  ov.querySelectorAll('[data-aid]').forEach((e) => { if (!live.has(e.dataset.aid)) { e.pause(); e.remove(); } });
}
function drawText() {
  drawLayers();
  drawAudioTracks();
  const ov = $('ov'); ov.querySelectorAll('.otxt').forEach((e) => e.remove());
  const h = $('screen').clientHeight;
  S.tl.text.filter((o) => S.t >= o.start && S.t < o.start + o.dur).forEach((o) => {
    const d = document.createElement('div'); d.className = 'otxt'; d.textContent = o.text;
    d.style.color = o.color; d.style.fontSize = (o.size * h / 720) + 'px';
    if (o.pos === 'top') d.style.top = '8%'; else if (o.pos === 'center') d.style.top = '45%'; else d.style.bottom = '8%';
    ov.append(d);
  });
}
function maxTimelineFrame() {
  const duration = Math.max(0, TL.duration(S.tl));
  return Math.max(0, Math.ceil(duration * TL.frameRateValue(S.tl) - 1e-9) - 1);
}
function seekFrame(frame) {
  const target = Math.max(0, Math.min(maxTimelineFrame(), Math.trunc(Number(frame) || 0)));
  S.t = TL.frameToSeconds(target, S.tl);
  if (S.playing && timelinePlayback.readyState >= 1) { timelinePlayback.currentTime = S.t; moveHead(); return; }
  updatePreview(false); moveHead();
  if (!S.playing) requestCanonicalPreview();
}
function seek(t) { seekFrame(TL.secondsToFrame(Math.max(0, Math.min(Number(t) || 0, TL.duration(S.tl))), S.tl)); }

// Paused/scrubbed frames and continuous playback are both generated by the
// FFmpeg export graph. Playback uses a low-resolution CFR render of the whole
// timeline, so effects, transitions, overlays, titles, and mixed audio stay aligned.
function requestCanonicalPreview() {
  timelinePlayback.pause(); timelinePlayback.hidden = true;
  const token = ++S.previewToken;
  if (S.previewTimer) clearTimeout(S.previewTimer);
  window.frosty.cancelPreview?.();
  if (S.playing || !(S.tl.video.length || S.tl.layers?.length || S.tl.text?.length)) {
    canonicalPreview.hidden = true;
    return;
  }
  canonicalPreview.hidden = true;
  const frame = TL.secondsToFrame(S.t, S.tl);
  const payload = { timeline: TL.clone(S.tl), sequences: TL.clone(S.sequences || {}), frame, preset: $('preset').value, fps: TL.frameRateString(S.tl) };
  S.previewTimer = setTimeout(async () => {
    try {
      const result = await call(window.frosty.previewFrame(payload));
      if (token !== S.previewToken || S.playing) return;
      canonicalPreview.src = result.dataUrl;
      canonicalPreview.hidden = false;
    } catch (e) {
      if (token === S.previewToken) {
        canonicalPreview.hidden = true;
        vid.style.visibility = 'visible'; $('ov').style.visibility = 'visible';
        updatePreview(false);
        console.warn('Canonical FFmpeg preview failed; showing the live source-preview fallback:', e);
      }
    }
  }, 70);
}

function stopTimelinePlayback(showStill = true) {
  S.playing = false;
  timelinePlayback.pause();
  timelinePlayback.hidden = true;
  vid.pause();
  $('bPlay').textContent = '▶';
  if (showStill) { seek(S.t); requestCanonicalPreview(); }
}
function tick() {
  if (!S.playing) return;
  const duration = TL.duration(S.tl);
  const frame = Math.max(0, Math.min(maxTimelineFrame(), TL.secondsToFrame(timelinePlayback.currentTime || 0, S.tl)));
  S.t = TL.frameToSeconds(frame, S.tl);
  moveHead();
  if (timelinePlayback.ended || S.t >= duration - TL.frameDuration(S.tl)) {
    S.t = TL.frameToSeconds(maxTimelineFrame(), S.tl);
    stopTimelinePlayback(false);
    requestCanonicalPreview();
    return;
  }
  requestAnimationFrame(tick);
}
async function togglePlay() {
  if (S.playing) { stopTimelinePlayback(true); return; }
  if (!S.tl.video.length && !S.tl.layers?.length && !S.tl.text?.length) return;
  const renderToken = ++S.previewRenderToken;
  const preset = $('preset').value;
  const payload = { timeline: TL.clone(S.tl), sequences: TL.clone(S.sequences || {}), preset };
  status('Rendering unified timeline playback preview…');
  $('bPlay').disabled = true;
  timelinePlayback.hidden = true;
  window.frosty.cancelPreview?.();
  try {
    const result = await call(window.frosty.previewMovie(payload));
    if (renderToken !== S.previewRenderToken) return;
    S.previewMovie = result;
    S.previewMovieKey = JSON.stringify({ timeline: payload.timeline, preset });
    const url = result.url;
    if (timelinePlayback.src !== url) timelinePlayback.src = url;
    await new Promise((resolve, reject) => {
      if (timelinePlayback.readyState >= 1 && timelinePlayback.src === url) return resolve();
      const onReady = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('The rendered preview video could not be opened.')); };
      const cleanup = () => { timelinePlayback.removeEventListener('loadedmetadata', onReady); timelinePlayback.removeEventListener('error', onError); };
      timelinePlayback.addEventListener('loadedmetadata', onReady, { once: true });
      timelinePlayback.addEventListener('error', onError, { once: true });
      timelinePlayback.load();
    });
    if (renderToken !== S.previewRenderToken) return;
    const startFrame = S.t >= TL.duration(S.tl) - TL.frameDuration(S.tl) ? 0 : TL.secondsToFrame(S.t, S.tl);
    timelinePlayback.currentTime = TL.frameToSeconds(startFrame, result.fps || S.tl);
    vid.pause(); vid.style.visibility = 'hidden';
    $('ov').style.visibility = 'hidden';
    canonicalPreview.hidden = true;
    timelinePlayback.hidden = false;
    S.playing = true;
    $('bPlay').textContent = '⏸';
    status('');
    await timelinePlayback.play();
    requestAnimationFrame(tick);
  } catch (e) {
    if (renderToken === S.previewRenderToken) {
      status(''); log('⚠ Unified preview playback failed: ' + e.message);
      S.playing = false; timelinePlayback.hidden = true; requestCanonicalPreview();
    }
  } finally {
    $('bPlay').disabled = false;
  }
}
timelinePlayback.addEventListener('ended', () => {
  if (!S.playing) return;
  S.t = TL.frameToSeconds(maxTimelineFrame(), S.tl);
  stopTimelinePlayback(false); requestCanonicalPreview();
});
window.frosty.on('preview:movie:progress', (p) => {
  if (!S.playing && p?.phase === 'rendering') status(`Rendering playback preview… ${Math.round((p.progress || 0) * 100)}%`);
  else if (p?.phase === 'ready') status('');
});

// ---------- editing actions ----------
function deleteSelected() {
  const clip = TL.layout(S.tl).find((i) => i.clip.id === S.sel);
  if (clip) { commit(); TL.deleteRange(S.tl, clip.start, clip.end); S.sel = null; }
  else if ((S.tl.layers || []).some((o) => o.id === S.sel) || (S.tl.audio || []).some((o) => o.id === S.sel)) { commit(); S.tl.layers = S.tl.layers.filter((o) => o.id !== S.sel); S.tl.audio = S.tl.audio.filter((o) => o.id !== S.sel); S.sel = null; }
  else if (S.tl.text.some((o) => o.id === S.sel)) { commit(); S.tl.text = S.tl.text.filter((o) => o.id !== S.sel); S.sel = null; }
  renderAll();
}
function splitHere() { commit(); if (!TL.splitAt(S.tl, S.t)) S.undo.pop(); renderAll(); }

async function importMedia() {
  const items = await call(window.frosty.importMedia());
  for (const m of items) {
    if (!m.hasVideo) { S.tl.music = { src: m.path, volume: 0.25 }; log('Using ' + m.name + ' as background music'); continue; }
    S.media.push(m);
  }
  renderAll();
}

// ---------- AI actions ----------
const uniqueSrcs = () => [...new Set(S.tl.video.filter((c) => c.hasAudio).map((c) => c.src))];

async function removeSilences() {
  if (!S.tl.video.length) throw new Error('Add a clip first.');
  commit();
  let total = 0;
  for (const src of uniqueSrcs()) {
    status('Detecting silence in ' + src.split(/[\\/]/).pop() + '…');
    const ranges = await call(window.frosty.silence(src, { noiseDb: -32, minDur: 0.6 }));
    const trimmed = ranges.map(([a, b]) => [a + 0.15, b - 0.15]).filter(([a, b]) => b - a > 0.1);
    trimmed.forEach(([a, b]) => (total += b - a));
    TL.removeSourceRanges(S.tl, src, trimmed);
  }
  status(''); log(`Removed ${total.toFixed(1)}s of silence`); seek(0); renderAll();
}

async function autoCaptions() {
  if (!S.tl.video.length) throw new Error('Add a clip first.');
  commit();
  const per = {};
  for (const src of uniqueSrcs()) { status('Transcribing (local Whisper)…'); per[src] = await call(window.frosty.transcribe(src)); }
  S.tl.text = S.tl.text.filter((o) => !o.caption);
  let n = 0;
  for (const { clip, start } of TL.layout(S.tl)) {
    for (const s of per[clip.src] || []) {
      const lo = Math.max(s.start, clip.in), hi = Math.min(s.end, clip.out);
      if (hi - lo < 0.3) continue;
      TL.addText(S.tl, s.text, start + lo - clip.in, hi - lo, { caption: true, size: 40 }); n++;
    }
  }
  status(''); log(`Added ${n} captions`); renderAll();
}

async function runAI() {
  const request = $('prompt').value.trim();
  if (!request) throw new Error('Describe the edit you want.');
  if (!S.tl.video.length) throw new Error('Add a clip first.');
  const before = JSON.stringify(S.tl);
  const r = await call(window.frosty.agent({ request, timeline: S.tl, history: S.hist.slice(-6), video: $('useVid').checked, assets: S.media, permissions: { web: $('permWeb').checked, downloads: $('permDownloads').checked, imageGeneration: $('permImages').checked } }));
  const verification = r.verification;
  if (!verification || !verification.valid || !verification.verified) {
    const errors = (verification?.errors || ['The agent did not return a successful validation report.']).join('\n');
    throw new Error(`AI changes were not applied because validation failed:\n${errors}`);
  }
  const diff = verification.diff || { added: [], removed: [], changed: [] };
  const describe = (arr) => arr.slice(0, 12).map(x => `${x.group}: ${x.name}`).join('\n') || 'None';
  const review = `Review AI changes before applying\n\nSummary: ${r.summary}\n\nAdded (${diff.added.length}):\n${describe(diff.added)}\n\nRemoved (${diff.removed.length}):\n${describe(diff.removed)}\n\nChanged (${diff.changed.length}):\n${describe(diff.changed)}\n\nValidation: passed${verification.warnings?.length ? `\nWarnings: ${verification.warnings.join('; ')}` : ''}\n\nApply these reversible timeline changes?`;
  if (!window.confirm(review)) { status(''); log('AI edit discarded by user; original timeline was preserved.'); return; }
  commit(); S.tl = r.timeline; (r.media || []).forEach((m) => S.media.push(m));
  S.hist.push({ role: 'user', content: request }, { role: 'assistant', content: r.summary });
  status(''); log(`AI: ${r.summary}${r.cost ? ` ($${r.cost.toFixed(4)})` : ''}\nValidation passed; added ${diff.added.length}, removed ${diff.removed.length}, changed ${diff.changed.length}. Undo is available.\n  - ` + (r.log.join('\n  - ') || 'no edits')); seek(0); renderAll();
}

async function splitScenes() {
  if (!S.tl.video.length) throw new Error('Add a clip first.');
  commit(); let n = 0;
  for (const src of [...new Set(S.tl.video.map((c) => c.src))]) {
    status('Detecting scenes…'); const ts = await call(window.frosty.scenes(src, 0.3)); n += ts.length; TL.splitSource(S.tl, src, ts);
  }
  status(''); log(`Split at ${n} scene cut(s)`); renderAll();
}

async function indexMediaLibrary() {
  if (!S.media.length) throw new Error('Import video/audio media first.');
  const r = await call(window.frosty.indexMedia({ files: S.media.filter((m) => m.hasVideo).map((m) => m.path), useVision: $('indexVision').checked }));
  status(''); log(`Scene index updated: ${r.added} new scenes; ${r.totalScenes} searchable total; ${r.embeddedScenes || 0} with embeddings (${r.embeddingMode || 'lexical'} retrieval).${r.embeddingStatus?.coolingDown ? ` Embedding service cooldown: ${r.embeddingStatus.lastError || 'unavailable'}; lexical search remains available.` : ''}`);
}
async function searchSceneLibrary() {
  const q = $('sceneQuery').value.trim();
  if (!q) throw new Error('Enter a scene search query.');
  const results = await call(window.frosty.searchScenes(q));
  const el = $('sceneResults'); el.textContent = '';
  if (!results.length) { el.textContent = 'No matches. Index your media first.'; return; }
  results.forEach((r) => {
    const d = document.createElement('div'); d.className = 'item scene-hit';
    const title = document.createElement('span'); title.className = 'nm2'; title.textContent = `${r.name} · ${fmt(r.start)}–${fmt(r.end)}`;
    const desc = document.createElement('span'); desc.className = 'muted'; desc.textContent = `${r.matchType || 'lexical'}${Number.isFinite(r.semanticScore) ? ` · semantic ${(r.semanticScore * 100).toFixed(0)}%` : ''} · ${(r.caption || r.transcript || 'No transcript/caption available').slice(0, 150)}`;
    const add = document.createElement('button'); add.className = 'small mini'; add.textContent = 'Add scene'; add.onclick = (e) => {
      e.stopPropagation(); const m = S.media.find((x) => x.path === r.src);
      if (!m) { log('Re-import this source file before adding the scene.'); return; }
      commit(); const c = TL.addClip(S.tl, m); c.in = r.start; c.out = r.end; S.sel = c.id; renderAll(); log(`Added scene ${fmt(r.start)}–${fmt(r.end)} from ${r.name}`);
    };
    d.append(title, desc, add); el.append(d);
  });
  log(`Scene search: ${results.length} result(s) for “${q}”.`);
}

async function loadModels() {
  S.models = await call(window.frosty.models());
  const dl = $('modelList'); dl.textContent = '';
  S.models.forEach((m) => { const o = document.createElement('option'); o.value = m.id; o.label = `${m.name} ${m.vision ? '👁' : ''}${m.video ? '🎬' : ''}${m.tools ? '🔧' : ''}${m.imageOut ? '🖼' : ''} $${m.price}/M`; dl.append(o); });
  $('mInfo').textContent = `${S.models.length} models · 👁 vision 🎬 video 🔧 tools 🖼 image-out (agent mode needs 🔧)`;
}

async function makeBrag() {
  const name = $('gName').value.trim(); if (!name) throw new Error('Give the project a name.');
  S.bragName = name; S.bragTagline = $('gTag').value.trim(); S.bragFeatures = $('gFeat').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean); S.bragSoundtrack = '';
  const { scenes } = await call(window.frosty.brag({ name, tagline: S.bragTagline, features: S.bragFeatures.join('\n'), useAI: $('gAI').checked, draftOnly: true }));
  S.bragScenes = scenes; renderStoryboard(); $('bsMusicName').textContent = 'No soundtrack selected'; $('bsShareCopy').value = ''; updateBragDuration();
  $('dStoryboard').showModal(); status('');
}
function renderStoryboard() {
  const host = $('bsScenes'); host.textContent = '';
  const imageMedia = S.media.filter(m => m.type === 'image' || /\.(png|jpe?g|webp)$/i.test(m.path || ''));
  S.bragScenes.forEach((scene, index) => {
    const card = document.createElement('div'); card.className = 'story-card';
    const title = document.createElement('label'); title.textContent = `Scene ${index + 1} title`;
    const titleInput = document.createElement('input'); titleInput.value = scene.title || ''; titleInput.maxLength = 180; titleInput.onchange = () => { scene.title = titleInput.value; }; title.append(titleInput);
    const sub = document.createElement('label'); sub.textContent = 'Subtitle / message';
    const subInput = document.createElement('textarea'); subInput.value = scene.subtitle || ''; subInput.maxLength = 360; subInput.onchange = () => { scene.subtitle = subInput.value; }; sub.append(subInput);
    const settings = document.createElement('div');
    const templateLabel = document.createElement('label'); templateLabel.textContent = 'Layout';
    const template = document.createElement('select'); ['hook','feature','stat','code','cta'].forEach(v => template.add(new Option(v, v))); template.value = scene.template || 'feature'; template.onchange = () => { scene.template = template.value; }; templateLabel.append(template);
    const bgLabel = document.createElement('label'); bgLabel.textContent = 'Background'; const bg = document.createElement('input'); bg.type = 'color'; bg.value = /^#[0-9a-f]{6}$/i.test(scene.bg || '') ? scene.bg : '#101a2b'; bg.oninput = () => { scene.bg = bg.value; }; bgLabel.append(bg);
    const acLabel = document.createElement('label'); acLabel.textContent = 'Accent'; const ac = document.createElement('input'); ac.type = 'color'; ac.value = /^#[0-9a-f]{6}$/i.test(scene.accent || '') ? scene.accent : '#6cc7ff'; ac.oninput = () => { scene.accent = ac.value; }; acLabel.append(ac);
    const shot = document.createElement('label'); shot.className = 'story-shot'; shot.textContent = 'Product image / captured still'; const imageSelect = document.createElement('select'); imageSelect.add(new Option('No image', '')); imageMedia.forEach(m => imageSelect.add(new Option(m.name || m.path, m.path))); imageSelect.value = scene.imagePath || ''; imageSelect.onchange = () => { scene.imagePath = imageSelect.value; }; shot.append(imageSelect);
    settings.append(templateLabel, bgLabel, acLabel, shot);
    const actions = document.createElement('div'); actions.className = 'story-actions';
    const button = (text, fn, disabled = false) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'small'; b.textContent = text; b.disabled = disabled; b.onclick = fn; return b; };
    actions.append(button('↑', () => { if (index) { [S.bragScenes[index - 1], S.bragScenes[index]] = [S.bragScenes[index], S.bragScenes[index - 1]]; renderStoryboard(); } }, index === 0), button('↓', () => { if (index < S.bragScenes.length - 1) { [S.bragScenes[index + 1], S.bragScenes[index]] = [S.bragScenes[index], S.bragScenes[index + 1]]; renderStoryboard(); } }, index === S.bragScenes.length - 1), button('Duplicate', () => { S.bragScenes.splice(index + 1, 0, { ...scene, imageData: '' }); renderStoryboard(); }), button('Remove', () => { if (S.bragScenes.length > 1) { S.bragScenes.splice(index, 1); renderStoryboard(); } }, S.bragScenes.length === 1));
    card.append(title, sub, settings, actions); host.append(card);
  });
}
function updateBragDuration() {
  const sceneSec = Number($('bsSceneSec')?.value || 3);
  const total = Math.max(0, S.bragScenes.length * sceneSec);
  const mins = Math.floor(total / 60), secs = total % 60;
  const label = $('bsDuration'); if (label) label.textContent = `Estimated duration: ${mins}:${String(secs).padStart(2, '0')} · ${S.bragScenes.length} scenes`;
}
async function saveBragDraft() {
  if (!S.bragScenes.length) throw new Error('Draft a storyboard before saving it.');
  const r = await call(window.frosty.bragSaveDraft({ name: S.bragName || 'launch-storyboard', scenes: S.bragScenes, soundtrack: S.bragSoundtrack, metadata: { tagline: S.bragTagline, features: S.bragFeatures, platform: $('bsPlatform').value, shareUrl: $('bsShareUrl').value, sceneSec: Number($('bsSceneSec').value || 3), resolution: $('bsResolution').value, fps: Number($('bsFps').value || 30) } }));
  if (r) log(`Brag storyboard saved: ${r.path}`);
}
async function openBragDraft() {
  const r = await call(window.frosty.bragOpenDraft()); if (!r) return;
  S.bragName = r.name || 'Launch'; S.bragTagline = r.metadata?.tagline || ''; S.bragFeatures = Array.isArray(r.metadata?.features) ? r.metadata.features : [];
  S.bragScenes = r.scenes; S.bragSoundtrack = r.soundtrack || '';
  $('gName').value = S.bragName; $('gTag').value = S.bragTagline; $('gFeat').value = S.bragFeatures.join('\n');
  $('bsMusicName').textContent = S.bragSoundtrack ? S.bragSoundtrack.split(/[\\/]/).pop() : 'No soundtrack selected';
  $('bsPlatform').value = ['general','youtube','instagram','tiktok','linkedin','x'].includes(r.metadata?.platform) ? r.metadata.platform : 'general';
  $('bsShareUrl').value = r.metadata?.shareUrl || ''; $('bsSceneSec').value = String([2,3,4,5,6,8,10].includes(Number(r.metadata?.sceneSec)) ? Number(r.metadata.sceneSec) : 3);
  $('bsResolution').value = ['1280x720','1920x1080','1080x1920','1080x1080','3840x2160'].includes(r.metadata?.resolution) ? r.metadata.resolution : '1280x720';
  $('bsFps').value = String([24,25,30,50,60].includes(Number(r.metadata?.fps)) ? Number(r.metadata.fps) : 30);
  renderStoryboard(); updateBragDuration(); $('dStoryboard').showModal();
  if (S.bragSoundtrack && !/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(S.bragSoundtrack)) log('The saved soundtrack path may need to be reselected.');
  log(`Brag storyboard opened: ${r.path}`);
}
async function makeBragShareCopy() {
  const text = await call(window.frosty.bragShareCopy({ name: S.bragName, tagline: S.bragTagline, features: S.bragFeatures, platform: $('bsPlatform').value, url: $('bsShareUrl').value }));
  $('bsShareCopy').value = text;
}
async function renderBragStoryboard() {
  if (!S.bragScenes.length) throw new Error('Add at least one storyboard scene.');
  const [width, height] = $('bsResolution').value.split('x').map(Number);
  const sceneSec = Number($('bsSceneSec').value || 3), fps = Number($('bsFps').value || 30);
  status(`Rendering Brag launch video (${width}×${height} at ${fps} fps)…`);
  const result = await call(window.frosty.bragRender({ scenes: S.bragScenes, soundtrack: S.bragSoundtrack, sceneSec, width, height, fps }));
  $('dStoryboard').close(); S.media.push(result.media); commit(); TL.addClip(S.tl, result.media); status(''); log(`Brag launch video rendered: ${result.output?.width}×${result.output?.height}, ${result.output?.fps} fps, ${result.output?.duration}s from ${S.bragScenes.length} editable scenes${S.bragSoundtrack ? ' with soundtrack (if source path was available)' : ''}. Added to timeline.${result.warnings?.length ? '\nWarnings: ' + result.warnings.join(' ') : ''}`); renderAll();
}
async function fetchReachTranscript() {
  const url = $('rtUrl').value.trim(); if (!url) throw new Error('Paste a public video URL first.');
  $('rtInfo').textContent = 'Checking available caption tracks…'; $('rtText').value = '';
  const result = await call(window.frosty.reachTranscript(url)); $('rtText').value = result.transcript; $('rtInfo').textContent = `Source: ${result.source} · language: ${result.language} · ${result.transcript.split(/\s+/).filter(Boolean).length} words${result.fallbackReason ? ' · captions unavailable; used local Whisper' : ''}`;
}


async function analyzeCurrentTimeline() {
  $('analysisSummary').textContent = 'Analyzing timeline…';
  const report = await call(window.frosty.analyzeTimeline({ timeline: S.tl, options: { scopes: true, includeTranscript: $('analysisTranscribe').checked } }));
  const lines = [
    `Timeline: ${report.timeline.durationSeconds}s · ${report.timeline.frameRate} fps`,
    `Clips: ${report.timeline.videoClipCount} video · ${report.timeline.overlayCount} overlays · ${report.timeline.audioClipCount} audio · ${report.timeline.textOverlayCount} text`,
    `Sources: ${report.timeline.sourceCount} · scenes detected: ${report.aggregate.totalDetectedScenes}`,
    `Detected silence: ${report.aggregate.totalDetectedSilenceSeconds}s · black intervals: ${report.aggregate.totalBlackSeconds || 0}s · possible freezes: ${report.aggregate.totalFreezeSegments || 0} · mean source loudness: ${report.aggregate.meanSourceIntegratedLufs == null ? 'unavailable' : report.aggregate.meanSourceIntegratedLufs + ' LUFS'}`,
    `Clip validation issues: ${(report.clipIssues || []).length} · report formats: JSON, CSV, HTML`,
    `Missing media: ${report.missingMedia.length} · warnings: ${report.warnings.length}`,
    ...report.warnings.map(w => `⚠ ${w}`),
    ...report.mediaReports.map(r => `${r.name}: ${r.summary.resolution || 'audio only'} · ${r.summary.durationSeconds}s · ${r.audio?.integratedLufs == null ? 'LUFS n/a' : r.audio.integratedLufs + ' LUFS'} · ${r.scenes.length} cuts · ${(r.blackSegments || []).length} black intervals · ${(r.freezeSegments || []).length} freeze intervals · ${r.transcript?.length || 0} transcript segments · ${Object.keys(r.colorScopes || {}).length}/3 scopes`),
    ...(report.clipIssues || []).map(x => `${x.severity.toUpperCase()} [${x.code}] ${x.message}`),
  ];
  $('analysisSummary').textContent = lines.join('\n');
  const meters = $('audioMeters'); meters.textContent = '';
  for (const media of report.mediaReports.filter(r => r.audio)) {
    const row = document.createElement('div'); row.className = 'audio-meter';
    const peak = Number.isFinite(media.audio.peakDbfs) ? media.audio.peakDbfs : null;
    const rms = Number.isFinite(media.audio.rmsDbfs) ? media.audio.rmsDbfs : null;
    const pct = (db) => db == null ? 0 : Math.max(0, Math.min(100, (db + 60) / 60 * 100));
    const label = document.createElement('div'); label.textContent = `${media.name} · Peak ${peak == null ? 'n/a' : peak.toFixed(1) + ' dBFS'} · RMS ${rms == null ? 'n/a' : rms.toFixed(1) + ' dBFS'} · ${media.audio.integratedLufs == null ? 'LUFS n/a' : media.audio.integratedLufs.toFixed(1) + ' LUFS'}`;
    const track = document.createElement('div'); track.className = 'meter-track';
    const fill = document.createElement('div'); fill.className = 'meter-fill'; fill.style.width = `${pct(peak)}%`; track.append(fill); row.append(label, track); meters.append(row);
  }
  const scopes = $('analysisScopes'); scopes.textContent = '';
  for (const media of report.mediaReports) for (const [name, path] of Object.entries(media.colorScopes || {})) {
    const card = document.createElement('div'); card.className = 'scope-card'; card.textContent = `${media.name} · ${name}`;
    const img = document.createElement('img'); img.alt = `${name} color scope for ${media.name}`; img.src = fileUrl(path); card.append(img); scopes.append(card);
  }
  log('Analysis complete. Use Save report to export the full JSON report.');
  if (window.confirm('Analysis complete. Save a report? Choose JSON, CSV or HTML in the save dialog.')) { const saved = await call(window.frosty.saveAnalysisReport(report)); if (saved) log('Analysis report saved: ' + saved); }
}

async function doExport() {
  status('Exporting…');
  const out = await call(window.frosty.exportVideo({ timeline: TL.clone(S.tl), sequences: TL.clone(S.sequences || {}) }, { preset: $('preset').value, fps: TL.frameRateString(S.tl), normalizeAudio: $('audioNormalize').checked, audioLimiter: $('audioLimiter').checked, gpuEncoding: $('gpuEncoding').value }));
  status(''); log(out ? 'Exported to ' + out : 'Export cancelled');
}

// ---------- wiring ----------
$('bImport').onclick = () => guard(importMedia);
$('bProxy').onclick = () => guard(async () => { const clip = S.tl.video.find(c => c.id === S.sel); if (!clip) throw new Error('Select a video clip on the timeline first.'); status('Generating proxy…'); const r = await call(window.frosty.createProxy({ source: clip.src, width: 640, height: 360 })); commit(); clip.proxySrc = r.proxy; clip.proxyEnabled = true; status(''); log(`Proxy ready for ${clip.name || clip.src.split(/[\\/]/).pop()}${r.cached ? ' (cached)' : ''}; playback preview will use it, export keeps the original.`); renderAll(); });
$('bProxyToggle').onclick = () => guard(async () => { const clip = S.tl.video.find(c => c.id === S.sel); if (!clip) throw new Error('Select a video clip on the timeline first.'); if (!clip.proxySrc) throw new Error('Generate a proxy for this clip first.'); commit(); clip.proxyEnabled = !clip.proxyEnabled; log(`Proxy ${clip.proxyEnabled ? 'enabled' : 'disabled'} for preview; export always uses original media.`); renderAll(); });
$('bRelink').onclick = () => guard(async () => { const r = await call(window.frosty.scanAndRelinkProjectMedia({ tl: S.tl, sequences: S.sequences, media: S.media })); if (!r) return; commit(); S.tl = TL.ensure(r.project.tl); S.sequences = r.project.sequences || S.sequences; S.media = r.project.media || S.media; log(`Relink scan: ${r.scanned} media files scanned; ${r.relinked.changed} paths repaired; ${r.missing.length} unresolved; ${r.ambiguous.length} ambiguous.`); if (r.ambiguous.length) log('Ambiguous files: ' + r.ambiguous.map(x => x.basename).join(', ')); if (r.missing.length) log('Missing files: ' + r.missing.map(x => x.basename).join(', ')); renderAll(); });
$('bSeqCreate').onclick = () => guard(async () => { const name = window.prompt('Name this sequence:', `Sequence ${Object.keys(S.sequences).length + 1}`); if (!name) return; const seq = await call(window.frosty.sequence({ project: { tl: S.tl, sequences: S.sequences }, action: 'create', name, timeline: TL.clone(S.tl) })); S.sequences[seq.id] = seq; log(`Created sequence “${seq.name}” (${seq.id}) from the current timeline.`); });
$('bSeqEdit').onclick = () => guard(async () => {
  if (S.editingSequenceId) {
    S.sequences[S.editingSequenceId] = TL.clone(S.tl);
    const name = S.sequences[S.editingSequenceId]?.name || S.editingSequenceId;
    S.tl = TL.ensure(S.mainTimeline || TL.empty()); S.mainTimeline = null; S.editingSequenceId = null;
    log(`Saved edits to “${name}” and returned to the main timeline.`);
  } else {
    const ids = Object.keys(S.sequences); if (!ids.length) throw new Error('Create a sequence first.');
    const listing = ids.map((id, i) => `${i + 1}. ${S.sequences[id].name || id} [${id}]`).join('\n');
    const choice = window.prompt('Enter the sequence number to edit:\n' + listing, '1'); if (choice == null) return;
    const id = ids[Number(choice) - 1]; if (!id) throw new Error('Invalid sequence number.');
    S.mainTimeline = TL.clone(S.tl); S.tl = TL.ensure(TL.clone(S.sequences[id])); S.editingSequenceId = id;
    log(`Editing “${S.sequences[id].name || id}”. Click Edit sequence again to save it and return to the main timeline.`);
  }
  seek(0); renderAll();
});
$('bSeqNest').onclick = () => guard(async () => { const ids = Object.keys(S.sequences); if (!ids.length) throw new Error('Create a sequence first.'); const listing = ids.map((id, i) => `${i + 1}. ${S.sequences[id].name || id} [${id}]`).join('\n'); const choice = window.prompt('Enter the sequence number to nest into the current timeline:\n' + listing, '1'); if (choice == null) return; const id = ids[Number(choice) - 1]; if (!id) throw new Error('Invalid sequence number.'); if (S.editingSequenceId === id) throw new Error('A sequence cannot contain itself.'); const start = S.tl.mode === 'free' ? Math.max(0, S.t) : TL.duration(S.tl); const clip = await call(window.frosty.sequence({ project: { tl: S.tl, sequences: S.sequences }, action: 'nest', parentId: 'root', childId: id, start })); commit(); S.tl.video.push(clip); S.tl.mode = 'free'; log(`Nested “${S.sequences[id].name || id}” at ${start.toFixed(2)}s. Nested content is rendered recursively for preview and export.`); renderAll(); });
$('bTimelineMode').onclick = () => { commit(); const next = S.tl.mode === 'free' ? 'sequential' : 'free'; TL.setTimelineMode(S.tl, next); log(`Timeline mode: ${next}`); renderAll(); };
$('bAddVTrack').onclick = () => { commit(); S.targetTrack = TL.addVideoTrack(S.tl); log(`Added video track V${S.targetTrack}`); renderAll(); };
$('bPlay').onclick = togglePlay; $('bSplit').onclick = splitHere; $('bDel').onclick = deleteSelected;
$('bPrevFrame').onclick = () => seekFrame(TL.secondsToFrame(S.t, S.tl) - 1);
$('bNextFrame').onclick = () => seekFrame(TL.secondsToFrame(S.t, S.tl) + 1);
$('bUndo').onclick = undo; $('bRedo').onclick = redo;
$('bSil').onclick = () => guard(removeSilences); $('bCap').onclick = () => guard(autoCaptions); $('bAI').onclick = () => guard(runAI);
$('bExport').onclick = () => guard(doExport);
$('bAnalyze').onclick = () => guard(analyzeCurrentTimeline);
$('bAnalyzeSide').onclick = () => guard(analyzeCurrentTimeline);
$('bScopesNow').onclick = () => guard(async () => {
  status('Rendering playhead frame and generating color scopes…');
  const frame = TL.secondsToFrame(S.t, S.tl);
  const result = await call(window.frosty.analyzeScopesAtFrame({ timeline: TL.clone(S.tl), sequences: TL.clone(S.sequences || {}), frame, preset: $('preset').value, fps: TL.frameRateString(S.tl) }));
  const host = $('analysisScopes'); host.textContent = '';
  const intro = document.createElement('div'); intro.className = 'muted'; intro.textContent = `Rendered timeline frame ${result.frame} at ${result.time.toFixed(3)}s`; host.append(intro);
  for (const [name, path] of Object.entries(result.scopes)) { const card = document.createElement('div'); card.className = 'scope-card'; card.textContent = name; const img = document.createElement('img'); img.alt = `${name} scope at playhead`; img.src = fileUrl(path) + `?t=${Date.now()}`; card.append(img); host.append(card); }
  status(''); log(`Generated waveform, vectorscope and histogram from timeline frame ${result.frame}.`);
});
$('bMixMeter').onclick = () => guard(async () => {
  status('Rendering a low-resolution mix measurement pass…'); $('mixMeterSummary').textContent = 'Rendering timeline audio and measuring the decoded mix; this may take a while for long projects.';
  const mix = await call(window.frosty.measureTimelineMix({ timeline: TL.clone(S.tl), sequences: TL.clone(S.sequences || {}), options: { normalizeAudio: $('audioNormalize').checked, audioLimiter: $('audioLimiter').checked } }));
  const fmt = (v, suffix) => Number.isFinite(v) ? `${v.toFixed(1)} ${suffix}` : 'unavailable';
  $('mixMeterSummary').textContent = `Final timeline mix · ${mix.durationSeconds}s · Peak ${fmt(mix.peakDbfs, 'dBFS')} · RMS ${fmt(mix.rmsDbfs, 'dBFS')} · Integrated ${fmt(mix.integratedLufs, 'LUFS')} · LRA ${fmt(mix.loudnessRangeLu, 'LU')} · True peak ${fmt(mix.truePeakDbfs, 'dBFS')}
${mix.measurement}`;
  status(''); log('Final timeline mix measured from the rendered output.');
});
$('bMusic').onclick = () => guard(async () => { const p = await call(window.frosty.pickMusic()); if (p) { commit(); S.tl.music = { src: p, volume: 0.25, duck: $('musicDuck').checked }; renderAll(); } });
$('musicDuck').onchange = () => { if (S.tl.music) { commit(); S.tl.music.duck = $('musicDuck').checked; renderAll(); } };
$('bIndex').onclick = () => guard(indexMediaLibrary);
$('bSceneSearch').onclick = () => guard(searchSceneLibrary);
$('sceneQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') guard(searchSceneLibrary); });
$('bSave').onclick = () => guard(async () => { if (S.editingSequenceId) S.sequences[S.editingSequenceId] = TL.clone(S.tl); await call(window.frosty.saveProject({ tl: S.mainTimeline || S.tl, media: S.media, sequences: S.sequences })); log(S.editingSequenceId ? `Project saved with edits to sequence “${S.sequences[S.editingSequenceId]?.name || S.editingSequenceId}”.` : 'Project saved'); });
$('bOpen').onclick = () => guard(async () => { stopTimelinePlayback(false); S.previewRenderToken++; window.frosty.cancelPreviewMovie?.(); const d = await call(window.frosty.openProject()); if (d) { S.previewMovieKey = ''; S.tl = TL.ensure(d.tl); S.media = d.media || []; S.sequences = d.sequences || {}; S.mainTimeline = null; S.editingSequenceId = null; $('musicDuck').checked = !!S.tl.music?.duck; S.undo = []; S.redo = []; seek(0); renderAll(); } });
$('pps').oninput = (e) => { S.pps = +e.target.value; renderTimeline(); };
$('bUrl').onclick = () => $('dUrl').showModal();
function referenceAnalysis() { return S.tl?.referenceTemplate?.analysis || null; }
function renderReferenceReport() {
  const analysis = referenceAnalysis(); if (!analysis) return;
  const blueprint = analysis.blueprint || (analysis.shots || []).map((s) => ({ shot: (s.index || 0) + 1, sourceIn: s.start, sourceOut: s.end, duration: s.duration, pacing: s.duration < 1.05 ? 'rapid' : s.duration < 2.2 ? 'fast' : s.duration < 4.5 ? 'measured' : 'slow', incomingTransition: s.transition, camera: { zoom: s.motion?.zoomDirection || 'unknown', pan: s.motion?.panDirection || 'unknown', activity: s.motion?.activity || 'unknown', confidence: s.motion?.confidence || 'very-low' }, caption: { text: s.captionText || '', segments: (s.transcript || []).length }, animation: s.animation || { titleMotion: 'requires-visual-frame-comparison', confidence: 'unclassified' }, reviewRequired: true }));
  const audioSummary = analysis.audio?.estimatedBpm && analysis.audio?.beatConfidence >= 0.28 ? ` · pulse ${analysis.audio.estimatedBpm} BPM (confidence ${analysis.audio.beatConfidence})` : ` · audio rhythm ${analysis.audio?.rhythmStatus || 'not measured'}`;
  const styleSummary = analysis.visualAnalysis?.styleBible ? ` · visual style guide captured` : '';
  $('referenceReportSummary').textContent = `${blueprint.length} shots · ${analysis.cuts?.count ?? Math.max(0, blueprint.length - 1)} cuts · median ${analysis.pace?.medianShotSeconds ?? '?'}s · caption status ${analysis.captions?.transcriptStatus || 'unknown'} · visual analysis ${analysis.animation?.analysisStatus || 'not classified'}${audioSummary}${styleSummary}.`;
  const root = $('referenceReportRows'); root.replaceChildren();
  for (const shot of blueprint) {
    const row = document.createElement('section'); row.className = 'reference-shot';
    const time = document.createElement('div'); time.className = 'shot-time'; time.textContent = `SHOT ${shot.shot}
${Number(shot.sourceIn || 0).toFixed(2)}–${Number(shot.sourceOut || 0).toFixed(2)}s`;
    const facts = document.createElement('div'); facts.className = 'shot-facts';
    const tr = shot.incomingTransition || { type: 'none', confidence: 'high' }; const cam = shot.camera || {};
    const captionText = shot.caption?.text || '';
    facts.textContent = `${shot.duration}s · ${shot.pacing || 'unknown'} pace
Incoming: ${tr.type || 'unknown'} (${tr.confidence || 'unknown'})${tr.evidence ? ` · ${tr.evidence.windowSamples || 0} samples, peak ${tr.evidence.peakChange ?? '?'}` : ''}
Camera: ${cam.zoom || 'unknown'}, ${cam.pan || 'unknown'}, ${cam.activity || 'unknown'} (${cam.confidence || 'unknown'} confidence)
Caption: ${captionText ? captionText.slice(0, 180) : 'no transcript assigned'}
Visible text: ${(shot.visualEvidence?.visibleText || []).join(' | ') || 'not established'}
Audio cut alignment: ${shot.audioAlignment?.label || 'not estimated'} (${shot.audioAlignment?.confidence || 'low'} confidence)
Animation: ${shot.animation?.entrance || shot.animation?.titleMotion || 'unclassified'} / exit ${shot.animation?.exit || 'unclassified'} / easing ${shot.animation?.easing || 'unclassified'}`;
    const go = document.createElement('button'); go.className = 'small'; go.type = 'button'; go.textContent = 'Go to shot'; go.onclick = () => { seek(Number(shot.sourceIn) || 0); $('dReferenceReport').close(); };
    row.append(time, facts, go); root.append(row);
  }
}
$('bReferenceReport').onclick = () => { if (!referenceAnalysis()) return; renderReferenceReport(); $('dReferenceReport').showModal(); };
$('rExport').onclick = () => { const analysis = referenceAnalysis(); if (!analysis) return; const blob = new Blob([JSON.stringify(analysis, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'frosty-reference-analysis.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };

$('bCopy').onclick = () => { $('cUrl').value = ''; $('copyInfo').textContent = ''; $('referenceSummary').textContent = ''; $('dCopy').showModal(); };
$('cInspect').onclick = (e) => { e.preventDefault(); guard(async () => { const u = $('cUrl').value.trim(); if (!u) throw new Error('Paste a video URL first.'); status('Checking source…'); const m = await call(window.frosty.inspectVideo(u)); $('copyInfo').textContent = `${m.title} · ${Math.ceil(m.duration)}s${m.duration > 120 ? ' — too long (maximum 120 seconds)' : ' — ready to analyze'}`; status(''); }); };
$('cGo').onclick = (e) => { e.preventDefault(); const u = $('cUrl').value.trim(); if (!u) { log('Paste a video URL first.'); return; } if ((S.tl.video.length || S.tl.layers?.length || S.tl.audio?.length || S.tl.text?.length) && !window.confirm('Copy-to-template creates a new timeline from the reference video and replaces the current timeline. Save your current project first if needed. Continue?')) return; $('dCopy').close(); guard(async () => { status('Measuring cuts, captions, camera motion and audio rhythm; AI compares sampled frames when enabled…'); const r = await call(window.frosty.copyTemplate({ url: u, includeCaptions: $('cCaptions').checked, refineWithAI: $('cAI').checked })); commit(); S.tl = r.timeline; S.media.push(...(r.media || [])); S.hist.push({ role: 'user', content: 'Copy video to editable template: ' + u }, { role: 'assistant', content: r.summary }); const a = r.analysis || S.tl.referenceTemplate?.analysis; if (a) { $('referenceSummary').textContent = `Reference analysis · ${a.cuts?.count ?? 0} cuts · median shot ${a.pace?.medianShotSeconds ?? '?'}s (${a.pace?.pace || 'unknown'}) · ${a.captions?.segmentCount ?? 0} transcript segments · ${a.motion?.sampleCount ?? 0} motion samples · ${a.audio?.estimatedBpm && a.audio?.beatConfidence >= 0.28 ? `${a.audio.estimatedBpm} BPM pulse candidate` : (a.audio?.rhythmStatus || 'audio rhythm unavailable')}. Visual evidence: ${a.visualAnalysis?.status || 'not run'}. Transition candidates: ${Object.entries(a.transitions || {}).map(([k,v]) => `${k} ${v}`).join(', ') || 'not measured'}.`; $('bReferenceReport').disabled = false; renderReferenceReport(); } status(''); log(`Copy template: ${r.summary}${r.cost ? ` ($${r.cost.toFixed(4)})` : ''}\n  - ` + (r.log.join('\n  - ') || 'Source imported; no additional edits were applied.')); seek(0); renderAll(); }); };
function motionOpts() { return { type: $('mType').value, theme: $('mTheme').value, shape: $('mShape').value, animation: $('mAnim').value, title: $('mTitle').value, subtitle: $('mSubtitle').value, accent: $('mAccent').value, rotationX: Number($('mRotX').value), rotationY: Number($('mRotY').value), rotationZ: Number($('mRotZ').value), width: S.tl.settings.width || 1920, height: S.tl.settings.height || 1080, duration: Math.max(.2, Math.min(120, Number($('mDuration').value) || 4)), transparent: true, lineArt: true }; }
function populateMotionForm(opts = {}) { $('mType').value = opts.type || 'title-card'; $('mTheme').value = opts.theme || 'studio'; $('mShape').value = opts.shape || 'wireframe-cube'; $('mAnim').value = opts.animation || 'fade-up'; $('mTitle').value = opts.title || 'Make it move.'; $('mSubtitle').value = opts.subtitle || ''; $('mAccent').value = /^#[0-9a-f]{6}$/i.test(opts.accent || '') ? opts.accent : '#7ce7d4'; $('mDuration').value = Math.max(.2, Math.min(120, Number(opts.duration) || 4)); for (const [id,key,fallback] of [['mRotX','rotationX',-24],['mRotY','rotationY',33],['mRotZ','rotationZ',14]]) { $(id).value = String(Math.max(-180, Math.min(180, Number(opts[key] ?? fallback)))); $(`${id}Val`).textContent = `${$(id).value}°`; } }
for (const [id, valueId] of [['mRotX','mRotXVal'],['mRotY','mRotYVal'],['mRotZ','mRotZVal']]) $(id).addEventListener('input', () => { $(`${id}Val`).textContent = `${$(id).value}°`; });
async function refreshMotionPreview() { const opts = motionOpts(); const r = await call(window.frosty.previewMotionGraphic(opts)); $('motionPreview').src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(r.svg); $('motionStatus').textContent = `${opts.type.replace(/-/g, ' ')} · ${opts.theme} theme · ${opts.animation} animation · ${opts.width}×${opts.height}`; }
$('bMotion').onclick = () => { S.motionEditTarget = null; $('mAdd').textContent = 'Add overlay to timeline'; $('mStart').value = S.t.toFixed(1); populateMotionForm({ type: 'title-card', theme: 'studio', shape: 'wireframe-cube', animation: 'fade-up', title: 'Make it move.', subtitle: 'Editable motion graphics', duration: 4 }); $('dMotion').showModal(); guard(refreshMotionPreview); };
$('bMotionEdit').onclick = () => { const layer = (S.tl.layers || []).find((x) => x.id === S.sel); if (!layer?.motionDesign?.options) { log('Select a graphic created in Motion Studio or by the AI motion-graphic tool first.'); return; } S.motionEditTarget = layer.id; const opts = layer.motionDesign.options; populateMotionForm(opts); $('mStart').value = Number(layer.start || 0).toFixed(1); $('mDuration').value = Math.max(.2, Number(layer.out - layer.in) || opts.duration || 4); $('mAdd').textContent = 'Update selected graphic'; $('dMotion').showModal(); guard(refreshMotionPreview); };
$('mRefresh').onclick = (e) => { e.preventDefault(); guard(refreshMotionPreview); };
for (const id of ['mType','mTheme','mShape','mAnim','mTitle','mSubtitle','mAccent','mDuration','mRotX','mRotY','mRotZ']) $(id).addEventListener('change', () => guard(refreshMotionPreview));
$('mAdd').onclick = (e) => { e.preventDefault(); guard(async () => { const opts = { ...motionOpts(), name: $('mTitle').value.trim() || 'Motion graphic' }; status('Rendering transparent motion graphic…'); const asset = await call(window.frosty.createMotionGraphic(opts)); commit(); S.media.push(asset); const start = Math.max(0, Number($('mStart').value) || 0); let layer;
  if (S.motionEditTarget) {
    layer = (S.tl.layers || []).find((x) => x.id === S.motionEditTarget);
    if (!layer) throw new Error('The selected graphic no longer exists on the timeline.');
    layer.src = asset.path; layer.designPath = asset.designPath; layer.name = asset.name; layer.type = 'image'; layer.start = start; layer.in = 0; layer.out = asset.duration; layer.x = .5; layer.y = .5; layer.scale = 1; layer.opacity = 1; layer.keyframes = {}; layer.motionDesign = asset.motionDesign;
  } else { layer = TL.addLayer(S.tl, asset, start, S.targetTrack); layer.out = asset.duration; layer.x = .5; layer.y = .5; layer.scale = 1; layer.opacity = 1; layer.motionDesign = asset.motionDesign; layer.designPath = asset.designPath; }
  const Motion = window.FrostyMotionDesign; if (Motion?.applyAnimation) Motion.applyAnimation(layer, opts.animation || 'fade-up', asset.duration); else layer.animationPreset = opts.animation || 'fade-up'; S.sel = layer.id; const wasEdit = !!S.motionEditTarget; S.motionEditTarget = null; $('mAdd').textContent = 'Add overlay to timeline'; $('dMotion').close(); status(''); log(`${wasEdit ? 'Updated' : 'Added'} ${opts.type} motion graphic “${asset.name}” at ${start.toFixed(2)}s with ${opts.animation} animation. The transparent PNG is on the timeline and its source SVG plus generator settings are retained for further editing.`); renderAll(); }); };

// Reference comparison: synchronized visual inspection plus a quantitative low-resolution pass.
let compareSyncing = false;
let compareReferencePath = null, compareRenderPath = null;
const compareDuration = () => Math.max(0, Number($('cmpResult').duration) || Number($('cmpRef').duration) || 0);
function compareTimeLabel(t) { const safe = Math.max(0, Number(t) || 0); const mm = Math.floor(safe / 60), ss = Math.floor(safe % 60); return `${mm}:${String(ss).padStart(2,'0')}`; }
function updateCompareUI() { const d = compareDuration(), t = Math.min(d, Number($('cmpResult').currentTime) || 0); $('cmpSeek').value = d > 0 ? String(Math.round(1000 * t / d)) : '0'; $('cmpTime').textContent = `${compareTimeLabel(t)} / ${compareTimeLabel(d)}`; }
function syncCompare(from, to, seekTo = false) { if (compareSyncing) return; compareSyncing = true; try { if (seekTo || Math.abs((to.currentTime || 0) - (from.currentTime || 0)) > .16) to.currentTime = Math.max(0, Math.min(Math.max(0, (to.duration || from.duration || 0) - .02), Number(from.currentTime) || 0)); if (from.playbackRate && to.playbackRate !== from.playbackRate) to.playbackRate = from.playbackRate; } catch {} finally { compareSyncing = false; } }
$('bCompare').onclick = () => guard(async () => { const refPath = S.tl.referenceTemplate?.sourcePath || S.tl.referenceTemplate?.analysis?.source?.path; if (!refPath) throw new Error('Use Copy video → template first so Frosty has a reference source to compare.'); $('cmpStatus').textContent = 'Rendering a synchronized low-resolution preview of the current edit…'; $('cmpMetrics').textContent = ''; $('cmpRef').pause(); $('cmpResult').pause(); compareReferencePath = refPath; $('cmpRef').src = fileUrl(refPath); $('cmpRef').muted = true; $('cmpResult').muted = false; const movie = await call(window.frosty.previewMovie({ timeline: S.tl, sequences: S.sequences, preset: $('preset').value })); compareRenderPath = movie.path; $('cmpResult').src = movie.url; $('cmpResult').load(); $('cmpRef').load(); await Promise.all([new Promise((resolve) => { if ($('cmpResult').readyState >= 1) resolve(); else $('cmpResult').addEventListener('loadedmetadata', resolve, { once: true }); }), new Promise((resolve) => { if ($('cmpRef').readyState >= 1) resolve(); else $('cmpRef').addEventListener('loadedmetadata', resolve, { once: true }); })]); $('cmpSeek').value = '0'; updateCompareUI(); $('cmpStatus').textContent = `Ready · ${movie.width}×${movie.height} comparison render · ${movie.cached ? 'cached' : 'rendered now'}. Measure difference to quantify the largest remaining mismatches.`; $('dCompare').showModal(); });
$('cmpMeasure').onclick = () => guard(async () => { if (!compareReferencePath || !compareRenderPath) throw new Error('Open Reference comparison first.'); $('cmpMeasure').disabled = true; $('cmpStatus').textContent = 'Sampling aligned reference/render frames and comparing cut timing…'; try { const result = await call(window.frosty.compareReference({ referencePath: compareReferencePath, renderedPath: compareRenderPath, options: { fps: 2, width: 160, height: 90 } })); const worst = (result.frames?.worst || []).slice(0, 5).map((frame) => `${frame.time.toFixed(2)}s: MAE ${frame.mae}, similarity ${frame.similarityPercent}%`).join('\n') || 'No worst frames reported.'; const cutInfo = result.cuts?.matchedRatio == null ? 'Cut alignment unavailable' : `${result.cuts.matchedReferenceCuts}/${result.cuts.referenceCount} reference cuts aligned within ${result.cuts.matchToleranceSeconds}s`; $('cmpMetrics').textContent = `VISUAL MATCH ESTIMATE\nMean pixel error: ${result.pixel.meanAbsoluteError}/255 · similarity ${result.pixel.similarityPercent}%\nPSNR: ${result.pixel.psnrDb} dB · global SSIM estimate: ${result.pixel.globalSsimEstimate}\nFrames compared: ${result.sampling.comparedFrames} at ${result.sampling.fps} fps (${result.sampling.width}×${result.sampling.height})\nDuration difference: ${result.durationDifferenceSeconds}s · ${cutInfo}\n\nLargest mismatches (sampled frames):\n${worst}\n\nMetrics are low-resolution estimates; check the listed timestamps at full preview resolution.`; $('cmpStatus').textContent = 'Difference analysis complete. Lower pixel error and higher structural similarity indicate a closer visual match.'; log(`Reference comparison: ${result.pixel.similarityPercent}% sampled-frame similarity, ${result.cuts?.matchedReferenceCuts ?? 0}/${result.cuts?.referenceCount ?? 0} cuts aligned.`); } finally { $('cmpMeasure').disabled = false; } });
$('cmpPlay').onclick = async () => { try { const t = Number($('cmpResult').currentTime) || 0; $('cmpRef').currentTime = Math.min(t, Math.max(0, ($('cmpRef').duration || t) - .02)); $('cmpResult').currentTime = t; $('cmpResult').playbackRate = $('cmpRef').playbackRate || 1; await Promise.all([$('cmpRef').play(), $('cmpResult').play()]); } catch (e) { $('cmpStatus').textContent = `Playback could not start: ${e.message}`; } };
$('cmpPause').onclick = () => { $('cmpRef').pause(); $('cmpResult').pause(); };
$('cmpSeek').oninput = () => { const t = compareDuration() * (Number($('cmpSeek').value) / 1000); compareSyncing = true; $('cmpRef').currentTime = Math.min(t, Math.max(0, ($('cmpRef').duration || t) - .02)); $('cmpResult').currentTime = t; compareSyncing = false; updateCompareUI(); };
$('cmpResult').addEventListener('timeupdate', () => { syncCompare($('cmpResult'), $('cmpRef')); updateCompareUI(); });
$('cmpRef').addEventListener('timeupdate', () => { if (!$('cmpResult').paused) syncCompare($('cmpRef'), $('cmpResult')); updateCompareUI(); });
for (const [a,b] of [['cmpResult','cmpRef'],['cmpRef','cmpResult']]) { $(a).addEventListener('play', () => { if ($(b).paused) $(b).play().catch(() => {}); }); $(a).addEventListener('pause', () => { if (!$(b).paused) $(b).pause(); }); $(a).addEventListener('ratechange', () => { if ($(b).playbackRate !== $(a).playbackRate) $(b).playbackRate = $(a).playbackRate; }); }
$('cmpMode').onchange = () => { const wipe = $('cmpMode').value === 'wipe'; $('compareStages').classList.toggle('wipe', wipe); $('cmpWipeLabel').hidden = !wipe; $('compareStages').style.setProperty('--wipe-pct', `${$('cmpWipe').value}%`); };
$('cmpWipe').oninput = () => $('compareStages').style.setProperty('--wipe-pct', `${$('cmpWipe').value}%`);
$('cmpRefAudio').onchange = () => { $('cmpRef').muted = $('cmpRefAudio').checked ? false : true; $('cmpResult').muted = $('cmpRefAudio').checked; };
$('dCompare').addEventListener('close', () => { $('cmpRef').pause(); $('cmpResult').pause(); $('cmpRef').removeAttribute('src'); $('cmpResult').removeAttribute('src'); $('cmpRef').load(); $('cmpResult').load(); });
$('uOk').onclick = (e) => { e.preventDefault(); const u = $('uUrl').value.trim(); $('dUrl').close(); if (u) guard(async () => { status('Downloading…'); S.media.push(await call(window.frosty.download(u))); status(''); log('Downloaded ' + u); renderAll(); }); };
$('bDoc').onclick = () => guard(async () => { (await call(window.frosty.doctor())).forEach((c) => log(`${c.ok ? '✔' : '✘'} ${c.name} — ${c.note}`)); });
$('bReach').onclick = () => guard(async () => { const [rows, capabilities] = await Promise.all([call(window.frosty.reachDiagnostics()), call(window.frosty.reachPlatforms())]); log('Reach adapter registry and diagnostics (registered public-source adapters are not live availability checks; authenticated APIs are not configured):'); rows.forEach((r) => log(`• ${r.platform} [${r.adapter}] — ${r.note}${r.auth ? ` · auth: ${r.auth}` : ''}`)); capabilities.forEach((p) => log(`  ${p.platform}: ${p.status}; operations: ${p.operations.join(', ')}; ${p.implementedBy}`)); });
$('bTranscript').onclick = () => { $('rtUrl').value = ''; $('rtInfo').textContent = ''; $('rtText').value = ''; $('dTranscript').showModal(); };
$('bReachWeb').onclick = () => { $('rwInput').value = ''; $('rwInfo').textContent = ''; $('rwResults').textContent = ''; $('rwText').textContent = ''; $('dReachWeb').showModal(); };
$('rwGo').onclick = (e) => { e.preventDefault(); guard(async () => { const value = $('rwInput').value.trim(); if (!value) throw new Error('Enter a search query or URL.'); $('rwResults').textContent = ''; $('rwText').textContent = ''; $('rwInfo').textContent = 'Working…'; if ($('rwMode').value === 'read') { const result = await call(window.frosty.reachRead(value)); $('rwInfo').textContent = `Read via ${result.platform.platform} adapter · ${result.platform.note}`; $('rwText').textContent = result.text; } else { const results = await call(window.frosty.reachSearch(value)); $('rwInfo').textContent = `${results.length} result(s) · DuckDuckGo with search fallback`; results.forEach(r => { const row = document.createElement('div'); row.className = 'item'; const title = document.createElement('strong'); title.textContent = r.title || r.url; const desc = document.createElement('div'); desc.className = 'muted'; desc.textContent = `${r.url}\n${r.snippet || ''}`; const open = document.createElement('button'); open.className = 'small'; open.textContent = 'Open link'; open.onclick = () => guard(() => call(window.frosty.reachOpenResult(r.url))); row.append(title, desc, open); $('rwResults').append(row); }); } }); };
$('rtFetch').onclick = (e) => { e.preventDefault(); guard(fetchReachTranscript); };
$('rtCopy').onclick = () => { $('rtText').focus(); $('rtText').select(); document.execCommand('copy'); $('rtInfo').textContent = 'Transcript selected/copied where clipboard access is available.'; };
$('bsAdd').onclick = () => { S.bragScenes.push({ template: 'feature', title: 'New scene', subtitle: '', bg: '#101a2b', accent: '#6cc7ff' }); renderStoryboard(); updateBragDuration(); };
$('bsSave').onclick = (e) => { e.preventDefault(); guard(saveBragDraft); };
$('bsOpen').onclick = (e) => { e.preventDefault(); guard(openBragDraft); };
$('bsSceneSec').onchange = updateBragDuration;
$('bsProduct').onclick = (e) => { e.preventDefault(); guard(async () => { const imported = await call(window.frosty.importMedia()); const imgs = imported.filter(m => m.type === 'image' || /\.(png|jpe?g|webp)$/i.test(m.path || '')); if (!imgs.length) { S.media.push(...imported); renderAll(); throw new Error('No image files selected. Choose a PNG, JPEG or WebP product still.'); } S.media.push(...imported); if (S.bragScenes.length) S.bragScenes[0].imagePath = imgs[0].path; renderStoryboard(); renderAll(); log(`Imported ${imgs.length} product image(s) for the Brag storyboard.`); }); };
$('bsMusic').onclick = (e) => { e.preventDefault(); guard(async () => { S.bragSoundtrack = await call(window.frosty.bragPickSoundtrack()) || ''; $('bsMusicName').textContent = S.bragSoundtrack ? S.bragSoundtrack.split(/[\\/]/).pop() : 'No soundtrack selected'; }); };
$('bsMakeCopy').onclick = (e) => { e.preventDefault(); guard(makeBragShareCopy); };
$('bsPlatform').onchange = () => guard(makeBragShareCopy);
$('bsCopyText').onclick = () => { $('bsShareCopy').focus(); $('bsShareCopy').select(); document.execCommand('copy'); log('Share copy selected/copied where clipboard access is available.'); };
$('bsRender').onclick = (e) => { e.preventDefault(); guard(renderBragStoryboard); };
$('bScenes').onclick = () => guard(splitScenes);
$('sLoad').onclick = () => guard(loadModels);
$('sCheck').onclick = () => guard(async () => { const k = await call(window.frosty.keyInfo()); $('mInfo').textContent = `Key OK · used $${(k.usage || 0).toFixed(2)}` + (k.remaining != null ? ` · $${k.remaining.toFixed(2)} left` : ' · no limit'); });
$('bBrag').onclick = () => $('dBrag').showModal();
$('gOk').onclick = (e) => { e.preventDefault(); $('dBrag').close(); guard(makeBrag); };
$('bSettings').onclick = async () => {
  const s = await call(window.frosty.getSettings());
  $('sKey').value = s.apiKey || ''; $('sReachGithub').value = s.reachTokens?.github || ''; $('sReachReddit').value = s.reachTokens?.reddit || ''; $('sReachX').value = s.reachTokens?.x || ''; $('sReachYoutube').value = s.reachTokens?.youtube || '';
  $('sModel').value = s.model; $('sFb').value = s.fallbacks || ''; $('sSort').value = s.sort || ''; $('sImg').value = s.imageModel || ''; $('sWh').value = s.whisper; $('dSettings').showModal();
};
$('sOk').onclick = async (e) => {
  e.preventDefault();
  const result = await call(window.frosty.setSettings({ apiKey: $('sKey').value.trim(), reachTokens: { github: $('sReachGithub').value.trim(), reddit: $('sReachReddit').value.trim(), x: $('sReachX').value.trim(), youtube: $('sReachYoutube').value.trim() }, model: $('sModel').value.trim() || 'google/gemini-2.5-flash', fallbacks: $('sFb').value.trim(), sort: $('sSort').value, imageModel: $('sImg').value.trim(), whisper: $('sWh').value }));
  $('dSettings').close(); log(result?.warning || 'Settings saved');
};
$('tl').onclick = (e) => { const r = $('tl').getBoundingClientRect(); seek((e.clientX - r.left) / S.pps); };
$('ruler').onclick = (e) => { const r = $('tl').getBoundingClientRect(); seek((e.clientX - r.left) / S.pps); };
window.frosty.on('ai:status', status);
window.frosty.on('export:progress', (p) => status(`Exporting… ${Math.round(p * 100)}%`));
window.frosty.on('export:encoder', ({ codec } = {}) => { if (codec) log(`Export encoder: ${codec}${/_(?:nvenc|qsv|amf|videotoolbox)$/.test(codec) ? ' (hardware encoder)' : ' (software fallback)'}.`); });

document.addEventListener('keydown', (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 's' || e.key === 'S') splitHere();
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  else if (e.ctrlKey && e.key.toLowerCase() === 'z') undo();
  else if (e.ctrlKey && e.key.toLowerCase() === 'y') redo();
  else if (e.key === 'ArrowLeft') seekFrame(TL.secondsToFrame(S.t, S.tl) - 1);
  else if (e.key === 'ArrowRight') seekFrame(TL.secondsToFrame(S.t, S.tl) + 1);
});
['Web 720p', 'YouTube 1080p', 'YouTube 1080p High Quality', 'YouTube 1080p 60fps', 'YouTube 4K', 'HEVC 4K', 'Archive Master (High Quality)', 'Small File 720p', 'Vertical 9:16 (Reels/TikTok)', 'Square 1:1'].forEach((p) => $('preset').add(new Option(p, p)));
[
  ['23.976 fps (24000/1001)', '24000/1001'], ['24 fps', '24'], ['25 fps', '25'],
  ['29.97 fps (30000/1001)', '30000/1001'], ['30 fps', '30'], ['50 fps', '50'],
  ['59.94 fps (60000/1001)', '60000/1001'], ['60 fps', '60']
].forEach(([label, value]) => $('projectFps').add(new Option(label, value)));
$('projectFps').onchange = () => {
  commit(); TL.setFrameRate(S.tl, $('projectFps').value);
  S.t = TL.frameToSeconds(Math.min(TL.secondsToFrame(S.t, S.tl), maxTimelineFrame()), S.tl);
  log(`Project frame rate set to ${TL.frameRateString(S.tl)} fps`);
  renderAll();
};
renderAll();
