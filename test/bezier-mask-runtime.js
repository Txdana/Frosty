'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ff = require('../lib/ffmpeg');
const TL = require('../lib/timeline');
const BM = require('../lib/bezier-mask');
const { rasterizeBezierMask, collectAnimatedBezierMasks } = require('../lib/bezier-mask-render');
const { renderPreviewFrame } = require('../lib/render-engine');

function moveShape(center) {
  return BM.defaultBezierNodes().map((n) => ({
    x: Math.max(0, Math.min(1, center + (n.x - .5) * .5)),
    y: n.y,
    in: { x: Math.max(0, Math.min(1, center + (n.in.x - .5) * .5)), y: n.in.y },
    out: { x: Math.max(0, Math.min(1, center + (n.out.x - .5) * .5)), y: n.out.y },
  }));
}
function animatedMask() {
  const first = moveShape(.25), last = moveShape(.75);
  return { enabled: true, shape: 'bezier', nodes: first, feather: 0, invert: false,
    pathKeyframes: [{ t: 0, nodes: first, interpolation: 'linear' }, { t: 1, nodes: last, interpolation: 'linear' }] };
}
async function exportAndSample(timeline, dir, outputName, config = {}) {
  const output = path.join(dir, outputName);
  const options = { width: 160, height: 90, fps: '12/1', crf: 23, audioBitrate: '64k', gpuEncoding: 'software', ...config };
  await ff.exportTimeline(timeline, output, options);
  assert(fs.existsSync(output) && fs.statSync(output).size > 512, `${outputName} is a real render`);
  const media = await ff.probe(output);
  assert(media.hasVideo && media.width === 160 && media.height === 90, `${outputName} has valid video dimensions`);
  const samplePixel = async (time, x, y, name) => {
    const raw = path.join(dir, `${outputName}-${name}.gray`);
    await ff.run(['-y', '-ss', String(time), '-i', output, '-vf', `crop=1:1:${x}:${y},format=gray`, '-frames:v', '1', '-f', 'rawvideo', raw]);
    const bytes = fs.readFileSync(raw);
    assert.strictEqual(bytes.length, 1, `pixel sample ${name} exists`);
    return bytes[0];
  };
  return { output, media, samplePixel };
}

