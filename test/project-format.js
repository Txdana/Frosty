'use strict';
const assert = require('node:assert/strict');
const { nativeProjectToElectron } = require('../lib/project-format');

const oldElectronProject = {
  tl: {
    id: 'root', name: 'My edit', mode: 'free',
    settings: { width: 1280, height: 720, frameRate: { numerator: 25, denominator: 1 }, futureSetting: 'keep-me' },
    trackCount: 2,
    trackState: { '1': { name: 'V1 custom', visible: true } },
    video: [{ id: 'clip-a', src: 'C:/media/a.mp4', name: 'a.mp4', type: 'video', in: 0, out: 5, start: 0, speed: 1, volume: 1, customClipField: { preserve: true } }],
    layers: [], audio: [], text: [],
    music: { src: 'C:/media/music.wav', volume: 0.25, duck: true },
    customTimelineField: { retained: 'yes' },
  },
  media: [{ path: 'C:/media/a.mp4', name: 'a.mp4', type: 'video', duration: 12, hasAudio: true, customMedia: 42 }],
  sequences: { 'sequence-1': { id: 'sequence-1', name: 'Cutaway', mode: 'free', settings: { width: 640, height: 360, frameRate: { numerator: 24, denominator: 1 } }, trackCount: 2, video: [], layers: [], audio: [], text: [], customSequenceField: 'retain-child' } },
  customRootField: 'keep-root',
};

const native = {
  format: 'frosty-project', schemaVersion: 2, id: 'project-1', name: 'My edit', activeSequenceId: 'root',
  legacySourceJson: JSON.stringify(oldElectronProject),
  settings: { width: 1280, height: 720, frameRate: { numerator: 25, denominator: 1 } },
  assets: [
    { id: 'asset-a', path: 'C:/media/a.mp4', name: 'a.mp4', mediaType: 'video', duration: 12 },
    { id: 'asset-b', path: 'D:/new/b.png', name: 'b.png', mediaType: 'image', duration: 0 },
  ],
  sequences: [
    {
      id: 'root', name: 'My edit', settings: { width: 1280, height: 720, frameRate: { numerator: 25, denominator: 1 } },
      tracks: [{ id: 'v1', name: 'V1 custom', type: 'video', order: 0, visible: true }, { id: 'v2', name: 'V2', type: 'video', order: 1, visible: false }, { id: 'a1', name: 'A1', type: 'audio', order: 2 }],
      clips: [
        { id: 'clip-a', assetId: 'asset-a', name: 'a.mp4', mediaType: 'video', trackId: 'v1', timelineStart: 2.5, sourceIn: 1, sourceOut: 7, playbackRate: 1.5, volume: 0.75, opacity: 0.8, enabled: true, legacyFields: { customClipField: { preserve: true }, src: 'C:/media/a.mp4', fx: { contrast: 1.2 } } },
        { id: 'clip-b', assetId: 'asset-b', name: 'b.png', mediaType: 'image', trackId: 'v2', timelineStart: 3, sourceIn: 0, sourceOut: 4, playbackRate: 1, volume: 1, opacity: 1, enabled: true },
        { id: 'clip-audio', assetId: 'asset-a', name: 'a.mp4', mediaType: 'audio', trackId: 'a1', timelineStart: 0, sourceIn: 0, sourceOut: 5, playbackRate: 1, volume: 0.3, opacity: 1, enabled: true },
      ],
    },
    { id: 'sequence-1', name: 'Cutaway', settings: { width: 640, height: 360, frameRate: { numerator: 24, denominator: 1 } }, tracks: [], clips: [] },
  ],
};

const converted = nativeProjectToElectron(native);
assert.equal(converted.tl.video.length, 1);
assert.equal(converted.tl.layers.length, 1);
assert.equal(converted.tl.audio.length, 1);
assert.equal(converted.tl.video[0].start, 2.5);
assert.equal(converted.tl.video[0].in, 1);
assert.equal(converted.tl.video[0].out, 7);
assert.equal(converted.tl.video[0].speed, 1.5);
assert.equal(converted.tl.video[0].volume, 0.75);
assert.equal(converted.tl.video[0].opacity, 0.8);
assert.equal(converted.tl.video[0].customClipField.preserve, true);
assert.equal(converted.tl.video[0].fx.contrast, 1.2);
assert.equal(converted.tl.layers[0].track, 2);
assert.equal(converted.tl.layers[0].src, 'D:/new/b.png');
assert.equal(converted.tl.audio[0].volume, 0.3);
assert.equal(converted.tl.mode, 'free');
assert.equal(converted.tl.settings.futureSetting, 'keep-me');
assert.equal(converted.tl.customTimelineField.retained, 'yes');
assert.equal(converted.tl.music.duck, true);
assert.equal(converted.media.find((m) => m.path === 'C:/media/a.mp4').customMedia, 42);
assert.equal(converted.media.some((m) => m.path === 'D:/new/b.png'), true);
assert.equal(converted.sequences['sequence-1'].customSequenceField, 'retain-child');
assert.equal(converted.customRootField, 'keep-root');

// Files already in the Electron shape pass through without destructive normalization.
const wrapperPassThrough = nativeProjectToElectron(oldElectronProject);
assert.deepEqual(wrapperPassThrough, oldElectronProject);

// New native projects without a legacy Electron payload still produce a valid Electron project envelope.
const fresh = nativeProjectToElectron({
  format: 'frosty-project', id: 'fresh', name: 'Fresh', activeSequenceId: 's1',
  settings: { width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 } },
  assets: [], sequences: [{ id: 's1', name: 'Fresh', settings: { width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 } }, tracks: [], clips: [] }],
});
assert.ok(fresh.tl && Array.isArray(fresh.tl.video) && Array.isArray(fresh.media) && !Array.isArray(fresh.sequences));
console.log('Project-format bridge tests passed');
