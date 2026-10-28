'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ffmpeg = process.env.FROSTY_FFMPEG || (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-transform-'));
try {
  const output = path.join(workspace, 'transform.png');
  const filter = [
    'scale=320:180:force_original_aspect_ratio=decrease',
    'pad=320:180:(ow-iw)/2:(oh-ih)/2:color=black@0',
    'format=rgba',
    "scale=w='iw*1.1':h='ih*0.9':eval=frame",
    'shear=shx=0.1:shy=0.05:fillcolor=black@0',
    'rotate=a=5*PI/180:ow=rotw(iw):oh=roth(ih):c=black@0',
    "pad=w='max(iw,320)':h='max(ih,180)':x='(ow-iw)/2':y='(oh-ih)/2':color=black@0",
    "crop=320:180:x='max(0,min(iw-320,(iw-320)/2-0.1*320))':y='max(0,min(ih-180,(ih-180)/2-0.05*180))'",
    'format=rgba',
    'colorchannelmixer=aa=0.75',
  ].join(',');
  const result = spawnSync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=1:d=1',
    '-vf', filter, '-frames:v', '1', output,
  ], { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.error, undefined, `FFmpeg execution failed: ${result.error}`);
  assert.equal(result.status, 0, `FFmpeg transform graph failed: ${result.stderr || result.stdout}`);
  const png = fs.readFileSync(output);
  assert.ok(png.length > 100, 'transform pipeline must emit a non-empty PNG');
  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a', 'output must be a valid PNG');
  assert.equal(png.readUInt32BE(16), 320, 'export width must remain fixed after transforms');
  assert.equal(png.readUInt32BE(20), 180, 'export height must remain fixed after transforms');
  console.log('Native transform render passed: scale + shear + rotation + fixed-canvas crop + alpha/opacity.');

  // Exercise the expression primitives now used for animated transforms, spatial transitions,
  // alpha opacity and ASS text overlays (not merely source-code presence).
  const ass = path.join(workspace, 'overlay.ass');
  fs.writeFileSync(ass, [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 320', 'PlayResY: 180',
    '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,1,0,0,0,100,100,0,0,1,2,1,2,20,20,12,1',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\an2}Frosty native export',
  ].join('\n'), 'utf8');
  const advanced = path.join(workspace, 'advanced.png');
  const assPath = ass.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const advancedFilter = [
    'format=rgba',
    "scale=w='max(2,iw*max(0.05,min(8,if(lt(t,0.5),1,1.1))))':h='max(2,ih*max(0.05,min(8,if(lt(t,0.5),1,0.9))))':eval=frame",
    "perspective=x0=0:y0=0:x1=W:y1='0.05*W':x2='0.1*H':y2=H:x3='W+0.1*H':y3='H+0.05*W':eval=frame:sense=destination",
    "rotate=a='if(lt(t,0.5),0,0.05)':ow=rotw(iw):oh=roth(ih):c=black@0",
    "pad=640:720:(ow-iw)/2:(oh-ih)/2:color=black@0",
    "crop=320:180:x='max(0,min(iw-320,(iw-320)/2))':y='max(0,min(ih-180,(ih-180)/2))'",
    "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,W*max(0,min(1,(T-0.1)/0.7))),alpha(X,Y)*max(0,min(1,T/0.5)),0)'",
    `ass='${assPath}'`, 'format=rgba',
  ].join(',');
  const advancedResult = spawnSync(ffmpeg, ['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=320x180:r=10:d=1','-vf',advancedFilter,'-frames:v','1',advanced], { encoding:'utf8', timeout:30000, maxBuffer:2*1024*1024 });
  assert.equal(advancedResult.error, undefined, `advanced FFmpeg invocation failed: ${advancedResult.error}`);
  assert.equal(advancedResult.status, 0, `animated transform/transition/text graph failed: ${advancedResult.stderr || advancedResult.stdout}`);
  const advancedPng=fs.readFileSync(advanced);
  assert.equal(advancedPng.toString('hex',0,8),'89504e470d0a1a0a');
  assert.equal(advancedPng.readUInt32BE(16),320); assert.equal(advancedPng.readUInt32BE(20),180);

  const mixedAudio = path.join(workspace, 'preview-audio.wav');
  const audioResult = spawnSync(ffmpeg, ['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=0.5','-f','lavfi','-i','sine=frequency=660:duration=0.5','-filter_complex','[0:a]atrim=start=0:duration=0.5,asetpts=PTS-STARTPTS,adelay=0|0[a0];[1:a]atrim=start=0:duration=0.5,asetpts=PTS-STARTPTS,adelay=150|150[a1];[a0][a1]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.98[aout]','-map','[aout]','-c:a','pcm_s16le','-ar','48000','-ac','2',mixedAudio], { encoding:'utf8', timeout:30000, maxBuffer:2*1024*1024 });
  assert.equal(audioResult.error, undefined, `audio mix invocation failed: ${audioResult.error}`);
  assert.equal(audioResult.status, 0, `audio mix graph failed: ${audioResult.stderr || audioResult.stdout}`);
  assert.ok(fs.statSync(mixedAudio).size > 44, 'audio monitor must produce a non-empty PCM WAV');
  console.log('Native advanced graph passed: animated transform expressions, alpha wipe/opacity, ASS text overlay and mixed audio WAV.');
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
