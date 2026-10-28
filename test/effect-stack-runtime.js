'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ff = require('../lib/ffmpeg');
const TL = require('../lib/timeline');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-effects-'));
  try {
    const source = path.join(dir, 'source.mp4');
    await ff.run(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=1.5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
    const media = await ff.probe(source);

    const sequential = TL.empty();
    TL.setFrameRate(sequential, '24/1');
    const clip = TL.addClip(sequential, media);
    clip.effects = [{ id: 'brightness-1', type: 'brightness', enabled: true, params: { value: 0 }, keyframes: { value: [{ t: 0, v: -0.7, interpolation: 'linear' }, { t: 1, v: 0.6, interpolation: 'bezier' }] } }, { id: 'gray-1', type: 'grayscale', enabled: true }];
    clip.mask = { enabled: true, shape: 'ellipse', x: 0.1, y: 0.05, width: 0.8, height: 0.9, invert: false, keyframes: { x: [{ t: 0, v: 0.05 }, { t: 1, v: 0.2 }] } };
    TL.setTrackState(sequential, 1, { effects: [{ type: 'saturation', enabled: true, params: { value: 1 }, keyframes: { value: [{ t: 0, v: 0.5 }, { t: 1, v: 1.5 }] } }] });
    sequential.masterEffects = [{ type: 'vignette', enabled: true, params: {} }];
    const seqOut = path.join(dir, 'sequential-effects.mp4');
    await ff.exportTimeline(sequential, seqOut, { width: 320, height: 180, fps: '24/1', crf: 30, audioBitrate: '96k' });
    const seqProbe = await ff.probe(seqOut);
    assert(seqProbe.hasVideo && seqProbe.hasAudio, 'sequential export renders animated effect stack and alpha mask');

    const free = TL.empty();
    TL.setTimelineMode(free, 'free'); TL.setFrameRate(free, '24/1');
    const base = TL.addClip(free, media); base.start = 0; base.track = 1;
    base.effects = [{ type: 'contrast', enabled: true, params: { value: 1 }, keyframes: { value: [{ t: 0, v: 0.5 }, { t: 1, v: 2 }] } }];
    base.mask = { enabled: true, shape: 'rectangle', x: 0.05, y: 0.05, width: 0.9, height: 0.9, invert: true };
    const top = TL.addClip(free, media); top.start = 0.25; top.track = 2;
    top.effects = [{ type: 'hue', enabled: true, params: { degrees: 0 }, keyframes: { degrees: [{ t: 0, v: -45 }, { t: 0.75, v: 45 }] } }];
    top.mask = { enabled: true, shape: 'ellipse', x: 0.2, y: 0.1, width: 0.6, height: 0.8, invert: false };
    TL.setTrackState(free, 1, { visible: true, effects: [{ type: 'brightness', enabled: true, params: { value: 0 }, keyframes: { value: [{ t: 0, v: 0.1 }, { t: 1, v: -0.1 }] } }] });
    TL.setTrackState(free, 2, { visible: true, effects: [{ type: 'saturation', enabled: true, params: { value: 1.1 } }] });
    free.masterEffects = [{ type: 'gamma', enabled: true, params: { value: 1 }, keyframes: { value: [{ t: 0, v: 0.8 }, { t: 1, v: 1.2 }] } }];
    const freeOut = path.join(dir, 'free-effects.mp4');
    await ff.exportTimeline(free, freeOut, { width: 320, height: 180, fps: '24/1', crf: 30, audioBitrate: '96k' });
    const freeProbe = await ff.probe(freeOut);
    assert(freeProbe.hasVideo && freeProbe.hasAudio, 'free timeline renders animated effects and masks across stacked tracks');

    const pathTl = TL.empty(); TL.setFrameRate(pathTl, '24/1');
    const pathClip = TL.addClip(pathTl, media); pathClip.mask = { enabled: true, shape: 'path', points: [[0.08, 0.08], [0.92, 0.12], [0.7, 0.92], [0.3, 0.84]], feather: 2, invert: false };
    const pathOut = path.join(dir, 'path-mask.mp4');
    const encoderOptions = { width: 160, height: 90, fps: '24/1', frameCount: 1, crf: 35, audioBitrate: '64k', gpuEncoding: 'auto' };
    await ff.exportTimeline(pathTl, pathOut, encoderOptions);
    assert(encoderOptions.encoderUsed && (encoderOptions.encoderUsed === 'libx264' || encoderOptions.encoderUsed === 'libx265' || /_(nvenc|qsv|amf|videotoolbox)$/.test(encoderOptions.encoderUsed)), 'auto encoder mode records the encoder that actually succeeded');
    assert(ff.videoEncoderCandidates({ gpuEncoding: 'auto' }).includes('libx264'), 'automatic hardware encoding always includes a tested software fallback');
    assert(ff.videoEncoderArgs('h264_nvenc', { crf: 23 }).includes('-cq'), 'NVENC uses codec-appropriate quality arguments rather than libx264 CRF options');
    assert((await ff.probe(pathOut)).hasVideo, 'polygon mask with feather renders through FFmpeg');

    const sourceText = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ffmpeg.js'), 'utf8');
    const uiText = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    assert(sourceText.includes('function effectStackChain(owner, trackState, timeExpr'), 'effect keyframes accept an owner-local timebase');
    assert(sourceText.includes('function maskChain(owner, timeExpr'), 'mask geometry can be keyframed');
    assert(sourceText.includes("'rectangle', 'ellipse', 'path'") && sourceText.includes('signedDistance'), 'polygon paths and feathered alpha masks are supported');
    assert(uiText.includes('Polygon points (normalized X/Y, 0–1)') && uiText.includes('Mask feather (px)'), 'path/feather controls are exposed in clip and overlay inspectors');
    assert(uiText.includes('Keyframe ${title} at playhead') && uiText.includes('Keyframe mask ${labelText}'), 'effect parameters and mask geometry expose keyframe controls');
    console.log('Effect stack, animated parameter and mask runtime regression passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
