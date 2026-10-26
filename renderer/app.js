/* Frosty renderer */
const TL = window.FrostyTimeline;
const $ = (id) => document.getElementById(id);
const S = { media: [], tl: TL.empty(), sel: null, t: 0, playing: false, pps: 60, undo: [], redo: [], cur: null, busy: false, hist: [], models: [], targetTrack: 2 };

const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
const fileUrl = (p) => 'file:///' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23');
const log = (m) => { const l = $('log'); l.textContent = m + '\n' + l.textContent; };
const status = (m) => ($('status').textContent = m || '');

function commit() { S.undo.push(JSON.stringify(S.tl)); if (S.undo.length > 100) S.undo.shift(); S.redo = []; }
function undo() { if (!S.undo.length) return; S.redo.push(JSON.stringify(S.tl)); S.tl = JSON.parse(S.undo.pop()); renderAll(); }
function redo() { if (!S.redo.length) return; S.undo.push(JSON.stringify(S.tl)); S.tl = JSON.parse(S.redo.pop()); renderAll(); }
async function call(p) { const r = await p; if (!r.ok) throw new Error(r.error); return r.data; }
async function guard(fn) { if (S.busy) return; S.busy = true; try { await fn(); } catch (e) { log('⚠ ' + e.message); status(''); } finally { S.busy = false; } }

