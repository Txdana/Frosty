'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ff = require('../lib/ffmpeg');
const Compare = require('../lib/reference-comparator');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-reference-compare-'));
  try {
    const source = path.join(dir, 'reference.mp4');
    const different = path.join(dir, 'different.mp4');
    await ff.run(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=12:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=12:d=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
    await ff.run(['-y', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=12:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', different]);
    const same = await Compare.compareVideos(source, source, ff, { fps: 2, width: 80, height: 45 });
    assert(same.sampling.comparedFrames >= 4, 'frame sampler compares a time-aligned set of frames');
    assert.strictEqual(same.pixel.meanAbsoluteError, 0, 'identical source/render frames have no sampled RGB error');
    assert.strictEqual(same.pixel.similarityPercent, 100, 'identical source/render frames report full pixel similarity');
    assert(same.cuts && Number.isFinite(same.cuts.matchedReferenceCuts), 'cut boundaries are compared as an independent signal');
    const mismatch = await Compare.compareVideos(source, different, ff, { fps: 2, width: 80, height: 45 });
    assert(mismatch.pixel.meanAbsoluteError > 10, 'different picture content produces measurable RGB error');
    assert(mismatch.pixel.globalSsimEstimate < 1, 'structural estimate responds to different picture content');
    assert(mismatch.durationDifferenceSeconds > 0, 'duration mismatch is reported rather than silently ignored');
    assert(mismatch.sampling.renderedFrames > mismatch.sampling.referenceFrames && mismatch.frameCountDifference < 0, 'sample counts expose the longer rendered tail rather than truncating both sample sets');
    console.log(`Reference comparator runtime passed: identical MAE ${same.pixel.meanAbsoluteError}, altered MAE ${mismatch.pixel.meanAbsoluteError}, ${same.sampling.comparedFrames} samples.`);
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
})().catch((error) => { console.error(error); process.exitCode = 1; });
