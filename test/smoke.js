// End-to-end check of Frosty's engine: make a clip, probe, detect silence, edit, export, verify.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ff = require('../lib/ffmpeg');
const TL = require('../lib/timeline');

const sceneIndex = require('../lib/scene-index');
const sceneTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-index-test-'));
const sceneIndexPath = path.join(sceneTmp, 'index.json');
sceneIndex.save(sceneIndexPath, { version: 1, scenes: [
  { key: '1', src: 'a.mp4', name: 'interview.mp4', start: 2, end: 4, caption: 'A person walks into a bright office', transcript: 'Welcome to the product demo' },
  { key: '2', src: 'b.mp4', name: 'football.mp4', start: 8, end: 11, caption: 'Football players running on a green field', transcript: 'What a goal' }
] });
assert.strictEqual(sceneIndex.search(sceneIndex.load(sceneIndexPath), 'person office demo')[0].key, '1', 'scene retrieval ranks matching semantic text');
assert.strictEqual(sceneIndex.search(sceneIndex.load(sceneIndexPath), 'football green field')[0].key, '2', 'scene retrieval ranks matching visual captions');
const musicTest = TL.empty(); musicTest.music = { src: 'music.mp3', volume: 0.25, duck: false };
TL.applyOps(musicTest, [{ op: 'set_music', volume: 0.4, duck: true }]);
assert.strictEqual(musicTest.music.volume, 0.4, 'AI music volume operation');
assert.strictEqual(musicTest.music.duck, true, 'AI music ducking operation');
// v1.0 editing operations: roll, slip, slide, rate stretch, overlay split and track reorder.
const editOps = TL.empty();
const ea = TL.addClip(editOps, { path: 'a.mp4', name: 'a.mp4', duration: 10 });
const eb = TL.addClip(editOps, { path: 'b.mp4', name: 'b.mp4', duration: 10 });
const ec = TL.addClip(editOps, { path: 'c.mp4', name: 'c.mp4', duration: 10 });
TL.setTrackState(editOps, 1, { locked: true });
ea.out = 4; eb.in = 1; eb.out = 5; ec.in = 2; ec.out = 6;
const beforeRoll = TL.duration(editOps); const roll = TL.rollEdit(editOps, eb.id, 0.5);
assert(!roll.ok && roll.reason === 'Track is locked', 'locked track blocks roll edit');
TL.setTrackState(editOps, 1, { locked: false });
const retryRoll = TL.rollEdit(editOps, eb.id, 0.5);
assert(retryRoll.ok && Math.abs(ea.out - 4.5) < 0.001 && Math.abs(eb.in - 1.5) < 0.001, 'roll edit adjusts adjacent source boundaries');
const beforeSlipLen = eb.out - eb.in; const slip = TL.slipEdit(editOps, eb.id, 0.25, 10);
assert(slip.ok && Math.abs((eb.out - eb.in) - beforeSlipLen) < 0.001, 'slip edit preserves clip duration');
const slide = TL.slideEdit(editOps, eb.id, 0.2);
assert(slide.ok && Math.abs(ec.in - 2.2) < 0.001, 'slide edit shifts neighbouring boundaries');
const stretched = TL.rateStretch(editOps, eb.id, 2);
assert(stretched.ok && Math.abs(TL.clipDur(eb) - 2) < 0.001, 'rate stretch changes timeline duration');
const editImg = { path: 'overlay.png', name: 'overlay.png', duration: 4, type: 'image' };
const el = TL.addLayer(editOps, editImg, 1); el.out = 4;
const splitLayer = TL.splitLayerAt(editOps, el.id, 2);
assert(splitLayer && Math.abs(el.out - 1) < 0.001 && Math.abs(splitLayer.in - 1) < 0.001, 'split overlay at timeline position');
TL.addVideoTrack(editOps); TL.setTrackState(editOps, 2, { locked: true, name: 'Locked B-roll' });
const blockedTrackOrder = TL.applyOps(editOps, [{ op: 'reorder_track', from: 2, to: 3 }]);
assert(blockedTrackOrder.some((entry) => entry.includes('locked')), 'locked track blocks AI reorder');
TL.setTrackState(editOps, 2, { locked: false, name: 'B-roll' });
assert(TL.reorderVideoTrack(editOps, 2, 3) && editOps.trackState['3'].name === 'B-roll', 'reorder tracks and preserve state');
TL.applyOps(editOps, [{ op: 'rate_stretch', clip_id: ec.id, duration: 3 }, { op: 'split_layer', layer_id: splitLayer.id, at: 3 }]);
assert(Math.abs(TL.clipDur(ec) - 3) < 0.001, 'AI editing operations are wired');