// ---------- rendering ----------
function decorate(m) {
  if (m.thumb !== undefined) return; m.thumb = null;
  call(window.frosty.assets(m.path)).then((r) => { m.thumb = r.thumb; m.wave = r.wave; renderAll(); }).catch(() => {});
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

function moveHead() { $('head').style.left = S.t * S.pps + 'px'; $('tc').textContent = `${fmt(S.t)} / ${fmt(TL.duration(S.tl))}`; }

function renderInspector() {
  const el = $('insp'); el.textContent = '';
  const clip = S.tl.video.find((c) => c.id === S.sel), txt = S.tl.text.find((o) => o.id === S.sel);
  const lay = (S.tl.layers || []).find((o) => o.id === S.sel), aud = (S.tl.audio || []).find((o) => o.id === S.sel);
  const field = (label, val, type, on) => {
    const l = document.createElement('label'); l.textContent = label;
    const i = document.createElement('input'); i.type = type; i.value = val; if (type === 'number') i.step = '0.1';
    i.onchange = () => { commit(); on(i.value); renderAll(); }; l.append(i); el.append(l);
  };
  if (clip) {
    if (S.tl.mode === 'free') field('Video track', clip.track || 1, 'number', (v) => { const n = Math.max(1, Math.min(S.tl.trackCount, Math.round(+v || 1))); if (n > 1 && S.tl.trackState[String(n)]?.locked) { log('That track is locked'); return; } clip.track = n; });
    if (S.tl.mode === 'free') field('Timeline start (s)', (clip.start || 0).toFixed(2), 'number', (v) => { clip.start = Math.max(0, +v || 0); });
    field('In (s)', clip.in.toFixed(2), 'number', (v) => (clip.in = Math.max(0, Math.min(+v, clip.out - 0.1))));
    field('Out (s)', clip.out.toFixed(2), 'number', (v) => (clip.out = Math.max(clip.in + 0.1, +v)));
    field('Zoom (1-3×)', clip.zoom, 'number', (v) => (clip.zoom = Math.min(3, Math.max(1, +v))));
    field('Volume (0-2)', clip.volume, 'number', (v) => (clip.volume = Math.min(2, Math.max(0, +v))));
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
  } else if (aud) {
    field('Start (s)', aud.start.toFixed(2), 'number', (v) => (aud.start = Math.max(0, +v)));
    field('Source In (s)', aud.in.toFixed(2), 'number', (v) => (aud.in = Math.max(0, Math.min(+v, aud.out - 0.1))));
    field('Source Out (s)', aud.out.toFixed(2), 'number', (v) => (aud.out = Math.max(aud.in + 0.1, +v)));
    field('Volume (0-2)', aud.volume, 'number', (v) => (aud.volume = Math.min(2, Math.max(0, +v))));
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

function renderAll() { renderBin(); renderTimeline(); renderInspector(); updatePreview(true); $('musicName').textContent = S.tl.music ? '♪ ' + S.tl.music.src.split(/[\\/]/).pop() : ''; $('musicDuck').checked = !!S.tl.music?.duck; }

// ---------- preview ----------
const vid = $('vid');
function previewTransform(c, localTime) {
  const tr = c.transform || {};
  const v = (k, d) => TL.evaluateKeyframes(c, k, localTime, tr[k] == null ? d : tr[k]);
  return `translate(${v('x', 0) * 100}%,${v('y', 0) * 100}%) rotate(${v('rotation', 0)}deg) skew(${Math.atan(v('shearX', 0)) * 180 / Math.PI}deg,${Math.atan(v('shearY', 0)) * 180 / Math.PI}deg) scale(${v('scaleX', 1) * (c.zoom || 1)},${v('scaleY', 1)})`;
}
function updatePreview(force) {
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
function seek(t) { S.t = Math.max(0, Math.min(t, TL.duration(S.tl))); updatePreview(false); moveHead(); }

function tick() {
  if (!S.playing) return;
  if (S.tl.mode === 'free') { const now = performance.now(); S.t = Math.min(TL.duration(S.tl), S.t + Math.max(0, now - (S.lt || now)) / 1000); S.lt = now; updatePreview(false); moveHead(); if (S.t >= TL.duration(S.tl)) { S.playing = false; $('bPlay').textContent = '▶'; } else requestAnimationFrame(tick); return; }
  const item = TL.layout(S.tl).find((i) => i.clip.id === S.cur);
  if (!item) { S.playing = false; $('bPlay').textContent = '▶'; return; }
  const c = item.clip;
  if (c.type === 'image') { S.t = Math.min(item.end, S.t + (performance.now() - (S.lt || performance.now())) / 1000); }
  else S.t = item.start + (vid.currentTime - c.in) / (c.speed || 1);
  S.lt = performance.now();
  if (c.type === 'image' ? S.t >= item.end - 0.02 : vid.currentTime >= c.out - 0.03) {
    const L = TL.layout(S.tl), i = L.findIndex((x) => x.clip.id === c.id);
    if (i + 1 < L.length) { S.t = L[i + 1].start; updatePreview(false); vid.play().catch(() => {}); }
    else { S.playing = false; vid.pause(); $('bPlay').textContent = '▶'; S.t = L[i].end; }
  }
  updatePreview(false); moveHead();
  requestAnimationFrame(tick);
}
function togglePlay() {
  if (!S.tl.video.length) return;
  if (S.playing) { S.playing = false; vid.pause(); $('bPlay').textContent = '▶'; return; }
  if (S.t >= TL.duration(S.tl) - 0.05) seek(0);
  updatePreview(false); S.playing = true; S.lt = performance.now(); $('bPlay').textContent = '⏸'; if (S.tl.mode !== 'free') vid.play().catch(() => {}); requestAnimationFrame(tick);
}

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
  const r = await call(window.frosty.agent({ request, timeline: S.tl, history: S.hist.slice(-6), video: $('useVid').checked }));
  commit(); S.tl = r.timeline; (r.media || []).forEach((m) => S.media.push(m));
  S.hist.push({ role: 'user', content: request }, { role: 'assistant', content: r.summary });
  status(''); log(`AI: ${r.summary}${r.cost ? ` ($${r.cost.toFixed(4)})` : ''}\n  - ` + (r.log.join('\n  - ') || 'no edits')); seek(0); renderAll();
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
  status(''); log(`Scene index updated: ${r.added} new scenes; ${r.totalScenes} searchable scenes total.`);
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
    const desc = document.createElement('span'); desc.className = 'muted'; desc.textContent = (r.caption || r.transcript || 'No transcript/caption available').slice(0, 180);
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
  const { media, scenes } = await call(window.frosty.brag({ name, tagline: $('gTag').value, features: $('gFeat').value, useAI: $('gAI').checked }));
  S.media.push(media); commit(); TL.addClip(S.tl, media);
  status(''); log(`Launch video created (${scenes.length} scenes)`); renderAll();
}

async function doExport() {
  status('Exporting…');
  const out = await call(window.frosty.exportVideo(S.tl, { preset: $('preset').value }));
  status(''); log(out ? 'Exported to ' + out : 'Export cancelled');
}

// ---------- wiring ----------
$('bImport').onclick = () => guard(importMedia);
$('bTimelineMode').onclick = () => { commit(); const next = S.tl.mode === 'free' ? 'sequential' : 'free'; TL.setTimelineMode(S.tl, next); log(`Timeline mode: ${next}`); renderAll(); };
$('bAddVTrack').onclick = () => { commit(); S.targetTrack = TL.addVideoTrack(S.tl); log(`Added video track V${S.targetTrack}`); renderAll(); };
$('bPlay').onclick = togglePlay; $('bSplit').onclick = splitHere; $('bDel').onclick = deleteSelected;
$('bPrevFrame').onclick = () => seek(S.t - 1 / (Number($('preset').dataset.fps) || 30));
$('bNextFrame').onclick = () => seek(S.t + 1 / (Number($('preset').dataset.fps) || 30));
$('bUndo').onclick = undo; $('bRedo').onclick = redo;
$('bSil').onclick = () => guard(removeSilences); $('bCap').onclick = () => guard(autoCaptions); $('bAI').onclick = () => guard(runAI);
$('bExport').onclick = () => guard(doExport);
$('bMusic').onclick = () => guard(async () => { const p = await call(window.frosty.pickMusic()); if (p) { commit(); S.tl.music = { src: p, volume: 0.25, duck: $('musicDuck').checked }; renderAll(); } });
$('musicDuck').onchange = () => { if (S.tl.music) { commit(); S.tl.music.duck = $('musicDuck').checked; renderAll(); } };
$('bIndex').onclick = () => guard(indexMediaLibrary);
$('bSceneSearch').onclick = () => guard(searchSceneLibrary);
$('sceneQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') guard(searchSceneLibrary); });
$('bSave').onclick = () => guard(async () => { await call(window.frosty.saveProject({ tl: S.tl, media: S.media })); log('Project saved'); });
$('bOpen').onclick = () => guard(async () => { const d = await call(window.frosty.openProject()); if (d) { S.tl = TL.ensure(d.tl); S.media = d.media || []; $('musicDuck').checked = !!S.tl.music?.duck; S.undo = []; S.redo = []; seek(0); renderAll(); } });
$('pps').oninput = (e) => { S.pps = +e.target.value; renderTimeline(); };
$('bUrl').onclick = () => $('dUrl').showModal();
$('uOk').onclick = (e) => { e.preventDefault(); const u = $('uUrl').value.trim(); $('dUrl').close(); if (u) guard(async () => { status('Downloading…'); S.media.push(await call(window.frosty.download(u))); status(''); log('Downloaded ' + u); renderAll(); }); };
$('bDoc').onclick = () => guard(async () => { (await call(window.frosty.doctor())).forEach((c) => log(`${c.ok ? '✔' : '✘'} ${c.name} — ${c.note}`)); });
$('bScenes').onclick = () => guard(splitScenes);
$('sLoad').onclick = () => guard(loadModels);
$('sCheck').onclick = () => guard(async () => { const k = await call(window.frosty.keyInfo()); $('mInfo').textContent = `Key OK · used $${(k.usage || 0).toFixed(2)}` + (k.remaining != null ? ` · $${k.remaining.toFixed(2)} left` : ' · no limit'); });
$('bBrag').onclick = () => $('dBrag').showModal();
$('gOk').onclick = (e) => { e.preventDefault(); $('dBrag').close(); guard(makeBrag); };
$('bSettings').onclick = async () => { const s = await call(window.frosty.getSettings()); $('sKey').value = s.apiKey; $('sModel').value = s.model; $('sFb').value = s.fallbacks || ''; $('sSort').value = s.sort || ''; $('sImg').value = s.imageModel || ''; $('sWh').value = s.whisper; $('dSettings').showModal(); };
$('sOk').onclick = async (e) => { e.preventDefault(); await call(window.frosty.setSettings({ apiKey: $('sKey').value.trim(), model: $('sModel').value.trim() || 'google/gemini-2.5-flash', fallbacks: $('sFb').value.trim(), sort: $('sSort').value, imageModel: $('sImg').value.trim(), whisper: $('sWh').value })); $('dSettings').close(); log('Settings saved'); };
$('tl').onclick = (e) => { const r = $('tl').getBoundingClientRect(); seek((e.clientX - r.left) / S.pps); };
$('ruler').onclick = (e) => { const r = $('tl').getBoundingClientRect(); seek((e.clientX - r.left) / S.pps); };
window.frosty.on('ai:status', status);
window.frosty.on('export:progress', (p) => status(`Exporting… ${Math.round(p * 100)}%`));

document.addEventListener('keydown', (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 's' || e.key === 'S') splitHere();
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  else if (e.ctrlKey && e.key.toLowerCase() === 'z') undo();
  else if (e.ctrlKey && e.key.toLowerCase() === 'y') redo();
  else if (e.key === 'ArrowLeft') seek(S.t - 1 / 30);
  else if (e.key === 'ArrowRight') seek(S.t + 1 / 30);
});
['Web 720p', 'YouTube 1080p', 'YouTube 4K', 'Vertical 9:16 (Reels/TikTok)', 'Square 1:1'].forEach((p) => $('preset').add(new Option(p, p)));
renderAll();
