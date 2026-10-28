'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ff = require('../lib/ffmpeg');
const Ref = require('../lib/reference-template');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-reference-runtime-'));
  try {
    const source = path.join(dir, 'two-shots.mp4');
    // Synthetic two-shot reference: abrupt red→blue scene boundary + audible speech-like timing fixture.
    await ff.run(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=12:d=2',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=12:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=4',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
    const progress = [];
    const result = await Ref.analyzeReference({ src: source, ff,
      analyzeVisualFrames: async (_src, frames) => ({ styleBible: { format: 'short-form vertical edit', palette: ['red', 'blue'], typography: 'bold sans-serif-like title' }, frames: frames.map((frame) => ({ id: frame.id, description: `Observed ${frame.phase} frame in shot ${frame.shot + 1}`, visibleText: frame.phase === 'middle' ? ['DEMO'] : [], textPosition: 'lower third', typography: 'bold white text with dark outline', overlayElements: ['subtitle-like text'], palette: ['#ffffff', '#111111'], animationEvidence: `Temporal phase ${frame.phase}`, confidence: 'medium' })), shots: [{ shot: 1, titleAnimation: 'fade/scale candidate', entrance: 'fade-in', exit: 'unknown', easing: 'unknown', transition: 'hard cut', evidence: ['start/middle/end samples'], confidence: 'medium' }] }),
      transcribe: async () => [
        { start: 0.3, end: 1.1, text: 'Intro caption', confidence: 0.95 },
        { start: 2.3, end: 3.4, text: 'Second shot caption', confidence: 0.9 }
      ], onProgress: (p) => progress.push(p.phase) });
    assert.strictEqual(result.kind, 'frosty-reference-analysis');
    assert.strictEqual(result.schemaVersion, 3, 'analysis uses the enriched audio/visual shot-blueprint schema');
    assert(result.source.duration >= 3.7 && result.source.duration <= 4.4, `duration metadata should match media probe, got ${result.source.duration}`);
    assert(result.cuts.count >= 1, 'scene detector identifies the red→blue shot cut');
    assert(result.shots[0].start === 0 && result.shots[result.shots.length - 1].end === result.source.duration, 'shots cover the source range without a gap');
    assert(result.shots.every((s) => s.end > s.start && Math.abs(s.duration - (s.end - s.start)) < 0.002), 'all measured shot intervals are positive and self-consistent');
    assert.strictEqual(result.captions.transcriptStatus, 'available');
    assert.strictEqual(result.captions.segmentCount, 2);
    assert(result.shots.some((s) => s.captionText.includes('Intro caption')) && result.shots.some((s) => s.captionText.includes('Second shot caption')), 'timed transcript gets assigned to correct shots');
    assert(result.motion.sampleCount > 0 && result.motion.sampleRate === 3, 'actual FFmpeg grayscale samples were analysed');
    assert(result.shots.every((shot) => shot.motion && shot.motion.zoomDirection && shot.motion.panDirection && shot.animation), 'each shot has explicit camera-motion candidates and a separate animation classification');
    assert.strictEqual(result.visualAnalysis.status, 'available', 'batched temporal visual analysis is integrated');
    assert(result.visualAnalysis.styleBible && result.visualAnalysis.frames.length === result.visualSamples.length, 'visual style bible and frame evidence are retained');
    assert(result.shots.some((shot) => shot.visualAnalysis.visibleText.includes('DEMO')), 'frame-level OCR/visible-text hypotheses are mapped onto the relevant shot');
    assert(result.shots[0].animation.titleMotion.includes('fade'), 'AI visual animation hypotheses are attached to shot animation metadata');
    assert.strictEqual(result.audio.status, 'measured', 'audio envelope analysis is integrated for sources with audio');
    assert(result.audio.rmsPeak > 0 && Number.isFinite(result.audio.dynamicsDb), 'audio analysis reports envelope and dynamic range metrics');
    assert(result.shots.slice(1).every((shot) => shot.transition.evidence && Number.isFinite(shot.transition.evidence.peakChange)), 'transition labels carry measurable local evidence');
    assert.strictEqual(result.blueprint.length, result.shots.length, 'analysis exposes an editable per-shot reconstruction blueprint');
    assert(result.visualSamples.length >= Math.min(3, result.shots.length) && result.visualSamples.every((f) => ['start', 'middle', 'end'].includes(f.phase)), 'visual analysis includes start/middle/end samples for animation comparison');
    assert(result.cuts.events.every((event) => event.audioAlignment && event.audioAlignment.label), 'cut metadata includes measurable alignment to audio events/beats');
    assert(progress.includes('cuts') && progress.includes('motion') && progress.includes('transcript'), 'analysis reports cut, transcript and motion phases');
    const tl = Ref.buildTemplate(result, { includeCaptions: true });
    assert.strictEqual(tl.video.length, result.shots.length, 'one editable trim per detected shot');
    assert(tl.video.every((c, i) => c.src === source && c.referenceShot === i && c.out > c.in), 'editable clips retain local source path, order and source trims');
    assert(tl.text.length >= 2, 'time-coded transcript is written as editable captions');
    assert.strictEqual(tl.referenceTemplate.analysis.blueprint.length, result.shots.length, 'the editable project retains its complete shot blueprint');
    assert(tl.referenceTemplate.analysis.shots.every((shot) => shot.motion && shot.animation), 'project metadata retains camera and animation findings per shot');
    assert(Math.abs(require('../lib/timeline').duration(tl) - result.source.duration) < 0.08, 'sequential source-trim template duration matches the reference');
    await assert.rejects(() => Ref.analyzeReference({ src: source, ff, maxDuration: 1 }), /maximum is 1 seconds/, 'max duration guard rejects overlong reference videos');
    console.log(`Reference runtime integration passed: ${result.cuts.count} cut(s), ${result.shots.length} shots, ${result.motion.sampleCount} motion samples, ${tl.text.length} caption overlay(s).`);
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
})().catch((error) => { console.error(error); process.exitCode = 1; });