const animTest = TL.empty();
const animClip = TL.addClip(animTest, { path: 'clip.mp4', name: 'clip.mp4', duration: 5, type: 'video', hasAudio: true });
assert(animClip.transform && animClip.transform.rotation === 0, 'clip transform defaults');
TL.setTransform(animTest, animClip.id, { x: 0.2, rotation: 45, scaleX: 1.5, alpha: 0.7, shearY: 0.2 });
assert.strictEqual(animClip.transform.rotation, 45, 'static transform edit');
TL.setKeyframe(animClip, 'x', 0, 0, 'linear');
TL.setKeyframe(animClip, 'x', 2, 1, 'linear');
assert(Math.abs(TL.evaluateKeyframes(animClip, 'x', 1, 0) - 0.5) < 0.001, 'linear keyframe interpolation');
TL.setKeyframe(animClip, 'rotation', 0, 0, 'constant');
TL.setKeyframe(animClip, 'rotation', 2, 90, 'linear');
assert.strictEqual(TL.evaluateKeyframes(animClip, 'rotation', 1, 0), 0, 'constant keyframe interpolation');
TL.applyOps(animTest, [{ op: 'set_keyframe', item_id: animClip.id, property: 'alpha', time: 1, value: 0.5, interpolation: 'bezier' }]);
assert.strictEqual(animClip.keyframes.alpha[0].v, 0.5, 'AI keyframe operation');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-test-'));
  const src = path.join(dir, 'in.mp4');
  // 6s test clip: tone 0-2s, silence 2-4s, tone 4-6s
  await ff.run(['-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=6',
    '-f', 'lavfi', '-i', "aevalsrc='if(between(t,2,4),0,0.5*sin(440*2*PI*t))':d=6:s=44100",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const m = await ff.probe(src);
  assert(Math.abs(m.duration - 6) < 0.3 && m.hasAudio && m.hasVideo && m.width === 640, 'probe');
  const sil = await ff.detectSilence(src, { noiseDb: -40, minDur: 0.5 });
  assert(sil.length === 1 && Math.abs(sil[0][0] - 2) < 0.3 && Math.abs(sil[0][1] - 4) < 0.3, 'silence ' + JSON.stringify(sil));

  const tl = TL.empty();
  TL.addClip(tl, m);
  TL.removeSourceRanges(tl, src, sil.map(([a, b]) => [a + 0.1, b - 0.1]));
  assert(tl.video.length === 2, 'two pieces after silence cut');
  TL.splitAt(tl, 1);
  TL.addText(tl, 'Hello: Frosty', 0.2, 2);
  const logs = TL.applyOps(tl, [{ op: 'zoom', clip_id: tl.video[0].id, zoom: 1.5 }, { op: 'delete_range', start: 0.5, end: 0.9 }]);
  const expected = TL.duration(tl);
  const out = path.join(dir, 'out.mp4');
  await ff.exportTimeline(tl, out, { width: 640, height: 360 });
  const o = await ff.probe(out);
  assert(Math.abs(o.duration - expected) < 0.35, `export duration ${o.duration} vs ${expected}`);
  assert(o.hasAudio && o.hasVideo, 'export streams');

  const brag = path.join(dir, 'brag.mp4');
  await ff.renderBrag([{ title: 'Frosty', subtitle: 'Edit with AI', bg: '#101a2b' }, { title: 'Fast', bg: '#1b1030' }], brag, { width: 640, height: 360, sceneSec: 1.5 });
  assert(Math.abs((await ff.probe(brag)).duration - 3) < 0.3, 'brag duration');
  // v0.2: speed, fx, fades, transitions, scene detect, presets
  const t2 = TL.empty();
  TL.addClip(t2, m); TL.splitAt(t2, 3);
  TL.applyOps(t2, [{ op: 'set_speed', clip_id: t2.video[0].id, speed: 2 }, { op: 'set_fx', clip_id: t2.video[0].id, fx: { saturation: 0, blur: 2, vignette: true, brightness: 0.1 } },
    { op: 'fade', clip_id: t2.video[0].id, in: 0.2, out: 0.2 }, { op: 'add_transition', clip_id: t2.video[1].id, type: 'dissolve', dur: 0.5 }]);
  TL.setTransform(t2, t2.video[0].id, { x: 0.05, y: -0.03, scaleX: 1.05, scaleY: 0.95, rotation: 4, shearX: 0.02, shearY: -0.01 });
  TL.setKeyframe(t2.video[0], 'rotation', 0, 0, 'linear'); TL.setKeyframe(t2.video[0], 'rotation', 1.5, 8, 'bezier');
  TL.setKeyframe(t2.video[0], 'x', 0, -0.05, 'linear'); TL.setKeyframe(t2.video[0], 'x', 1.5, 0.05, 'linear');
  const exp2 = TL.duration(t2); // 1.5 + 3 - 0.5
  assert(Math.abs(exp2 - 4) < 0.01, 'layout with speed+transition ' + exp2);
  const out2 = path.join(dir, 'out2.mp4');
  await ff.exportTimeline(t2, out2, { ...ff.PRESETS['Web 720p'] });
  const o2 = await ff.probe(out2);
  assert(Math.abs(o2.duration - exp2) < 0.4 && o2.width === 1280, `fx export ${o2.duration} vs ${exp2}`);
  assert(Array.isArray(await ff.detectScenes(src, 0.3)), 'scenes');
  const t3 = TL.empty(); TL.addClip(t3, m); TL.splitSource(t3, src, [2, 4]); assert(t3.video.length === 3, 'splitSource');

  // v0.4: image clips, overlay layer (PiP + chroma + opacity), audio track, thumb/wave, frame pipe
  const png = path.join(dir, 'logo.png');
  await ff.run(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=200x100', '-frames:v', '1', png]);
  const im = await ff.probe(png); assert(im.type === 'image', 'image probe');
  const t4 = TL.empty(); TL.addClip(t4, m); TL.addClip(t4, im);
  const lay = TL.addLayer(t4, m, 1); lay.out = 3; lay.chroma = { color: '#00ff00', sim: 0.1 }; lay.opacity = 0.8;
  TL.addLayer(t4, im, 0.5); const track3 = TL.addVideoTrack(t4); const upperLayer = TL.addLayer(t4, im, 0.75, track3); upperLayer.scale = 0.2;
  assert.strictEqual(track3, 3, 'add independent video track'); assert.strictEqual(upperLayer.track, 3, 'overlay is assigned to requested track');
  assert.strictEqual(TL.summarize(t4).video_tracks, 3, 'AI timeline summary includes video track count');
  TL.setTrackState(t4, 3, { visible: false, muted: true, locked: true });
  assert.strictEqual(t4.trackState['3'].visible, false, 'track visibility state persists');
  assert.strictEqual(t4.trackState['3'].muted, true, 'track mute state persists');
  TL.applyOps(t4, [{ op: 'set_track', track: 2, muted: true, name: 'B-roll' }]); assert.strictEqual(t4.trackState['2'].name, 'B-roll', 'AI track operation updates track metadata');
  const trackDeleteTest = TL.clone(t4); const deletedTrack = TL.deleteVideoTrack(trackDeleteTest, 3);
  assert(deletedTrack.ok && deletedTrack.removed === 1 && trackDeleteTest.trackCount === 2, 'delete video track removes assigned overlays');
  const rippleTest = TL.empty(); TL.addClip(rippleTest, { path: 'a.mp4', name: 'a.mp4', duration: 8 }); const rippleLayer = TL.addLayer(rippleTest, im, 5); rippleLayer.out = 7; const rippleText = TL.addText(rippleTest, 'title', 5, 2);
  TL.rippleDeleteAll(rippleTest, 2, 4); assert(Math.abs(rippleTest.layers[0].start - 3) < 0.01 && Math.abs(rippleTest.text[0].start - 3) < 0.01, 'ripple delete shifts overlays and titles on other tracks');
  const rippleSpan = TL.empty(); TL.addClip(rippleSpan, { path: 'a.mp4', name: 'a.mp4', duration: 8 });
  const spanLayer = TL.addLayer(rippleSpan, im, 1); spanLayer.out = 6;
  const spanAudio = TL.addAudio(rippleSpan, m, 1); spanAudio.out = 6;
  TL.addText(rippleSpan, 'continuous title', 1, 5);
  TL.rippleDeleteAll(rippleSpan, 2, 4);
  assert(rippleSpan.layers.length === 2 && Math.abs(rippleSpan.layers[0].out - 1) < 0.01 && Math.abs(rippleSpan.layers[1].start - 2) < 0.01 && Math.abs(rippleSpan.layers[1].in - 3) < 0.01, 'ripple delete splits overlays spanning the removed interval and preserves source continuity');
  assert(rippleSpan.audio.length === 2 && Math.abs(rippleSpan.audio[1].start - 2) < 0.01 && Math.abs(rippleSpan.audio[1].in - 3) < 0.01, 'ripple delete splits audio clips spanning the removed interval');
  assert(rippleSpan.text.length === 2 && Math.abs(rippleSpan.text[1].start - 2) < 0.01 && Math.abs(rippleSpan.text[1].dur - 2) < 0.01, 'ripple delete splits titles spanning the removed interval');
  TL.addAudio(t4, m, 2).out = 2;
  const exp4 = TL.duration(t4); assert(Math.abs(exp4 - 11) < 0.01, 'image clip duration ' + exp4);
  const out4 = path.join(dir, 'out4.mp4'); await ff.exportTimeline(t4, out4, { width: 640, height: 360 });
  const o4 = await ff.probe(out4); assert(Math.abs(o4.duration - exp4) < 0.5 && o4.hasAudio, 'layers export ' + o4.duration);
  // v1.1: animated overlay transforms/opacity and audio volume automation are exported.
  const animLayer = TL.addLayer(t4, im, 0.25); animLayer.out = 2.5; animLayer.x = 0.2; animLayer.y = 0.3; animLayer.scale = 0.2; animLayer.opacity = 0.9;
  TL.setKeyframe(animLayer, 'x', 0, 0.2, 'linear'); TL.setKeyframe(animLayer, 'x', 1.5, 0.7, 'bezier');
  TL.setKeyframe(animLayer, 'scale', 0, 0.2, 'linear'); TL.setKeyframe(animLayer, 'scale', 1.5, 0.35, 'linear');
  TL.setKeyframe(animLayer, 'opacity', 0, 0.9, 'linear'); TL.setKeyframe(animLayer, 'opacity', 1.5, 0.5, 'linear');
  TL.setKeyframe(animLayer, 'rotation', 0, 0, 'linear'); TL.setKeyframe(animLayer, 'rotation', 1.5, 25, 'linear');
  const automatedAudio = TL.addAudio(t4, m, 0.5); automatedAudio.out = 2;
  TL.setKeyframe(automatedAudio, 'volume', 0, 0.2, 'linear'); TL.setKeyframe(automatedAudio, 'volume', 1.5, 1, 'linear');
  const autoOut = path.join(dir, 'automation.mp4'); await ff.exportTimeline(t4, autoOut, { width: 640, height: 360 });
  const autoProbe = await ff.probe(autoOut); assert(autoProbe.hasVideo && autoProbe.hasAudio, 'animated overlays and audio automation export');
  // v1.2 architecture: freely positioned overlapping main-track clips and composited export.
  const freeTl = TL.empty(); const freeA = TL.addClip(freeTl, m); freeA.out = 3;
  const freeB = TL.addClip(freeTl, m); freeB.in = 1; freeB.out = 4; freeB.transform.x = 0.08;
  assert(TL.setTimelineMode(freeTl, 'free'), 'enable free timeline mode');
  freeA.start = 0; freeB.start = 1.5;
  assert(Math.abs(TL.duration(freeTl) - 4.5) < 0.01, 'free timeline duration uses absolute starts');
  assert(TL.moveClipToTime(freeTl, freeB.id, 2), 'free clip can be positioned in timeline');
  const freeTrack3 = TL.addVideoTrack(freeTl); freeB.track = 2;
  const freeOverlay = TL.addLayer(freeTl, im, 1.25, freeTrack3); freeOverlay.out = 2.5; freeOverlay.scale = 0.18;
  const freeAudio = TL.addAudio(freeTl, m, 0.5); freeAudio.out = 2.5;
  assert(Math.abs(TL.layout(freeTl).find(x => x.clip.id === freeB.id).start - 2) < 0.01, 'free clip position persists');
  const freeOut = path.join(dir, 'free-timeline.mp4'); await ff.exportTimeline(freeTl, freeOut, { width: 640, height: 360, fps: 30 });
  const freeProbe = await ff.probe(freeOut); assert(freeProbe.hasVideo && freeProbe.hasAudio && Math.abs(freeProbe.duration - TL.duration(freeTl)) < 0.4, 'free timeline overlapping clip export');
  const freeDelete = TL.clone(freeTl); TL.rippleDeleteAll(freeDelete, 1, 1.5);
  assert(freeDelete.video.length >= 2 && Math.abs(TL.duration(freeDelete) - 4.5) < 0.1, 'free timeline ripple delete preserves and shifts clip pieces');
  assert(freeDelete.layers.length === 1 && freeDelete.audio.length === 2, 'free ripple delete splits overlay and audio clips crossing the edit');
  const deleteMainTrack = TL.clone(freeTl); const delMainTrackResult = TL.deleteVideoTrack(deleteMainTrack, 2); assert(delMainTrackResult.ok && !deleteMainTrack.video.some((c) => c.track === 2), 'deleting a video track removes main video clips assigned to it');
  const modeOps = TL.empty(); TL.addClip(modeOps, m); TL.applyOps(modeOps, [{ op: 'set_timeline_mode', mode: 'free' }, { op: 'move_clip_to_time', clip_id: modeOps.video[0].id, start: 2.5 }]);
  assert(modeOps.mode === 'free' && modeOps.video[0].start === 2.5, 'AI timeline mode and clip positioning operations');

  const th = await ff.thumb(src, path.join(dir, 't.jpg')); const wv = await ff.waveform(src, path.join(dir, 'w.png'));
  assert(fs.statSync(th).size > 500 && fs.statSync(wv).size > 500, 'thumb/wave');
  const jp = path.join(dir, 'f.jpg'); await ff.run(['-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=0.1', '-frames:v', '1', jp]);
  const pipe = ff.openFramePipe(path.join(dir, 'pipe.mp4'), { fps: 10 }); for (let i = 0; i < 20; i++) await pipe.write(fs.readFileSync(jp)); await pipe.end();
  assert(Math.abs((await ff.probe(path.join(dir, 'pipe.mp4'))).duration - 2) < 0.3, 'frame pipe');

  // OpenRouter agent loop against a mock server (tool calling end to end)
  const http = require('http'); const ai = require('../lib/ai'); let turn = 0;
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'x/vlm', name: 'VLM', context_length: 1e5, architecture: { input_modalities: ['text', 'image', 'video'], output_modalities: ['text'] }, supported_parameters: ['tools'], pricing: { prompt: '0.0000003' } }] }));
    const body = JSON.parse(b); turn++;
    const tc = (name, args) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c' + turn, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { cost: 0.001 } });
    const id = JSON.parse(body.messages[1].content.split('\n').pop()).clips[0].id;
    res.end(JSON.stringify(turn === 1 ? tc('get_timeline', {}) : turn === 2 ? tc('apply_ops', { ops: [{ op: 'add_text', text: 'Hi', start: 0, dur: 1 }, { op: 'set_speed', clip_id: id, speed: 2 }] }) : tc('finish', { summary: 'ok' })));
  }); });
  await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
  global.fetch = ((orig) => (u, o) => orig(String(u).replace('https://openrouter.ai/api/v1', `http://127.0.0.1:${port}`), o))(global.fetch);
  const models = await ai.listModels('k'); assert(models[0].video && models[0].tools, 'catalog flags');
  const tA = TL.empty(); TL.addClip(tA, m);
  const r = await ai.runAgent({ apiKey: 'k', model: 'x/vlm', fallbacks: ['y/z'], request: 'speed up', timeline: tA, ctx: { status() {} }, TL });
  assert(r.timeline.text.length === 1 && r.timeline.video[0].speed === 2 && r.summary === 'ok', 'agent applied ops');
  const agentLayer = TL.addLayer(tA, im, 0), agentAudio = TL.addAudio(tA, m, 0), agentText = TL.addText(tA, 'Original', 0, 2);
  TL.applyOps(tA, [
    { op: 'set_layer', layer_id: agentLayer.id, x: 0.4, y: 0.6, scale: 0.5, opacity: 0.7 },
    { op: 'set_audio', audio_id: agentAudio.id, start: 1, volume: 0.4 },
    { op: 'set_text', text_id: agentText.id, text: 'AI edited', size: 64, color: '#abcdef', pos: 'top' },
    { op: 'move_clip', clip_id: tA.video[0].id, direction: 1 },
  ]);
  assert(agentLayer.x === 0.4 && agentLayer.y === 0.6 && agentLayer.opacity === 0.7, 'agent overlay edits');
  assert(agentAudio.start === 1 && agentAudio.volume === 0.4, 'agent audio edits');
  assert(agentText.text === 'AI edited' && agentText.size === 64 && agentText.pos === 'top', 'agent text edits');
  srv.close();
  console.log('OK  transforms/keyframes + stacked video tracks/layers + v0.4 images/audio/pipe + fx/transition/agent; silence: ', JSON.stringify(sil), ' ops:', logs.join('; '), ' export:', o.duration.toFixed(2) + 's');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
