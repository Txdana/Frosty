// Focused regression for canonical still + continuous playback render.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ff = require('../lib/ffmpeg');
const TL = require('../lib/timeline');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const renderEngineSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'render-engine.js'), 'utf8');
assert(rendererSource.includes('window.frosty.previewMovie(payload)'), 'Play requests the unified timeline render');
assert(rendererSource.includes('timelinePlayback.currentTime'), 'playhead is synchronized to rendered movie time');
assert(rendererSource.includes('TL.frameToSeconds(frame, S.tl)'), 'playhead is snapped to the project frame grid');
assert(mainSource.includes("ipcMain.handle('preview:movie'"), 'main process exposes preview movie render');
assert(htmlSource.includes('id="timelinePlayback"'), 'renderer has a dedicated canonical playback surface');
assert(renderEngineSource.includes("'-fps_mode', 'passthrough'"), 'still extraction uses the current FFmpeg frame-sync option');
assert(!renderEngineSource.includes("'-vsync', '0'"), 'still extraction does not use the removed FFmpeg -vsync option');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-preview-playback-'));
  try {
    const source = path.join(dir, 'source.mp4');
    await ff.run(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=1.5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
    const media = await ff.probe(source);
    const tl = TL.empty(); TL.setFrameRate(tl, '24000/1001');
    TL.addClip(tl, media);
    TL.addText(tl, 'Frame-accurate playback', 0.1, 1.0);
    const movie = path.join(dir, 'preview.mp4');
    await ff.exportTimeline(tl, movie, { width: 320, height: 180, fps: TL.frameRateString(tl), crf: 30, audioBitrate: '96k' });
    const result = await ff.probe(movie);
    assert(result.hasVideo && result.hasAudio, 'rendered playback has video and timeline audio');
    assert(result.width === 320 && result.height === 180, 'rendered playback respects preview dimensions');
    assert(Math.abs(result.duration - TL.duration(tl)) < 0.25, `render duration matches timeline (${result.duration} vs ${TL.duration(tl)})`);
    const freeTl = TL.empty(); TL.setTimelineMode(freeTl, 'free');
    const first = TL.addClip(freeTl, media); first.start = 0;
    const second = TL.addClip(freeTl, media); second.start = 0.5; second.track = 2;
    TL.setTrackState(freeTl, 1, { visible: true }); TL.setTrackState(freeTl, 2, { visible: true });
    TL.addText(freeTl, 'Free timeline overlay', 0.2, 1.0);
    const freeMovie = path.join(dir, 'free-preview.mp4');
    await ff.exportTimeline(freeTl, freeMovie, { width: 320, height: 180, fps: TL.frameRateString(freeTl), crf: 30, audioBitrate: '96k' });
    const freeResult = await ff.probe(freeMovie);
    assert(freeResult.hasVideo && freeResult.hasAudio && Math.abs(freeResult.duration - TL.duration(freeTl)) < 0.25, 'free timeline renders overlapping tracks and the timeline audio mix');
    const stillEngine = require('../lib/render-engine');
    const still = await stillEngine.renderPreviewFrame(tl, 12, { width: 320, height: 180, fps: TL.frameRateString(tl) });
    assert(still.frame === 12 && still.dataUrl.startsWith('data:image/jpeg;base64,'), 'paused preview returns the exact requested frame');
    console.log('Frame preview/playback regression passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
