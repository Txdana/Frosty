'use strict';

const FrostyBezierMaskApi = (() => {
// Cubic, closed vector masks. Coordinates and handles use normalized frame space (0..1).
// A node is { x, y, in: {x,y}, out: {x,y} }; handles are absolute positions, not deltas.
const MAX_NODES = 12;
const clamp01 = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : fallback;
const point = (p, fallback = { x: 0, y: 0 }) => ({ x: clamp01(p?.x, fallback.x), y: clamp01(p?.y, fallback.y) });

function normalizeNode(value, fallback) {
  const anchor = point(value, fallback || { x: 0.5, y: 0.5 });
  const input = point(value?.in, anchor);
  const output = point(value?.out, anchor);
  return { ...anchor, in: input, out: output };
}

function defaultBezierNodes() {
  // Four smooth anchors approximating an ellipse, ready to drag into any organic shape.
  return [
    { x: .5, y: .12, in: { x: .34, y: .12 }, out: { x: .66, y: .12 } },
    { x: .88, y: .5, in: { x: .88, y: .29 }, out: { x: .88, y: .71 } },
    { x: .5, y: .88, in: { x: .66, y: .88 }, out: { x: .34, y: .88 } },
    { x: .12, y: .5, in: { x: .12, y: .71 }, out: { x: .12, y: .29 } },
  ];
}

function normalizeNodes(raw, { min = 3, max = MAX_NODES } = {}) {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) throw new TypeError(`Bezier mask needs ${min}–${max} anchor nodes.`);
  return raw.map((n, i) => normalizeNode(n, { x: (i + 1) / (raw.length + 1), y: .5 }));
}

function normalizePathKeyframes(mask) {
  const source = Array.isArray(mask?.pathKeyframes) ? mask.pathKeyframes : [];
  const count = Array.isArray(mask?.nodes) ? mask.nodes.length : null;
  const result = [];
  for (const key of source) {
    const t = Number(key?.t);
    if (!Number.isFinite(t) || t < 0 || !Array.isArray(key?.nodes)) continue;
    if (count !== null && key.nodes.length !== count) continue;
    try { result.push({ t, nodes: normalizeNodes(key.nodes), interpolation: ['linear', 'bezier', 'constant'].includes(key.interpolation) ? key.interpolation : 'linear' }); } catch { /* Ignore malformed keyframes rather than corrupting a project. */ }
  }
  result.sort((a, b) => a.t - b.t);
  return result.filter((key, index) => index === 0 || Math.abs(key.t - result[index - 1].t) > 1e-6);
}

function evaluateNodes(mask, time = 0) {
  const base = normalizeNodes(mask?.nodes || defaultBezierNodes());
  const keys = normalizePathKeyframes({ ...mask, nodes: base });
  if (!keys.length) return base;
  if (time <= keys[0].t) return keys[0].nodes.map(n => structuredClone(n));
  if (time >= keys[keys.length - 1].t) return keys[keys.length - 1].nodes.map(n => structuredClone(n));
  let i = 0;
  while (i < keys.length - 1 && time > keys[i + 1].t) i++;
  const a = keys[i], b = keys[i + 1];
  let u = Math.max(0, Math.min(1, (time - a.t) / Math.max(1e-9, b.t - a.t)));
  if (a.interpolation === 'constant') u = 0;
  else if (a.interpolation === 'bezier') u = u * u * (3 - 2 * u);
  const mixPoint = (p, q) => ({ x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u });
  return a.nodes.map((n, j) => ({ x: n.x + (b.nodes[j].x - n.x) * u, y: n.y + (b.nodes[j].y - n.y) * u,
    in: mixPoint(n.in, b.nodes[j].in), out: mixPoint(n.out, b.nodes[j].out) }));
}

function sampleNodes(nodes, samplesPerSegment = 8) {
  const normalized = normalizeNodes(nodes);
  const steps = Math.max(2, Math.min(24, Math.trunc(samplesPerSegment) || 8));
  const out = [];
  const cubic = (p0, p1, p2, p3, t) => {
    const mt = 1 - t;
    return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
  };
  for (let i = 0; i < normalized.length; i++) {
    const a = normalized[i], b = normalized[(i + 1) % normalized.length];
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push({ x: clamp01(cubic(a.x, a.out.x, b.in.x, b.x, t)), y: clamp01(cubic(a.y, a.out.y, b.in.y, b.y, t)) });
    }
  }
  return out;
}

function toSvgPath(nodes, width = 1000, height = 562.5) {
  const n = normalizeNodes(nodes);
  const xy = p => `${(p.x * width).toFixed(2)},${(p.y * height).toFixed(2)}`;
  let d = `M ${xy(n[0])}`;
  for (let i = 0; i < n.length; i++) {
    const a = n[i], b = n[(i + 1) % n.length];
    d += ` C ${xy(a.out)} ${xy(b.in)} ${xy(b)}`;
  }
  return d + ' Z';
}

function polygonToNodes(points) {
  if (!Array.isArray(points) || points.length < 3) return defaultBezierNodes();
  return normalizeNodes(points.slice(0, MAX_NODES).map(p => {
    const x = Array.isArray(p) ? p[0] : p?.x, y = Array.isArray(p) ? p[1] : p?.y;
    const a = point({ x, y }, { x: .5, y: .5 });
    return { ...a, in: { ...a }, out: { ...a } };
  }));
}

function validateMask(mask) {
  if (!mask || typeof mask !== 'object') return { valid: false, reason: 'Mask is missing.' };
  if (mask.shape !== 'bezier') return { valid: true, reason: '' };
  try {
    const nodes = normalizeNodes(mask.nodes);
    const keys = normalizePathKeyframes({ ...mask, nodes });
    const count = nodes.length;
    if (keys.some(k => k.nodes.length !== count)) return { valid: false, reason: 'Every mask path keyframe must use the same anchor count.' };
    return { valid: true, reason: '', nodeCount: count, keyframeCount: keys.length };
  } catch (error) { return { valid: false, reason: error.message }; }
}

return { MAX_NODES, clamp01, normalizeNode, normalizeNodes, normalizePathKeyframes, defaultBezierNodes, evaluateNodes, sampleNodes, toSvgPath, polygonToNodes, validateMask };
})();
if (typeof module === 'object' && module.exports) module.exports = FrostyBezierMaskApi;
if (typeof window !== 'undefined') window.FrostyBezierMask = FrostyBezierMaskApi;
