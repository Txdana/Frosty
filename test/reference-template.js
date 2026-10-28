'use strict';
const assert = require('assert');
const TL = require('../lib/timeline');
const Ref = require('../lib/reference-template');

const shots = Ref.segmentBoundaries(8, [
  { time: 0.04, score: 0.9 },
  { time: 2, score: 0.75, confidence: 'high' },
  { time: 2.1, score: 0.7, confidence: 'high' },
  { time: 4.5, score: 0.5, confidence: 'medium' },
  { time: 7.95, score: 0.99 }
]);
assert.deepStrictEqual(shots.map((s) => [s.start, s.end]), [[0, 2], [2, 4.5], [4.5, 8]], 'too-close and edge cuts are dropped and remaining shot durations stay correct');
assert(shots.every((s) => s.duration > 0 && Math.abs((s.end - s.start) - s.duration) < 0.002), 'shot duration metadata matches each boundary');
const pace = Ref.paceSummary(shots);
assert.strictEqual(pace.medianShotSeconds, 2.5, 'median shot duration describes rhythm');
assert.strictEqual(pace.pace, 'measured', 'pace is classified from median shot duration');
const normalized = Ref.normalizeTranscript([
  { start: -1, end: 1.2, text: '  Hello   Frosty ', confidence: 0.91 },
  { start: 2, end: 9, text: 'Outro' },
  { start: 3, end: 2, text: 'invalid interval' },
  { start: 4, end: 5, text: '' }
], 4);
assert.deepStrictEqual(normalized.map((x) => [x.start, x.end, x.text]), [[0, 1.2, 'Hello Frosty'], [2, 4, 'Outro']], 'transcript is normalized, clipped and rejects empty intervals');
const frameBytes = 24 * 18;
const frame = Buffer.alloc(frameBytes);
for (let y = 0; y < 18; y++) for (let x = 0; x < 24; x++) frame[y * 24 + x] = (x * 7 + y * 11) % 255;
const parsed = Ref.parseMotionBytes(Buffer.concat([frame, frame, frame]), frameBytes, 24, 18, 3);
assert.strictEqual(parsed.length, 2, 'motion sampler compares adjacent frames');
assert(parsed.every((row) => row.camera === 'steady' && row.score === 0), 'static frames are not falsely tagged as camera motion');
const analysis = {
  schemaVersion: 1, kind: 'frosty-reference-analysis',
  source: { path: 'reference.mp4', name: 'reference.mp4', duration: 4, width: 640, height: 360, hasAudio: true, hasVideo: true },
  cuts: { count: 1, threshold: 0.28, events: [{ time: 2, score: 0.7, confidence: 'high' }] },
  pace: { medianShotSeconds: 2, meanShotSeconds: 2, pace: 'fast', variability: 0 }, transitions: { cut: 1 },
  shots: [
    { index: 0, start: 0, end: 2, duration: 2, transition: { type: 'none', confidence: 'high' }, boundaryScore: null, boundaryConfidence: 'high', motion: { camera: 'zoom-in', cameraConfidence: 'low', activity: 'moderate', score: 0.12 }, transcript: [], captionText: '' },
    { index: 1, start: 2, end: 4, duration: 2, transition: { type: 'cut', confidence: 'high' }, boundaryScore: 0.7, boundaryConfidence: 'high', motion: { camera: 'steady', cameraConfidence: 'low', activity: 'low', score: 0.02 }, transcript: [], captionText: '' }
  ], captions: { transcriptStatus: 'available', segmentCount: 2, visualTextStatus: 'not-requested', transcript: [
    { start: 0.2, end: 1.4, text: 'Hello there', confidence: 0.96 }, { start: 2.2, end: 3.8, text: 'Next shot', confidence: 0.88 }
  ] }, motion: { status: 'measured', sampleCount: 12, sampleRate: 3 }, animation: { analysisStatus: 'visual-model-required-for-style-classification' }, visualSamples: [], limitations: []
};
const tl = Ref.buildTemplate(analysis, { includeCaptions: true });
assert.strictEqual(tl.video.length, 2, 'reference template uses editable clip per detected shot');
assert.deepStrictEqual(tl.video.map((c) => [c.in, c.out]), [[0, 2], [2, 4]], 'source shot boundaries become source in/out trim points');
assert.strictEqual(tl.text.length, 2, 'time-coded dialogue becomes editable caption overlays');
assert.strictEqual(tl.referenceTemplate.analysis.shots.length, 2, 'template stores shot analysis metadata');
assert.strictEqual(tl.video[1].referenceMotion.camera, 'steady', 'camera movement estimates stay available to humans and AI');
const withoutCaptions = Ref.buildTemplate(analysis, { includeCaptions: false });
assert.strictEqual(withoutCaptions.text.length, 0, 'captions can be disabled independently of cut analysis');
// Prevent a second caption layer when model-observed on-screen text already matches speech transcription.
const visibleCaptionAnalysis = JSON.parse(JSON.stringify(analysis));
visibleCaptionAnalysis.shots[0].visualAnalysis = { status: 'sampled', visibleText: ['Hello there'], evidence: [{ phase: 'middle', confidence: 'medium' }] };
visibleCaptionAnalysis.visualSamples = [{ id: 'frame-1', shot: 0, time: 0.8, phase: 'middle', visualEvidence: { visibleText: ['Hello there'], confidence: 'medium' } }];
const deduped = Ref.buildTemplate(visibleCaptionAnalysis, { includeCaptions: true });
assert.strictEqual(deduped.text.length, 1, 'visible transcript-matching captions are not duplicated as another overlay');
assert.strictEqual(deduped.referenceTemplate.analysis.captionOverlayAudit.skippedVisibleDuplicates, 1, 'the analysis records why a matching burned-in caption was skipped');
// Verify PCM rhythm estimation remains conservative for steady tones and can identify a pulsed rhythm.
const pulseRate = 8000, pulseDuration = 6, pulseBuffer = Buffer.alloc(pulseRate * pulseDuration * 4);
for (let i = 0; i < pulseRate * pulseDuration; i++) {
  const t = i / pulseRate;
  const phase = t % 0.5;
  const envelope = phase < 0.07 ? 0.9 : 0.08;
  pulseBuffer.writeFloatLE(envelope * Math.sin(2 * Math.PI * 220 * t), i * 4);
}
const rhythm = Ref.analyzeAudioPcm(pulseBuffer, pulseRate);
assert.strictEqual(rhythm.status, 'measured', 'PCM analysis returns measured audio envelope data');
assert(rhythm.onsetCount >= 6, 'periodic amplitude transients are recorded as onsets');
assert(rhythm.estimatedBpm && Math.abs(rhythm.estimatedBpm - 120) <= 12, `a synthetic 120 BPM pulse should have a near-tempo estimate, got ${rhythm.estimatedBpm}`);
assert(rhythm.beatTimes.length > 5 && rhythm.beatConfidence >= 0.28, 'beat times are exposed only when periodicity is confident');
const aligned = Ref.alignCutsToAudio([{ time: 1.5, score: 0.8 }], rhythm);
assert(aligned[0].audioAlignment.nearestBeat && aligned[0].audioAlignment.label !== 'not-estimated', 'cut timing can be compared with estimated beats');
assert(Ref.selectRepresentativeShots(Array.from({ length: 30 }, (_, index) => ({ index })), 8).length === 8, 'visual samples are distributed across long references rather than clustered at the beginning');

console.log('Reference-template analysis and structure tests passed.');
