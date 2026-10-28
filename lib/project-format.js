'use strict';

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const number = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;

function emptyTimeline(settings = {}) {
  const width = Math.max(16, Math.round(number(settings.width, 1920)));
  const height = Math.max(16, Math.round(number(settings.height, 1080)));
  const frameRate = settings.frameRate && typeof settings.frameRate === 'object'
    ? { numerator: Math.max(1, number(settings.frameRate.numerator, 30)), denominator: Math.max(1, number(settings.frameRate.denominator, 1)) }
    : { numerator: Math.max(1, number(settings.fps, 30)), denominator: 1 };
  return {
    mode: 'free', settings: { ...clone(settings), width, height, frameRate },
    video: [], layers: [], audio: [], text: [], trackCount: 2,
    trackState: { '1': { name: 'V1 · Main', visible: true, muted: false, locked: false }, '2': { name: 'V2', visible: true, muted: false, locked: false } },
  };
}

function parseOriginalPayload(project) {
  if (typeof project?.legacySourceJson === 'string' && project.legacySourceJson.trim()) {
    try {
      const parsed = JSON.parse(project.legacySourceJson);
      if (parsed && typeof parsed === 'object' && parsed.tl && typeof parsed.tl === 'object') return parsed;
    } catch { /* malformed or intentionally non-JSON source; use the structured fallback */ }
  }
  const legacy = project?.legacyPayload;
  if (legacy && typeof legacy === 'object' && legacy.tl && typeof legacy.tl === 'object' && !Array.isArray(legacy.tl)) return clone(legacy);
  return null;
}

function patchNativeSequence(nativeSequence, nativeProject, baseTimeline) {
  const sequence = nativeSequence || { settings: nativeProject?.settings || {}, tracks: [], clips: [] };
  const settings = { ...(baseTimeline?.settings || {}), ...(sequence.settings || nativeProject?.settings || {}) };
  settings.frameRate = {
    numerator: Math.max(1, number(sequence.settings?.frameRate?.numerator, number(nativeProject?.settings?.frameRate?.numerator, 30))),
    denominator: Math.max(1, number(sequence.settings?.frameRate?.denominator, number(nativeProject?.settings?.frameRate?.denominator, 1))),
  };
  settings.width = Math.max(16, number(sequence.settings?.width, number(nativeProject?.settings?.width, 1920)));
  settings.height = Math.max(16, number(sequence.settings?.height, number(nativeProject?.settings?.height, 1080)));
  const tl = { ...(baseTimeline ? clone(baseTimeline) : emptyTimeline(settings)), settings };
  // Native editing uses absolute timeline positions; free mode faithfully represents overlaps.
  tl.mode = 'free';
  tl.video = []; tl.layers = []; tl.audio = []; tl.text = [];
  const tracks = [...(sequence.tracks || [])].sort((a, b) => number(a.order) - number(b.order));
  const videoTracks = tracks.filter((t) => (t.type || 'video') === 'video');
  const audioTracks = tracks.filter((t) => t.type === 'audio');
  const titleTracks = tracks.filter((t) => t.type === 'title' || t.type === 'text');
  const trackNumber = (trackId, choices, fallback = 1) => {
    const index = choices.findIndex((t) => t.id === trackId);
    return index >= 0 ? index + 1 : fallback;
  };
  const assetsById = new Map((nativeProject.assets || []).map((asset) => [asset.id, asset]));
  const appendClip = (clip) => {
    const old = clip.legacyFields && typeof clip.legacyFields === 'object' && !Array.isArray(clip.legacyFields) ? clone(clip.legacyFields) : {};
    const asset = assetsById.get(clip.assetId);
    const track = tracks.find((t) => t.id === clip.trackId);
    const rawType = clip.nestedSequenceId || clip.mediaType === 'sequence' ? 'sequence' : (clip.mediaType || track?.type || 'video');
    const item = {
      ...old,
      id: clip.id || old.id,
      name: clip.name || old.name || asset?.name || old.src || 'Untitled clip',
      in: Math.max(0, number(clip.sourceIn, number(old.in, 0))),
      out: Math.max(number(clip.sourceIn, 0), number(clip.sourceOut, number(old.out, 0))),
      speed: Math.max(0.001, number(clip.playbackRate, number(old.speed, 1))),
      start: Math.max(0, number(clip.timelineStart, number(old.start, 0))),
      volume: Math.max(0, Math.min(4, number(clip.volume, number(old.volume, 1)))),
      opacity: Math.max(0, Math.min(1, number(clip.opacity, number(old.opacity, number(old.transform?.alpha, 1))))),
      enabled: clip.enabled !== false,
      type: rawType,
    };
    if (asset?.path) item.src = asset.path;
    if (rawType === 'sequence') {
      item.type = 'sequence'; item.sequenceId = clip.nestedSequenceId || old.sequenceId || '';
      item.src = '';
    }
    if (Array.isArray(clip.effects) && clip.effects.length) {
      item.effects = clip.effects.map((e) => ({
        ...e,
        params: clone(e.params || e.parameters || {}),
        enabled: e.enabled !== false,
      }));
    }
    const videoTrack = trackNumber(clip.trackId, videoTracks, 1);
    const audioTrack = trackNumber(clip.trackId, audioTracks, 1);
    const titleTrack = trackNumber(clip.trackId, titleTracks, 1);
    if (track?.type === 'audio' || rawType === 'audio') {
      item.type = 'audio'; item.track = audioTrack; tl.audio.push(item);
    } else if (track?.type === 'title' || track?.type === 'text' || rawType === 'text' || rawType === 'title') {
      item.type = 'text'; item.track = titleTrack;
      item.dur = Math.max(0.001, number(old.dur, item.out - item.in));
      tl.text.push(item);
    } else if (videoTrack <= 1) {
      item.track = 1; tl.video.push(item);
    } else {
      item.track = videoTrack; tl.layers.push(item);
    }
  };
  for (const clip of sequence.clips || []) appendClip(clip);
  tl.video.sort((a, b) => a.start - b.start);
  tl.layers.sort((a, b) => a.track - b.track || a.start - b.start);
  tl.audio.sort((a, b) => a.track - b.track || a.start - b.start);
  tl.text.sort((a, b) => a.start - b.start);
  const maxVideoTrack = Math.max(2, videoTracks.length, number(tl.trackCount, 2));
  tl.trackCount = Math.min(64, maxVideoTrack);
  const nextState = { ...(tl.trackState || {}) };
  videoTracks.forEach((track, i) => {
    nextState[String(i + 1)] = {
      ...(nextState[String(i + 1)] || {}), name: track.name || `V${i + 1}`,
      visible: track.visible !== false, muted: !!track.muted, locked: !!track.locked,
    };
  });
  tl.trackState = nextState;
  return tl;
}

