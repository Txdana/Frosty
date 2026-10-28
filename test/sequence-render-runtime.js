'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TL = require('../lib/timeline');
const ff = require('../lib/ffmpeg');
const MW = require('../lib/media-workflow');
const { materializeNestedSequences } = require('../lib/sequence-render');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-sequence-runtime-'));
  const src = path.join(dir, 'source.mp4');
  const proxy = path.join(dir, 'proxy.mp4');
  const childOut = path.join(dir, 'child-check.mp4');
  const rootOut = path.join(dir, 'root-check.mp4');
  try {
    await ff.run(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
    const project = { tl: TL.empty(), sequences: {}, media: [{ path: src, name: 'source.mp4' }] };
    const child = MW.createSequence(project, 'Child');
    TL.addClip(child, { path: src, name: 'source.mp4', duration: 2, hasAudio: true });
    const root = TL.empty(); root.mode = 'free';
    root.video.push({ id: 'nested-test', type: 'sequence', sequenceId: child.id, src: '', name: 'Child', in: 0.25, out: 1.5, start: 0.5, speed: 1, track: 1, hasAudio: true, volume: 1, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alpha: 1 }, fx: {}, keyframes: {} });
    const plan = await materializeNestedSequences(root, project.sequences, { width: 160, height: 90, crf: 28 });
    try {
      assert.notStrictEqual(plan.timeline.video[0].src, '');
      assert.strictEqual(plan.timeline.video[0].type, 'video');
      assert(Math.abs(plan.timeline.video[0].in - 0.25) < 0.08, 'nested source in-point is preserved');
      await ff.exportTimeline(plan.timeline, rootOut, { width: 160, height: 90, fps: '15', crf: 30 });
      const rendered = await ff.probe(rootOut);
      assert(rendered.hasVideo && rendered.hasAudio, 'nested sequence renders video and audio');
      assert(rendered.duration >= 1.4 && rendered.duration <= 2.2, `unexpected root duration ${rendered.duration}`);
    } finally { plan.cleanup(); }
    const proxyResult = await MW.createProxy(src, proxy, ff, { width: 128, height: 72 });
    assert(fs.existsSync(proxyResult.proxy) && proxyResult.size > 0, 'proxy output exists');
    const probedProxy = await ff.probe(proxy);
    assert(probedProxy.hasVideo && probedProxy.hasAudio, 'proxy retains audio and video');

    // Regression: a sequence referenced inside another sequence may also be
    // referenced directly by the root timeline. Intermediate files must remain
    // valid until the root's materialization is cleaned up.
    const outer = MW.createSequence(project, 'Outer');
    MW.addNestedSequence(project, outer.id, child.id, 0);
    const sharedRoot = TL.empty(); sharedRoot.mode = 'free';
    sharedRoot.video.push({ id: 'outer-ref', type: 'sequence', sequenceId: outer.id, src: '', name: 'Outer', in: 0, out: 2, start: 0, speed: 1, track: 1, hasAudio: true, volume: 1, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alpha: 1 }, fx: {}, keyframes: {} });
    sharedRoot.video.push({ id: 'shared-child-ref', type: 'sequence', sequenceId: child.id, src: '', name: 'Child again', in: 0, out: 2, start: 2, speed: 1, track: 1, hasAudio: true, volume: 1, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alpha: 1 }, fx: {}, keyframes: {} });
    const sharedPlan = await materializeNestedSequences(sharedRoot, project.sequences, { width: 160, height: 90, crf: 30 });
    try {
      for (const item of sharedPlan.timeline.video) assert(fs.existsSync(item.src), `shared nested sequence intermediate remains available: ${item.src}`);
      const sharedOut = path.join(dir, 'shared-sequences.mp4');
      await ff.exportTimeline(sharedPlan.timeline, sharedOut, { width: 160, height: 90, fps: '15', crf: 30 });
      const sharedProbe = await ff.probe(sharedOut);
      assert(sharedProbe.hasVideo && sharedProbe.duration >= 3.5, 'nested child reused at root exports successfully');
    } finally { sharedPlan.cleanup(); }

    const c = TL.addClip(root, { path: src, name: 'source.mp4', duration: 2 });
    MW.setProxy(c, proxy, true);
    assert.strictEqual(c.proxyEnabled, true);
    assert.strictEqual(c.proxySrc, proxy);
    const missingSource = path.join(dir, 'gone', 'lost.mp4');
    const missingProject = { tl: { ...TL.empty(), video: [{ id: 'x', src: missingSource }] }, sequences: {}, media: [] };
    const replacement = path.join(dir, 'lost.mp4'); fs.copyFileSync(src, replacement);
    const candidates = MW.findRelinkCandidates(missingProject, dir);
    assert.strictEqual(candidates.mapping[missingSource], replacement);
    const relinked = MW.relinkMedia(missingProject, candidates.mapping);
    assert.strictEqual(relinked.changed, 1);
    assert.strictEqual(missingProject.tl.video[0].src, replacement);
    console.log('Nested sequence rendering, proxy generation, and relinking runtime checks passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
