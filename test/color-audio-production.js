'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ff = require('../lib/ffmpeg');
const TL = require('../lib/timeline');
const analysis = require('../lib/analysis');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-color-audio-test-'));
  try {
    const source = path.join(dir, 'source.mp4');
    const still = path.join(dir, 'still.jpg');
    await ff.run(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12:duration=1.5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1.5', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
    await ff.run(['-y', '-i', source, '-frames:v', '1', still]);
    const scope = await analysis.generateScopesFromFrame(still, ff);
    assert.deepStrictEqual(Object.keys(scope.scopes).sort(), ['histogram', 'vectorscope', 'waveform']);
    for (const file of Object.values(scope.scopes)) assert(fs.existsSync(file) && fs.statSync(file).size > 64, `scope generated: ${file}`);

    const mediaReport = await analysis.analyzeMedia(source, ff, { scopes: false });
    assert(Array.isArray(mediaReport.sceneSegments) && mediaReport.sceneSegments.length >= 1, 'structured scene segments include start/end/duration');
    assert(Array.isArray(mediaReport.blackSegments) && Array.isArray(mediaReport.freezeSegments), 'black-frame and freeze detection results are explicit arrays');
    assert(mediaReport.confidence.metadata === 'high', 'confidence labels included');
    const csv = analysis.exportReport({ kind: 'test', analyzedAt: new Date().toISOString(), mediaReports: [mediaReport] }, 'csv');
    const html = analysis.exportReport({ kind: 'test', analyzedAt: new Date().toISOString(), timeline: {}, mediaReports: [mediaReport] }, 'html');
    assert(csv.includes('scene') && csv.includes('startSeconds'), 'CSV report contains structured rows');
    assert(html.includes('Frosty structured analysis') && html.includes('<table>'), 'HTML report contains readable tables');

    const analysisTl = TL.empty();
    TL.addClip(analysisTl, { path: source, name: 'source.mp4', duration: 1.5, hasAudio: true, hasVideo: true });
    analysisTl.video[0].out = 2.0;
    const timelineReport = await analysis.analyzeTimeline(analysisTl, ff, { scopes: false, includeTranscript: true, transcribe: async () => [{ start: 0.2, end: 0.8, text: 'A test transcript segment' }] });
    assert(timelineReport.clipIssues.some(x => x.code === 'trim-beyond-source'), 'timeline analysis flags trims past source duration');
    assert(timelineReport.mediaReports[0].transcript[0].text.includes('test transcript'), 'optional transcript included in report');
    assert(timelineReport.mediaReports[0].sceneSegments.every(x => typeof x.transcript === 'string'), 'transcript is mapped to scene spans');

    const tl = TL.empty();
    TL.addClip(tl, { path: source, name: 'source.mp4', duration: 1.5, hasAudio: true, hasVideo: true });
    tl.video[0].gainDb = -3;
    tl.video[0].lowShelfDb = 2;
    tl.video[0].highShelfDb = -1;
    tl.video[0].pan = 0.2;
    tl.video[0].compressor = true;
    tl.video[0].fadeIn = 0.1;
    tl.video[0].fadeOut = 0.1;
    tl.audioMaster = { gainDb: -1, compressor: true };
    const plan = ff.buildExport(tl, path.join(dir, 'planned.mp4'), { width: 160, height: 90, fps: 12, crf: 32 });
    const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];
    for (const filter of ['bass=g=2.00', 'treble=g=-1.00', 'stereotools=balance_in=0.200', 'acompressor=', 'afade=t=in', 'afade=t=out', 'volume=-1.00dB']) assert(graph.includes(filter), `filter graph includes ${filter}`);
    plan.cleanup();

    const mix = await analysis.measureTimelineMix(tl, ff, { width: 160, height: 90, fps: 12, crf: 32 });
    assert.strictEqual(mix.kind, 'frosty-rendered-timeline-mix');
    assert(mix.durationSeconds > 1.3 && mix.durationSeconds < 1.7);
    assert(Number.isFinite(mix.peakDbfs), 'final mix peak measured');
    assert(Number.isFinite(mix.rmsDbfs), 'final mix RMS measured');
    assert(mix.measurement.includes('rendered timeline output'));
    fs.rmSync(scope.directory, { recursive: true, force: true });
    console.log('color scopes and audio production runtime tests passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