/**
 * Normalize a native C++/WPF schema-v2 project to Electron's persisted {tl, media, sequences} shape.
 * Unknown Electron-only fields are seeded from legacySourceJson and retained while native model fields win.
 */
function nativeProjectToElectron(project) {
  if (!project || typeof project !== 'object') throw new TypeError('Project must be an object');
  if (project.tl && typeof project.tl === 'object') return clone(project);
  if (project.format !== 'frosty-project' && !Array.isArray(project.assets) && !Array.isArray(project.sequences)) return clone(project);

  const original = parseOriginalPayload(project);
  const rootBase = original?.tl || null;
  const nativeSequences = Array.isArray(project.sequences) ? project.sequences : [];
  const activeId = project.activeSequenceId;
  const rootSequence = nativeSequences.find((s) => s.id === activeId) || nativeSequences[0] || null;
  const timeline = patchNativeSequence(rootSequence, project, rootBase);
  if (rootSequence?.id) timeline.id = rootSequence.id;
  if (rootSequence?.name) timeline.name = rootSequence.name;

  const media = Array.isArray(original?.media) ? clone(original.media) : [];
  const byPath = new Map(media.map((m, index) => [m.path, index]));
  for (const asset of project.assets || []) {
    if (!asset?.path) continue;
    if (byPath.has(asset.path)) {
      const i = byPath.get(asset.path);
      media[i] = { ...media[i], path: asset.path, name: asset.name || media[i].name, type: asset.mediaType || media[i].type, duration: number(asset.duration, number(media[i].duration, 0)) };
    } else {
      byPath.set(asset.path, media.length);
      media.push({ path: asset.path, name: asset.name || asset.path.split(/[\\/]/).pop(), type: asset.mediaType || 'video', duration: number(asset.duration, 0), hasAudio: asset.mediaType !== 'image', hasVideo: asset.mediaType !== 'audio' });
    }
  }

  const sequences = original?.sequences && typeof original.sequences === 'object' && !Array.isArray(original.sequences) ? clone(original.sequences) : {};
  for (const seq of nativeSequences) {
    if (!seq || seq.id === rootSequence?.id) continue;
    sequences[seq.id] = patchNativeSequence(seq, project, sequences[seq.id] || null);
    sequences[seq.id].id = seq.id;
    sequences[seq.id].name = seq.name || sequences[seq.id].name || seq.id;
  }
  return { ...(original || {}), tl: timeline, media, sequences, nativeProjectId: project.id || original?.nativeProjectId || null };
}

module.exports = { nativeProjectToElectron, patchNativeSequence, emptyTimeline };
