// Frosty timeline model. Pure functions, usable in renderer and Node (tests).
// Timeline = { video: [clip], text: [overlay], music: {src,volume}|null }
// clip    = { id, src, name, in, out, zoom, hasAudio, volume }
// overlay = { id, text, start, dur, size, color, pos }
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FrostyTimeline = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  let n = 0;
  const uid = (p) => p + Date.now().toString(36) + (n++).toString(36);
  const EPS = 0.01;
  const empty = () => ({ mode: 'sequential', video: [], text: [], music: null, layers: [], audio: [], trackCount: 2, trackState: { '1': { name: 'V1 · Main', visible: true, muted: false, locked: false }, '2': { name: 'V2', visible: true, muted: false, locked: false } } });
  const ensure = (tl) => { tl.layers = tl.layers || []; tl.audio = tl.audio || []; tl.trackCount = Math.max(2, Number(tl.trackCount) || 2, ...(tl.layers || []).map((l) => (Number(l.track) || 2))); tl.trackState = tl.trackState || {}; for (let i = 1; i <= tl.trackCount; i++) tl.trackState[String(i)] = { name: i === 1 ? 'V1 · Main' : `V${i}`, visible: true, muted: false, locked: false, ...(tl.trackState[String(i)] || {}) }; for (const l of tl.layers) l.track = Math.max(2, Math.min(tl.trackCount, Number(l.track) || 2)); for (const c of tl.video || []) if (c.track != null) c.track = Math.max(1, Math.min(tl.trackCount, Number(c.track) || 1)); return tl; };
  const isTrackLocked = (tl, track) => { const n = Math.max(1, Math.min((tl.trackCount || 2), Number(track) || 1)); return !!(tl.trackState && tl.trackState[String(n)] && tl.trackState[String(n)].locked); };
  const isItemLocked = (tl, item) => (!item ? false : isTrackLocked(tl, Number(item.track || 1)));
  const clone = (tl) => JSON.parse(JSON.stringify(tl));
  const sp = (c) => c.speed || 1;
  const clipDur = (c) => Math.max(0, c.out - c.in) / sp(c);
  const duration = (tl) => { const main = layout(tl).reduce((m, i) => Math.max(m, i.end), 0); if (tl.mode !== 'free') return main; return Math.max(main, ...(tl.layers || []).map((l) => (+l.start || 0) + Math.max(0, l.out - l.in)), ...(tl.audio || []).map((a) => (+a.start || 0) + Math.max(0, a.out - a.in)), ...(tl.text || []).map((t) => (+t.start || 0) + Math.max(0, +t.dur || 0))); };

  function layout(tl) {
    if (tl.mode === 'free') return tl.video.map((c) => { const start = Math.max(0, Number.isFinite(+c.start) ? +c.start : 0); return { clip: c, start, end: start + clipDur(c) }; }).sort((a, b) => a.start - b.start);
    let t = 0;
    return tl.video.map((c, i) => {
      const d = clipDur(c);
      const ov = i && c.trans ? Math.min(c.trans.dur, clipDur(tl.video[i - 1]), d) : 0;
      const start = t - ov;
      t = start + d;
      return { clip: c, start, end: t };
    });
  }

  function setTimelineMode(tl, mode) {
    if (!['sequential', 'free'].includes(mode) || (tl.mode || 'sequential') === mode) return false;
    if (mode === 'free') { for (const item of layout(tl)) item.clip.start = item.start; tl.mode = 'free'; }
    else { tl.video.sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0)); for (const c of tl.video) { delete c.start; c.track = 1; } tl.mode = 'sequential'; }
    return true;
  }

  function moveClipToTime(tl, clipId, start) {
    if (tl.mode !== 'free') return false;
    const c = (tl.video || []).find((x) => x.id === clipId); if (!c) return false;
    c.start = Math.max(0, Math.min(86400, Number(start) || 0)); return true;
  }

  function locate(tl, t) {
    const L = layout(tl);
    for (const item of L) if (t >= item.start && t < item.end) return item;
    return L.length && t >= L[L.length - 1].end ? L[L.length - 1] : null;
  }

  function addClip(tl, media, index) {
    const c = { id: uid('c'), src: media.path, name: media.name, in: 0, out: media.duration, ...(tl.mode === 'free' ? { start: duration(tl) } : {}), type: media.type === 'image' ? 'image' : 'video',
      zoom: 1, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alpha: 1, shearX: 0, shearY: 0 }, keyframes: {}, hasAudio: media.hasAudio !== false && media.type !== 'image', volume: 1, speed: 1, fx: {}, fade: [0, 0], trans: null };
    if (index == null) tl.video.push(c); else tl.video.splice(index, 0, c);
    return c;
  }

  function splitAt(tl, t) {
    const item = layout(tl).find((i) => t > i.start + EPS && t < i.end - EPS);
    if (!item) return false;
    if (isItemLocked(tl, item.clip)) return false;
    const c = item.clip, srcT = c.in + (t - item.start) * sp(c);
    const right = { ...c, id: uid('c'), in: srcT, trans: null, fx: { ...(c.fx || {}) } };
    if (tl.mode === 'free') right.start = t;
    c.out = srcT;
    tl.video.splice(tl.video.indexOf(c) + 1, 0, right);
    return true;
  }

  // Ripple-delete a timeline-time range.
  function deleteRange(tl, a, b) {
    if (b - a < EPS) return 0;
    if ((tl.video || []).some((c) => isItemLocked(tl, c))) return 0;
    if (tl.mode === 'free') {
      const gap = b - a, before = tl.video.length;
      const next = [];
      for (const c of tl.video) {
        const start = Math.max(0, +c.start || 0), end = start + clipDur(c), speed = sp(c);
        if (end <= a + EPS) { next.push(c); continue; }
        if (start >= b - EPS) { next.push({ ...c, start: start - gap }); continue; }
        const leftDur = Math.max(0, Math.min(end, a) - start), rightDur = Math.max(0, end - Math.max(start, b));
        if (leftDur > EPS) next.push({ ...c, out: c.in + leftDur * speed });
        if (rightDur > EPS) next.push({ ...c, id: uid('c'), start: a, in: c.in + Math.max(0, b - start) * speed, keyframes: JSON.parse(JSON.stringify(c.keyframes || {})), trans: null });
      }
      tl.video = next;
      const shiftItems = (items, durKey) => (items || []).flatMap((o) => { const start = Math.max(0, +o.start || 0), d = durKey === 'out' ? Math.max(0, o.out - o.in) : Math.max(0, +o[durKey] || 0), end = start + d; if (end <= a + EPS) return [o]; if (start >= b - EPS) return [{ ...o, start: start - gap }]; const left = Math.max(0, a - start), right = Math.max(0, end - b), out = []; if (left > EPS) out.push({ ...o, [durKey === 'out' ? 'out' : durKey]: durKey === 'out' ? o.in + left : left }); if (right > EPS) out.push({ ...o, id: uid('r'), start: a, ...(durKey === 'out' ? { in: o.in + Math.max(0, b - start), out: o.out } : { [durKey]: right }) }); return out; });
      tl.layers = shiftItems(tl.layers, 'out'); tl.audio = shiftItems(tl.audio, 'out');
      tl.text = (tl.text || []).flatMap((o) => { const start = +o.start || 0, end = start + (+o.dur || 0); if (end <= a + EPS) return [o]; if (start >= b - EPS) return [{ ...o, start: start - gap }]; const left = Math.max(0, a - start), right = Math.max(0, end - b), out = []; if (left > EPS) out.push({ ...o, dur: left }); if (right > EPS) out.push({ ...o, id: uid('t'), start: a, dur: right }); return out; });
      return before - tl.video.length;
    }
    splitAt(tl, a); splitAt(tl, b);
    const keep = layout(tl).filter((i) => !(i.start >= a - EPS && i.end <= b + EPS)).map((i) => i.clip);
    const removed = tl.video.length - keep.length;
    tl.video = keep;
    const gap = b - a;
    tl.text = tl.text
      .filter((o) => !(o.start >= a && o.start + o.dur <= b))
      .map((o) => (o.start >= b ? { ...o, start: o.start - gap } : o));
    return removed;
  }

  // Remove ranges expressed in SOURCE time (e.g. detected silences) from every clip of that file.
  function removeSourceRanges(tl, src, ranges) {
    const out = [];
    for (const c of tl.video) {
      if (c.src !== src) { out.push(c); continue; }
      let pieces = [[c.in, c.out]];
      for (const [ra, rb] of ranges) {
        pieces = pieces.flatMap(([a, b]) => {
          if (rb <= a || ra >= b) return [[a, b]];
          const r = [];
          if (ra > a + EPS) r.push([a, ra]);
          if (rb < b - EPS) r.push([rb, b]);
          return r;
        });
      }
      for (const [a, b] of pieces) if (b - a > 0.05) out.push({ ...c, id: uid('c'), in: a, out: b, ...(tl.mode === 'free' ? { start: (Number(c.start) || 0) + (a - c.in) / sp(c) } : {}) });
    }
    tl.video = out;
  }

  // Split every clip of `src` at the given SOURCE times (scene cuts).
  // Phase 2 — multiselect / selection helpers for professional editing
  function selectClips(tl, ids) { tl.selected = (ids || []).filter((id) => (tl.video || []).some((c) => c.id === id)); return tl.selected; }
  function clearSelection(tl) { tl.selected = []; return tl; }
  function duplicateSelected(tl) {
    if (!tl.selected || !tl.selected.length) return tl;
    const added = [];
    for (const id of tl.selected) {
      const c = (tl.video || []).find((x) => x.id === id); if (!c) continue;
      const d = { ...c, id: uid('c'), keyframes: JSON.parse(JSON.stringify(c.keyframes || {})), trans: null, fx: { ...(c.fx || {}) } };
      if (tl.mode === 'free') d.start = (Number(c.start) || 0) + 0.5;
      tl.video.push(d); added.push(d.id);
    }
    tl.selected = added;
    return tl;
  }
  function copySelected(tl) { tl.clipboard = (tl.selected || []).map((id) => { const c = (tl.video || []).find((x) => x.id === id); return c ? JSON.parse(JSON.stringify(c)) : null; }).filter(Boolean); return tl; }
  function pasteClips(tl, atTime) {
    if (!tl.clipboard || !tl.clipboard.length) return tl;
    const added = [];
    for (const c of tl.clipboard) {
      const d = { ...c, id: uid('c'), keyframes: JSON.parse(JSON.stringify(c.keyframes || {})), trans: null, fx: { ...(c.fx || {}) } };
      if (tl.mode === 'free') d.start = Math.max(0, (Number(atTime) || 0) + (Number(c.start) || 0));
      tl.video.push(d); added.push(d.id);
    }
    tl.selected = added;
    return tl;
  }
  // Phase 2 — keyboard shortcut / command-layer hooks (documented; full WPF integration requires .NET build)
  function applyEditCommand(tl, cmd) {
    if (!cmd || !cmd.type) return tl;
    if (cmd.type === 'roll' && cmd.id) { const c = (tl.video || []).find((x) => x.id === cmd.id); if (c) { c.in = Math.max(0, (Number(cmd.value) || c.in)); c.out = Math.max(c.in + 0.01, (Number(cmd.out) || c.out)); } }
    if (cmd.type === 'slip' && cmd.id) { const c = (tl.video || []).find((x) => x.id === cmd.id); if (c) { const delta = Number(cmd.value) || 0; c.in = Math.max(0, c.in + delta); c.out = Math.max(c.in + 0.01, c.out + delta); } }
    if (cmd.type === 'slide' && cmd.id) { const c = (tl.video || []).find((x) => x.id === cmd.id); if (c && tl.mode === 'free') c.start = Math.max(0, (Number(cmd.value) || c.start)); }
    if (cmd.type === 'rate' && cmd.id) { const c = (tl.video || []).find((x) => x.id === cmd.id); if (c) c.speed = Math.max(0.01, Number(cmd.value) || 1); }
    if (cmd.type === 'trim' && cmd.id && cmd.time != null) splitAt(tl, cmd.time);
    if (cmd.type === 'delete' && cmd.id) { tl.video = (tl.video || []).filter((c) => c.id !== cmd.id); }
    if (cmd.type === 'move' && cmd.id && cmd.time != null) moveClipToTime(tl, cmd.id, cmd.time);
    if (cmd.type === 'duplicate') duplicateSelected(tl);
    if (cmd.type === 'paste' && cmd.time != null) pasteClips(tl, cmd.time);
    return tl;
  }
  // Phase 2 — drag-and-drop / context-menu hooks (documented; full UI requires WPF)
  function canDropOnTrack(tl, clipId, track) { const c = (tl.video || []).find((x) => x.id === clipId); return !!c && Number(track) >= 1 && Number(track) <= tl.trackCount; }
  function dropClipToTrack(tl, clipId, track) { const c = (tl.video || []).find((x) => x.id === clipId); if (c) c.track = Math.max(1, Math.min(tl.trackCount, Number(track) || 1)); return tl; }

  function splitSource(tl, src, times) {
    const ts = [...times].sort((a, b) => a - b);
    const out = [];
    for (const c of tl.video) {
      if (c.src !== src) { out.push(c); continue; }
      let cur = c;
      for (const t of ts) {
        if (t > cur.in + 0.2 && t < cur.out - 0.2) { out.push({ ...cur, out: t }); cur = { ...cur, id: uid('c'), in: t, trans: null, ...(tl.mode === 'free' ? { start: (Number(c.start) || 0) + (t - c.in) / sp(c) } : {}) }; }
      }
      if (tl.mode === 'free' && cur !== c) cur.start = (Number(c.start) || 0) + (cur.in - c.in) / sp(c);
      out.push(cur);
    }
    tl.video = out;
  }

  // Overlay layer (picture-in-picture / image / green-screen): x,y = centre as fraction of frame.
  function addVideoTrack(tl) { ensure(tl); tl.trackCount += 1; tl.trackState[String(tl.trackCount)] = { name: `V${tl.trackCount}`, visible: true, muted: false, locked: false }; return tl.trackCount; }
  function setTrackState(tl, track, patch) { ensure(tl); const k = String(Math.max(1, Math.min(tl.trackCount, Math.round(+track || 1)))); tl.trackState[k] = { ...(tl.trackState[k] || {}), ...(patch || {}) }; return tl.trackState[k]; }
  function deleteVideoTrack(tl, track) { ensure(tl); const n = Math.round(+track); if (!Number.isFinite(n) || n < 2 || n > tl.trackCount) return { removed: 0, ok: false }; const before = tl.layers.length + tl.video.length; tl.layers = tl.layers.filter((l) => (Number(l.track) || 2) !== n); tl.video = tl.video.filter((c) => (Number(c.track) || 1) !== n); for (const l of tl.layers) if (l.track > n) l.track--; for (const c of tl.video) if ((Number(c.track) || 1) > n) c.track--; const next = {}; for (let i = 1; i <= tl.trackCount; i++) { if (i === n) continue; next[String(i > n ? i - 1 : i)] = tl.trackState[String(i)] || { name: `V${i}`, visible: true, muted: false, locked: false }; } tl.trackCount--; tl.trackState = next; ensure(tl); return { removed: before - tl.layers.length - tl.video.length, ok: true }; }
  // Ripple-delete a timeline interval across every editable track. Main-track clips are split at boundaries; overlays/audio/text after the interval shift left.
  function rippleDeleteAll(tl, a, b) {
    ensure(tl); a = Math.max(0, +a || 0); b = Math.max(a, +b || 0);
    if (b - a < EPS) return 0;
    const gap = b - a;
    const originalText = (tl.text || []).map((o) => ({ ...o }));
    const removed = deleteRange(tl, a, b);
    if (tl.mode === 'free') return removed;

    // For source-based clips, remove the corresponding source interval instead of
    // merely shortening the tail. A clip crossing the cut becomes two pieces.
    const rippleSourceItems = (items) => {
      const result = [];
      for (const item of items || []) {
        const start = Math.max(0, +item.start || 0);
        const sourceIn = Math.max(0, +item.in || 0);
        const sourceOut = Math.max(sourceIn, +item.out || sourceIn);
        const dur = sourceOut - sourceIn;
        const end = start + dur;
        if (end <= a + EPS) { result.push(item); continue; }
        if (start >= b - EPS) { result.push({ ...item, start: start - gap }); continue; }
        const leftDur = Math.max(0, Math.min(end, a) - start);
        const rightDur = Math.max(0, end - Math.max(start, b));
        if (leftDur > EPS) result.push({ ...item, out: sourceIn + leftDur });
        if (rightDur > EPS) {
          const rightSourceIn = sourceIn + Math.max(0, b - start);
          result.push({ ...item, id: uid(item.id && item.id[0] || 'l'), start: Math.max(a, start) - (start < a ? 0 : 0), in: rightSourceIn, out: sourceOut, keyframes: JSON.parse(JSON.stringify(item.keyframes || {})) });
          // The surviving right segment is joined to the cut point at timeline a.
          result[result.length - 1].start = start >= b ? start - gap : a;
        }
      }
      return result;
    };
    tl.layers = rippleSourceItems(tl.layers);
    tl.audio = rippleSourceItems(tl.audio);

    // Text overlays have no source interval, but preserve both surviving pieces
    // when a title spans the deleted time instead of silently discarding its tail.
    tl.text = [];
    for (const item of originalText) {
      const start = Math.max(0, +item.start || 0), dur = Math.max(0, +item.dur || 0), end = start + dur;
      if (end <= a + EPS) { tl.text.push(item); continue; }
      if (start >= b - EPS) { tl.text.push({ ...item, start: start - gap }); continue; }
      const leftDur = Math.max(0, Math.min(end, a) - start);
      const rightDur = Math.max(0, end - Math.max(start, b));
      if (leftDur > EPS) tl.text.push({ ...item, dur: leftDur });
      if (rightDur > EPS) tl.text.push({ ...item, id: uid('t'), start: a, dur: rightDur });
    }
    return removed;
  }

  function addLayer(tl, media, start = 0, track) {
    ensure(tl);
    const targetTrack = Math.max(2, Math.min(tl.trackCount, Number(track) || tl.trackCount));
    const l = { id: uid('l'), track: targetTrack, src: media.path, name: media.name, type: media.type === 'image' ? 'image' : 'video', start, in: 0, out: media.duration,
      x: 0.8, y: 0.2, scale: 0.3, opacity: 1, rotation: 0, shearX: 0, shearY: 0, keyframes: {}, volume: 1, hasAudio: media.hasAudio !== false && media.type !== 'image', chroma: null };
    tl.layers.push(l); return l;
  }
  function addAudio(tl, media, start = 0) {
    ensure(tl);
    const a = { id: uid('a'), src: media.path, name: media.name, start, in: 0, out: media.duration, volume: 1 };
    tl.audio.push(a); return a;
  }
  const TRANS = ['fade', 'dissolve', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'circleopen', 'pixelize', 'fadeblack', 'radial'];
  function addText(tl, text, start, dur, opts = {}) {
    const o = { id: uid('t'), text, start, dur, size: 48, color: '#ffffff', pos: 'bottom', ...opts };
    tl.text.push(o);
    return o;
  }

  function moveClip(tl, id, dir) {
    const i = tl.video.findIndex((c) => c.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= tl.video.length) return;
    [tl.video[i], tl.video[j]] = [tl.video[j], tl.video[i]];
  }

  const KEYFRAME_PROPERTIES = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'alpha', 'shearX', 'shearY', 'volume', 'speed', 'opacity'];
  function setKeyframe(item, property, time, value, interpolation = 'linear') {
    if (!item || !KEYFRAME_PROPERTIES.includes(property)) throw new Error('Unsupported keyframe property: ' + property);
    item.keyframes = item.keyframes || {};
    const points = item.keyframes[property] || (item.keyframes[property] = []);
    const t = Math.max(0, +time || 0), v = Number(value);
    if (!Number.isFinite(v)) throw new Error('Keyframe value must be numeric');
    const point = { t, v, interpolation: ['linear', 'constant', 'bezier'].includes(interpolation) ? interpolation : 'linear' };
    const i = points.findIndex((p) => Math.abs(p.t - t) < 0.0001);
    if (i >= 0) points[i] = point; else points.push(point);
    points.sort((a, b) => a.t - b.t);
    return point;
  }
  function evaluateKeyframes(item, property, time, fallback) {
    const points = (item && item.keyframes && item.keyframes[property] || []).slice().sort((a, b) => a.t - b.t);
    if (!points.length) return fallback;
    if (time <= points[0].t) return points[0].v;
    if (time >= points[points.length - 1].t) return points[points.length - 1].v;
    let i = 0; while (i + 1 < points.length && points[i + 1].t < time) i++;
    const a = points[i], b = points[i + 1];
    if (a.interpolation === 'constant') return a.v;
    const u = (time - a.t) / Math.max(0.000001, b.t - a.t);
    // Bezier uses a smoothstep temporal curve; control points can be added later without changing the schema.
    const k = a.interpolation === 'bezier' ? u * u * (3 - 2 * u) : u;
    return a.v + (b.v - a.v) * k;
  }
  function evaluateProperties(item, time, defaults = {}) {
    const out = { ...defaults, ...(item && item.transform || {}) };
    for (const key of KEYFRAME_PROPERTIES) {
      const base = item && item.transform && item.transform[key] != null ? item.transform[key] : (item && item[key] != null ? item[key] : out[key]);
      const v = evaluateKeyframes(item, key, time, base);
      if (v != null) out[key] = v;
    }
    return out;
  }
  function setTransform(tl, clipId, props) {
    const c = (tl.video || []).find((x) => x.id === clipId);
    if (!c) return false;
    c.transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alpha: 1, shearX: 0, shearY: 0, ...(c.transform || {}) };
    for (const [k, v] of Object.entries(props || {})) if (['x','y','scaleX','scaleY','rotation','alpha','shearX','shearY'].includes(k) && Number.isFinite(+v)) c.transform[k] = +v;
    return true;
  }

  // Professional trim operations. All deltas are timeline seconds unless noted.
  function rollEdit(tl, rightClipId, delta) {
    if (tl.mode === 'free') return { ok: false, reason: 'Roll editing currently requires sequential mode' };
    const i = tl.video.findIndex((c) => c.id === rightClipId);
    if (i <= 0 || i >= tl.video.length) return { ok: false, reason: 'Roll requires a clip with a previous neighbour' };
    const left = tl.video[i - 1], right = tl.video[i];
    if (isItemLocked(tl, left) || isItemLocked(tl, right)) return { ok: false, reason: 'Track is locked' };
    const d = +delta || 0, leftMin = 0.05, rightMin = 0.05;
    const maxPositive = Math.max(0, right.out - right.in - rightMin) / sp(right);
    const maxNegative = Math.max(0, left.out - left.in - leftMin) / sp(left);
    const dt = Math.max(-maxNegative, Math.min(maxPositive, d));
    left.out += dt * sp(left); right.in += dt * sp(right);
    left.out = Math.max(left.in + leftMin, left.out); right.in = Math.max(0, Math.min(right.in, right.out - rightMin));
    return { ok: true, delta: dt };
  }
  function slipEdit(tl, clipId, delta, sourceDuration = Infinity) {
    const c = tl.video.find((x) => x.id === clipId); if (!c) return { ok: false, reason: 'Clip not found' };
    if (isItemLocked(tl, c)) return { ok: false, reason: 'Track is locked' };
    const d = +delta || 0, len = c.out - c.in;
    const dt = Math.max(-c.in, Math.min(Math.max(0, sourceDuration - c.out), d));
    c.in += dt; c.out = c.in + len;
    return { ok: true, delta: dt };
  }
  function slideEdit(tl, clipId, delta) {
    if (tl.mode === 'free') return { ok: false, reason: 'Slide editing currently requires sequential mode' };
    const i = tl.video.findIndex((c) => c.id === clipId);
    if (i <= 0 || i >= tl.video.length - 1) return { ok: false, reason: 'Slide requires previous and next neighbours' };
    const c = tl.video[i], prev = tl.video[i - 1], next = tl.video[i + 1];
    if (isItemLocked(tl, prev) || isItemLocked(tl, c) || isItemLocked(tl, next)) return { ok: false, reason: 'Track is locked' };
    const d = +delta || 0;
    const min = 0.05;
    const lo = -Math.min(Math.max(0, c.in), Math.max(0, (prev.out - prev.in) / sp(prev) - min));
    const hi = Math.min(Math.max(0, (c.out - c.in) / sp(c) - min), Math.max(0, (next.out - next.in) / sp(next) - min));
    const dt = Math.max(lo, Math.min(hi, d));
    prev.out += dt * sp(prev); next.in += dt * sp(next);
    return { ok: true, delta: dt };
  }
  function rateStretch(tl, clipId, newDuration) {
    const c = tl.video.find((x) => x.id === clipId); if (!c) return { ok: false, reason: 'Clip not found' };
    if (isItemLocked(tl, c)) return { ok: false, reason: 'Track is locked' };
    const d = Math.max(0.05, +newDuration || clipDur(c));
    const sourceLength = Math.max(0.05, c.out - c.in);
    c.speed = Math.max(0.1, Math.min(10, sourceLength / d));
    return { ok: true, speed: c.speed, duration: clipDur(c) };
  }
  function splitLayerAt(tl, layerId, timelineTime) {
    const i = (tl.layers || []).findIndex((l) => l.id === layerId); if (i < 0) return false;
    const l = tl.layers[i], dur = l.out - l.in, t = +timelineTime;
    if (!(t > l.start + EPS && t < l.start + dur - EPS)) return false;
    const sourceT = l.in + (t - l.start);
    const right = { ...l, id: uid('l'), start: t, in: sourceT, keyframes: JSON.parse(JSON.stringify(l.keyframes || {})) };
    l.out = sourceT; tl.layers.splice(i + 1, 0, right); return right;
  }
  function reorderVideoTrack(tl, from, to) {
    ensure(tl); from = Math.round(+from); to = Math.round(+to);
    if (from < 2 || to < 2 || from > tl.trackCount || to > tl.trackCount || from === to) return false;
    const move = (n) => n === from ? to : from < to && n > from && n <= to ? n - 1 : from > to && n >= to && n < from ? n + 1 : n;
    for (const l of tl.layers) l.track = move(Number(l.track) || 2);
    for (const c of tl.video) if ((Number(c.track) || 1) >= 2) c.track = move(Number(c.track) || 2);
    const states = {}; for (let i = 1; i <= tl.trackCount; i++) states[String(move(i))] = tl.trackState[String(i)];
    tl.trackState = states; ensure(tl); return true;
  }

  // Compact description sent to the AI planner.
  function summarize(tl) {
    return {
      mode: tl.mode || 'sequential', duration: +duration(tl).toFixed(2),
      clips: layout(tl).map((i) => ({ id: i.clip.id, file: i.clip.name, track: Number(i.clip.track) || 1, start: +i.start.toFixed(2),
        end: +i.end.toFixed(2), src_in: +i.clip.in.toFixed(2), src_out: +i.clip.out.toFixed(2), zoom: i.clip.zoom,
        speed: i.clip.speed || 1, volume: i.clip.volume, transform: i.clip.transform || {}, keyframes: i.clip.keyframes || {}, fx: i.clip.fx || {}, transition_in: i.clip.trans || null })),
      video_tracks: ensure(tl).trackCount, track_state: tl.trackState, layers: (tl.layers || []).map((l) => ({ id: l.id, track: l.track || 2, file: l.name, start: l.start, dur: +(l.out - l.in).toFixed(2), x: l.x, y: l.y, scale: l.scale, opacity: l.opacity })),
      audio: (tl.audio || []).map((a) => ({ id: a.id, file: a.name, start: a.start, dur: +(a.out - a.in).toFixed(2), volume: a.volume })),
      text: tl.text.map((o) => ({ id: o.id, text: o.text, start: o.start, dur: o.dur })),
    };
  }

  // Apply a list of AI-planned operations. Returns a log of what was done.
  function applyOps(tl, ops) {
    const log = [];
    for (const op of ops || []) {
      try {
        if (op.op === 'set_timeline_mode') { log.push(setTimelineMode(tl, op.mode) ? `Timeline mode: ${tl.mode}` : `Timeline already ${tl.mode || 'sequential'}`); }
        else if (op.op === 'move_clip_to_time') { log.push(moveClipToTime(tl, op.clip_id, +op.start) ? `Moved clip to ${op.start}s` : 'Could not move clip; enable free timeline mode first'); }
        else if (op.op === 'set_clip_track') { const c = (tl.video || []).find((x) => x.id === op.clip_id); const n = Math.round(+op.track); if (!c || tl.mode !== 'free' || n < 1 || n > tl.trackCount) log.push('Cannot assign clip to that track; use free mode and an existing track'); else if (n > 1 && tl.trackState[String(n)]?.locked) log.push(`Track V${n} is locked`); else { c.track = n; log.push(`Moved ${c.name} to V${n}`); } }
        else if (op.op === 'delete_range') { deleteRange(tl, +op.start, +op.end); log.push(`Cut ${op.start}s-${op.end}s`); }
        else if (op.op === 'add_text') { addText(tl, String(op.text), +op.start, +op.dur || 3, { pos: op.pos || 'bottom' }); log.push(`Text "${op.text}"`); }
        else if (op.op === 'split') { splitAt(tl, +op.at); log.push(`Split at ${op.at}s`); }
        else if (op.op === 'zoom') {
          const it = layout(tl).find((i) => i.clip.id === op.clip_id);
          if (it) { it.clip.zoom = Math.min(3, Math.max(1, +op.zoom)); log.push(`Zoom ${op.zoom}x on ${it.clip.name}`); }
        } else if (['set_speed', 'set_volume', 'set_fx', 'add_transition', 'fade'].includes(op.op)) {
          const c = tl.video.find((x) => x.id === op.clip_id);
          if (!c) { log.push(`No clip ${op.clip_id} for ${op.op}`); continue; }
          if (op.op === 'set_speed') { c.speed = Math.min(4, Math.max(0.25, +op.speed || 1)); log.push(`Speed ${c.speed}x on ${c.name}`); }
          else if (op.op === 'set_volume') { c.volume = Math.min(2, Math.max(0, +op.volume)); log.push(`Volume ${c.volume} on ${c.name}`); }
          else if (op.op === 'set_fx') { c.fx = { ...(c.fx || {}), ...(op.fx || {}) }; log.push(`FX ${JSON.stringify(op.fx)} on ${c.name}`); }
          else if (op.op === 'fade') { c.fade = [Math.max(0, +op.in || 0), Math.max(0, +op.out || 0)]; log.push(`Fade ${c.fade} on ${c.name}`); }
          else {
            if (tl.mode === 'free') log.push('Transitions currently require sequential mode');
            else { const i = tl.video.indexOf(c); if (i === 0) log.push('First clip cannot have an incoming transition');
              else { c.trans = op.type === 'none' ? null : { type: TRANS.includes(op.type) ? op.type : 'fade', dur: Math.min(3, Math.max(0.1, +op.dur || 0.6)) }; log.push(`Transition ${op.type} into ${c.name}`); } }
          }
        } else if (['roll_edit', 'slip_edit', 'slide_edit', 'rate_stretch'].includes(op.op)) {
          let r;
          if (op.op === 'roll_edit') r = rollEdit(tl, op.clip_id, +op.delta);
          else if (op.op === 'slip_edit') r = slipEdit(tl, op.clip_id, +op.delta, Number.isFinite(+op.source_duration) ? +op.source_duration : Infinity);
          else if (op.op === 'slide_edit') r = slideEdit(tl, op.clip_id, +op.delta);
          else r = rateStretch(tl, op.clip_id, +op.duration);
          log.push(r.ok ? `${op.op} ${op.clip_id}: ${r.delta != null ? r.delta.toFixed(3) + 's' : r.speed.toFixed(3) + 'x'}` : `${op.op}: ${r.reason}`);
        } else if (op.op === 'split_layer') {
          const right = splitLayerAt(tl, op.layer_id, +op.at); log.push(right ? `Split overlay at ${op.at}s` : `Could not split overlay ${op.layer_id} at ${op.at}s`);
        } else if (op.op === 'reorder_track') {
          if (isTrackLocked(tl, +op.from) || isTrackLocked(tl, +op.to)) log.push(`Track V${op.from} or V${op.to} is locked`);
          else log.push(reorderVideoTrack(tl, +op.from, +op.to) ? `Moved V${op.from} to V${op.to}` : 'Invalid track reorder');
        } else if (op.op === 'set_transform') {          if (setTransform(tl, op.clip_id, op.transform || op.props || {})) log.push(`Updated transform on ${(tl.video.find((x) => x.id === op.clip_id) || {}).name || op.clip_id}`);
          else log.push(`No clip ${op.clip_id} for set_transform`);
        } else if (op.op === 'set_keyframe') {
          const item = [...(tl.video || []), ...(tl.layers || []), ...(tl.audio || [])].find((x) => x.id === op.item_id || x.id === op.clip_id || x.id === op.layer_id || x.id === op.audio_id);
          if (!item) { log.push(`No item ${op.item_id || op.clip_id} for keyframe`); continue; }
          try { setKeyframe(item, op.property, op.time, op.value, op.interpolation); log.push(`Keyframe ${op.property} at ${op.time}s`); } catch (e) { log.push(e.message); }
        } else if (op.op === 'set_track') {
          const track = Math.round(+op.track || 1); const patch = {};
          if (op.visible != null) patch.visible = !!op.visible;
          if (op.muted != null) patch.muted = !!op.muted;
          if (op.locked != null) patch.locked = !!op.locked;
          if (op.name != null) patch.name = String(op.name).slice(0, 64);
          setTrackState(tl, track, patch); log.push(`Updated video track V${track}`);
        } else if (op.op === 'delete_track') {
          const track = Math.round(+op.track || 0); if (isTrackLocked(tl, track)) log.push(`Track V${track} is locked`);
          else { const r = deleteVideoTrack(tl, track); log.push(r.ok ? `Deleted V${track} (${r.removed} clips removed)` : `Cannot delete video track V${track}`); }
        } else if (op.op === 'set_layer') {
          const l = (tl.layers || []).find((x) => x.id === op.layer_id);
          if (!l) { log.push(`No layer ${op.layer_id}`); continue; }
          if (op.track != null) { const track = Math.max(2, Math.min(tl.trackCount, Math.round(+op.track || 2))); if (isTrackLocked(tl, track)) { log.push(`Track V${track} is locked`); continue; } l.track = track; }
          if (op.start != null) l.start = Math.max(0, +op.start || 0);
          if (op.in != null) l.in = Math.max(0, Math.min(+op.in || 0, l.out - 0.1));
          if (op.out != null) l.out = Math.max(l.in + 0.1, +op.out || l.in + 0.1);
          if (op.x != null) l.x = Math.max(0, Math.min(1, +op.x));
          if (op.y != null) l.y = Math.max(0, Math.min(1, +op.y));
          if (op.scale != null) l.scale = Math.max(0.01, Math.min(3, +op.scale));
          if (op.opacity != null) l.opacity = Math.max(0, Math.min(1, +op.opacity));
          if (op.volume != null) l.volume = Math.max(0, Math.min(2, +op.volume));
          if (op.chroma !== undefined) l.chroma = op.chroma;
          log.push(`Updated overlay ${l.name}`);
        } else if (op.op === 'set_audio') {
          const a = (tl.audio || []).find((x) => x.id === op.audio_id);
          if (!a) { log.push(`No audio ${op.audio_id}`); continue; }
          if (op.start != null) a.start = Math.max(0, +op.start || 0);
          if (op.in != null) a.in = Math.max(0, Math.min(+op.in || 0, a.out - 0.1));
          if (op.out != null) a.out = Math.max(a.in + 0.1, +op.out || a.in + 0.1);
          if (op.volume != null) a.volume = Math.max(0, Math.min(2, +op.volume));
          log.push(`Updated audio ${a.name}`);
        } else if (op.op === 'set_music') {
          if (!tl.music) { log.push('No background music is set'); continue; }
          if (op.volume != null) tl.music.volume = Math.max(0, Math.min(2, +op.volume));
          if (op.duck != null) tl.music.duck = !!op.duck;
          log.push(`Updated background music (volume ${tl.music.volume ?? 0.25}, duck ${!!tl.music.duck})`);
        } else if (op.op === 'set_text') {
          const t = (tl.text || []).find((x) => x.id === op.text_id);
          if (!t) { log.push(`No text overlay ${op.text_id}`); continue; }
          if (op.text != null) t.text = String(op.text);
          if (op.start != null) t.start = Math.max(0, +op.start || 0);
          if (op.dur != null) t.dur = Math.max(0.1, Math.min(3600, +op.dur || 0.1));
          if (op.size != null) t.size = Math.max(8, Math.min(300, +op.size));
          if (op.color != null && /^#[0-9a-f]{6}$/i.test(op.color)) t.color = op.color;
          if (op.pos != null && ['top', 'center', 'bottom'].includes(op.pos)) t.pos = op.pos;
          log.push(`Updated text overlay ${t.id}`);
        } else if (op.op === 'delete_item') {
          const groups = [['clip_id', 'video', 'clip'], ['layer_id', 'layers', 'overlay'], ['audio_id', 'audio', 'audio'], ['text_id', 'text', 'text']];
          const g = groups.find(([key]) => op[key] != null);
          if (!g) { log.push('delete_item needs clip_id, layer_id, audio_id, or text_id'); continue; }
          const arr = tl[g[1]] || [], idx = arr.findIndex((x) => x.id === op[g[0]]);
          if (idx < 0) log.push(`No ${g[2]} ${op[g[0]]}`); else { const [removed] = arr.splice(idx, 1); log.push(`Deleted ${g[2]} ${removed.name || removed.text || removed.id}`); }
        } else if (op.op === 'move_clip') {
          moveClip(tl, op.clip_id, Math.sign(+op.direction || 0));
          log.push(`Reordered clip ${op.clip_id}`);
        } else if (op.op === 'keep_ranges') {
          const rs = (op.ranges || []).map(([a, b]) => [+a, +b]).sort((x, y) => x[0] - y[0]);
          let cursor = duration(tl);
          for (let i = rs.length - 1; i >= 0; i--) { if (rs[i][1] < cursor) deleteRange(tl, rs[i][1], cursor); cursor = rs[i][0]; }
          if (cursor > 0) deleteRange(tl, 0, cursor);
          log.push(`Kept ${rs.length} range(s)`);
        } else log.push(`Skipped unknown op ${op.op}`);
      } catch (e) { log.push(`Failed ${op.op}: ${e.message}`); }
    }
    return log;
  }

  return { uid, empty, clone, clipDur, duration, layout, locate, addClip, splitAt, deleteRange, setTimelineMode, moveClipToTime, rippleDeleteAll, setTrackState, deleteVideoTrack, rollEdit, slipEdit, slideEdit, rateStretch, splitLayerAt, reorderVideoTrack,
    removeSourceRanges, splitSource, ensure, addVideoTrack, addLayer, addAudio, TRANS, addText, moveClip, summarize, applyOps, KEYFRAME_PROPERTIES, setKeyframe, evaluateKeyframes, evaluateProperties, setTransform,
    selectClips, clearSelection, duplicateSelected, copySelected, pasteClips, applyEditCommand, canDropOnTrack, dropClipToTrack };
});