(async () => {
  const defaultNodes = BM.defaultBezierNodes();
  const valid = { enabled: true, shape: 'bezier', nodes: defaultNodes, pathKeyframes: [{ t: 0, nodes: defaultNodes }, { t: 1, nodes: moveShape(.7) }] };
  assert.strictEqual(BM.validateMask(valid).valid, true, 'valid path accepted');
  assert.strictEqual(BM.evaluateNodes(valid, 0.5).length, 4, 'path animation keeps topology stable');
  assert.notDeepStrictEqual(BM.evaluateNodes(valid, 0.1), BM.evaluateNodes(valid, 0.9), 'keyframed geometry actually interpolates');
  const matteA = rasterizeBezierMask(valid, 160, 90, 0.05);
  const matteB = rasterizeBezierMask(valid, 160, 90, 0.95);
  assert.strictEqual(matteA.length, 160 * 90);
  assert.notDeepStrictEqual(matteA, matteB, 'rasterized matte changes over time');
  const staticMask = { ...valid, pathKeyframes: [] };
  assert.strictEqual(collectAnimatedBezierMasks({ video: [{ id: 'static', src: 'x', mask: staticMask }], layers: [] }).length, 0, 'static path does not require a matte movie');
  assert.strictEqual(collectAnimatedBezierMasks({ video: [{ id: 'animated', src: 'x', mask: valid }], layers: [] }).length, 1, 'animated path uses a time-varying matte');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-bezier-mask-test-'));
  try {
    const white = path.join(dir, 'white.mp4'), black = path.join(dir, 'black.mp4');
    await ff.run(['-y', '-f', 'lavfi', '-i', 'color=c=white:s=160x90:r=12:d=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '1.2', white]);
    await ff.run(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=12:d=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '1.2', black]);
    const whiteMedia = await ff.probe(white), blackMedia = await ff.probe(black);

    const sequential = TL.empty(); TL.setFrameRate(sequential, '12/1');
    const clip = TL.addClip(sequential, whiteMedia); clip.out = whiteMedia.duration; clip.mask = animatedMask();
    const seq = await exportAndSample(sequential, dir, 'sequential-bezier.mp4');
    const seqLeftFirst = await seq.samplePixel(.1, 40, 45, 'left-first');
    const seqLeftLast = await seq.samplePixel(.9, 40, 45, 'left-last');
    const seqRightFirst = await seq.samplePixel(.1, 120, 45, 'right-first');
    const seqRightLast = await seq.samplePixel(.9, 120, 45, 'right-last');
    assert(seqLeftFirst > 180 && seqLeftLast < 80, 'sequential export reveals left region first and masks it later');
    assert(seqRightFirst < 80 && seqRightLast > 180, 'sequential export masks the right region first and reveals it later');

    const free = TL.empty(); TL.setTimelineMode(free, 'free'); TL.setFrameRate(free, '12/1');
    const base = TL.addClip(free, blackMedia); base.start = 0; base.track = 1; base.out = blackMedia.duration;
    const foreground = TL.addClip(free, whiteMedia); foreground.start = 0; foreground.track = 2; foreground.out = whiteMedia.duration; foreground.mask = animatedMask();
    const freeClip = await exportAndSample(free, dir, 'free-track-bezier.mp4');
    assert((await freeClip.samplePixel(.1, 40, 45, 'left-first')) > 180, 'free-track clip mask works at its starting pose');
    assert((await freeClip.samplePixel(.9, 40, 45, 'left-last')) < 80, 'free-track clip mask animates in export');

    const layerTimeline = TL.empty(); TL.setTimelineMode(layerTimeline, 'free'); TL.setFrameRate(layerTimeline, '12/1');
    const layerBase = TL.addClip(layerTimeline, blackMedia); layerBase.start = 0; layerBase.track = 1; layerBase.out = blackMedia.duration;
    layerTimeline.layers.push({ id: 'bezier-layer-1', type: 'video', src: white, name: 'white overlay', in: 0, out: whiteMedia.duration, start: 0, track: 2, scale: 1, x: .5, y: .5, opacity: 1, rotation: 0, hasAudio: false, mask: animatedMask() });
    const layer = await exportAndSample(layerTimeline, dir, 'free-layer-bezier.mp4');
    assert((await layer.samplePixel(.1, 40, 45, 'left-first')) > 180, 'overlay layer mask is present at first pose');
    assert((await layer.samplePixel(.9, 40, 45, 'left-last')) < 80, 'overlay layer mask animation is exported');

    const preview1 = await renderPreviewFrame(sequential, 1, { width: 160, height: 90, fps: '12/1', hardwareAcceleration: false });
    const preview10 = await renderPreviewFrame(sequential, 10, { width: 160, height: 90, fps: '12/1', hardwareAcceleration: false });
    assert(preview1.dataUrl !== preview10.dataUrl, 'sampled preview evaluates the animated mask at the requested frame');

    const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
    assert(source.includes('renderBezierMaskEditor') && source.includes('bezier-handle') && source.includes('Keyframe path'), 'interactive Bézier handles and path keyframes are exposed');
    assert(source.includes('splitBezierSegment') && source.includes('shiftKey'), 'curve insertion and constrained handle editing are implemented');
    assert(html.includes('../lib/bezier-mask.js'), 'shared curve model loads before the editor');
    const nativeDir = path.join(__dirname, '..', 'windows', 'Frosty.Desktop');
    const nativeXaml = fs.readFileSync(path.join(nativeDir, 'MainWindow.xaml'), 'utf8');
    const nativeUi = fs.readFileSync(path.join(nativeDir, 'MainWindow.xaml.cs'), 'utf8');
    const nativeMask = fs.readFileSync(path.join(nativeDir, 'BezierMaskModel.cs'), 'utf8');
    const nativeExport = fs.readFileSync(path.join(nativeDir, 'NativeWorkflow.cs'), 'utf8');
    const nativeGpu = fs.readFileSync(path.join(nativeDir, 'GpuPreviewHost.cs'), 'utf8');
    const nativeCore = fs.readFileSync(path.join(__dirname, '..', 'native', 'src', 'core.cpp'), 'utf8');
    const nativeApi = fs.readFileSync(path.join(__dirname, '..', 'native', 'src', 'c_api.cpp'), 'utf8');
    assert(nativeXaml.includes('BezierMaskCanvas') && nativeXaml.includes('MaskAddKeyframe_Click') && nativeXaml.includes('MaskAddAnchor_Click') && nativeXaml.includes('MaskDeleteKeyframe_Click'), 'native WPF exposes the Bézier canvas, anchor and animation controls');
    assert(nativeUi.includes('SplitSegmentEverywhere') && nativeUi.includes('MouseLeftButtonDown') && nativeUi.includes('Key.LeftShift') && nativeUi.includes('MaskAddKeyframe_Click'), 'native WPF supports curve-preserving insertion, drag handles and mirrored Shift editing');
    assert(nativeMask.includes('Evaluate(JsonObject mask') && nativeMask.includes('SampleAdaptive') && nativeMask.includes('FlattenCubic') && nativeMask.includes('CreateMatteVideoAsync') && nativeMask.includes('BoxBlur'), 'native mask model evaluates keyframes, adaptively rasterizes smooth feathered mattes and encodes them');
    assert(nativeMask.includes('\"rawvideo\"') && nativeMask.includes('RedirectStandardInput=true') && nativeMask.includes('WriteAsync(pixels.AsMemory(),ct)'), 'animated native mattes stream grayscale frames through FFmpeg stdin without accumulating PNG sequences');
    assert(nativeExport.includes('CreateMatteVideoAsync') && nativeExport.includes('alphaextract') && nativeExport.includes('blend=all_mode=multiply') && nativeExport.includes('alphamerge') && nativeExport.includes('maskInputIndex'), 'native export multiplies original alpha by the Bézier matte and composites mask inputs');
    assert(nativeGpu.includes('BezierMaskModel.ApplyToBgra') && nativeGpu.includes('pos-clip.Start') && nativeGpu.includes('_staticMaskMatteCache.Clear()'), 'native real-time GPU preview evaluates clip-local masks and invalidates cached mattes on stop/restart');
    assert(nativeApi.includes('frosty_project_set_clip_mask_json') && nativeCore.includes('CommandKind::SetClipMask') && nativeCore.includes('Every Bézier path keyframe'), 'native API persists and validates masks as undoable project commands');
    console.log('Interactive Bézier mask, animated matte export, stacked-track, overlay-layer, sampled-preview and native WPF integration checks passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
