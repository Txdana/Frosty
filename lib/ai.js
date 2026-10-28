// Frosty AI layer: OpenRouter planner + optional local Whisper transcription.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const MotionDesign = require('./motion-design');

const OR = 'https://openrouter.ai/api/v1';
const hdr = (apiKey) => ({
  Authorization: 'Bearer ' + apiKey,
  'Content-Type': 'application/json',
  'X-Title': 'Frosty',
  'HTTP-Referer': 'https://frosty.app'
});

// Full chat call: fallbacks (OpenRouter `models` routing), provider sort, tools, usage accounting.
async function chatRaw({ apiKey, model, fallbacks = [], messages, json = false, tools, sort, maxTokens, temperature = 0.3 }) {
  if (!apiKey) throw new Error('Add your OpenRouter API key in Settings first.');
  const body = { model, messages, temperature, usage: { include: true } };
  if (fallbacks.length) body.models = [model, ...fallbacks];
  if (sort) body.provider = { sort, allow_fallbacks: true };
  if (maxTokens) body.max_tokens = maxTokens;
  if (json) body.response_format = { type: 'json_object' };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  const res = await fetch(`${OR}/chat/completions`, { method: 'POST', headers: hdr(apiKey), body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || `OpenRouter error ${res.status}`);
  return { message: data.choices[0].message, usage: data.usage || {}, model: data.model };
}
async function chat(o) { return (await chatRaw({ ...o, json: o.json !== false })).message.content; }

// Live model catalogue with capability flags, so the UI can offer vision/video/tool-capable models.
async function listModels(apiKey) {
  const res = await fetch(`${OR}/models`, { headers: apiKey ? hdr(apiKey) : {} });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `OpenRouter error ${res.status}`);
  return data.data.map((m) => ({ id: m.id, name: m.name, ctx: m.context_length,
    vision: (m.architecture?.input_modalities || []).includes('image'),
    video: (m.architecture?.input_modalities || []).includes('video'),
    audio: (m.architecture?.input_modalities || []).includes('audio'),
    imageOut: (m.architecture?.output_modalities || []).includes('image'),
    tools: (m.supported_parameters || []).includes('tools'),
    price: m.pricing ? +(+m.pricing.prompt * 1e6).toFixed(3) : null })).sort((x, y) => x.id.localeCompare(y.id));
}
async function keyInfo(apiKey) {
  const res = await fetch(`${OR}/key`, { headers: hdr(apiKey) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Invalid key');
  const d = data.data || {};
  return { label: d.label, usage: d.usage, limit: d.limit, remaining: d.limit_remaining, free: d.is_free_tier };
}
// Image-output models (e.g. Gemini image) -> save PNGs for backgrounds/B-roll stills.
async function generateImage({ apiKey, model, prompt, outFile }) {
  const { message } = await chatRaw({ apiKey, model, messages: [{ role: 'user', content: prompt }], temperature: 0.8 });
  const url = message.images?.[0]?.image_url?.url;
  if (!url) throw new Error('That model returned no image. Pick an image-output model.');
  fs.writeFileSync(outFile, Buffer.from(url.split(',')[1], 'base64'));
  return outFile;
}

function parseJson(text) {
  const clean = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
  return JSON.parse(clean.slice(start, end + 1));
}

const PLANNER_SYSTEM = `You are Frosty's video edit planner. You never touch video; you output edit operations
that Frosty applies to a timeline. Times are TIMELINE seconds. Reply with JSON only:
{"summary": "one sentence", "ops": [ ... ]}
Allowed ops:
 {"op":"delete_range","start":N,"end":N}          ripple-delete a span
 {"op":"keep_ranges","ranges":[[a,b],...]}        keep only these spans (highlight reels)
 {"op":"split","at":N}
 {"op":"add_text","text":"...","start":N,"dur":N,"pos":"top|center|bottom"}
 {"op":"zoom","clip_id":"...","zoom":1.0-3.0}     punch-in on a clip
Rules: use only times inside the timeline duration; prefer few, meaningful edits; do deletes
from the END of the timeline backward so earlier times stay valid, and do all deletes before add_text/zoom.
If the transcript is provided, cut on sentence boundaries.`;

async function planEdit({ apiKey, model, request, timeline, transcript, silences, frames }) {
  const content = [{ type: 'text', text:
    `Request: ${request}\n\nTimeline:\n${JSON.stringify(timeline)}\n\n` +
    `Transcript segments (timeline-independent source time, per file):\n${JSON.stringify(transcript || []).slice(0, 12000)}\n\n` +
    `Silences (source time):\n${JSON.stringify(silences || []).slice(0, 3000)}` }];
  for (const f of frames || []) {
    const b64 = fs.readFileSync(f).toString('base64');
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
  }
  const out = await chat({ apiKey, model, messages: [{ role: 'system', content: PLANNER_SYSTEM }, { role: 'user', content }] });
  return parseJson(out);
}

async function planBrag({ apiKey, model, name, tagline, features }) {
  const prompt = `Write a 5-7 scene launch video script for "${name}". Tagline: ${tagline || 'n/a'}. Features:\n${features}\n` +
    `Reply JSON only: {"scenes":[{"template":"hook|feature|stat|code|cta","title":"<=5 words (for code: 1-3 short lines)","subtitle":"<=10 words","bg":"#hex dark colour","accent":"#hex bright colour"}]}. ` +
    `Scene 1 is a hook, the last is a call to action with the name.`;
  const out = await chat({ apiKey, model, messages: [{ role: 'user', content: prompt }] });
  return parseJson(out).scenes;
}

function simpleBrag({ name, tagline, features }) {
  const palette = ['#101a2b', '#1b1030', '#0e2a2a', '#2a1410', '#14202a', '#1f1f35'];
  const feats = (features || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 4);
  const scenes = [{ template: 'hook', title: name, subtitle: tagline || '', bg: palette[0], accent: '#6cc7ff' }];
  feats.forEach((t, i) => scenes.push({ template: 'feature', title: t.slice(0, 40), subtitle: '', bg: palette[(i + 1) % palette.length], accent: '#8be9a8' }));
  scenes.push({ template: 'cta', title: `Try ${name}`, subtitle: 'Available now', bg: palette[5], accent: '#ffb86c' });
  return scenes;
}

const PYTHONS = process.platform === 'win32' ? [['python'], ['py', '-3'], ['python3']] : [['python3'], ['python']];
// Local transcription via faster-whisper (python). Returns [{start,end,text}]
function transcribe(wavPath, model = 'base') {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, '..', 'scripts', 'transcribe.py').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    const cands = PYTHONS.slice();
    const tryNext = () => {
    const c = cands.shift();
    const p = spawn(c[0], [...c.slice(1), script, wavPath, model], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => (cands.length ? tryNext() : reject(new Error('Python not found. Install Python and run: pip install faster-whisper'))));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(/No module named/.test(err) ? 'Run: pip install faster-whisper' : err.slice(-400)));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('Bad transcript output')); }
    });
    };
    tryNext();
  });
}


// ---------- Tool-calling agent (planner/executor): the model inspects, edits, re-inspects ----------
const OPS_SCHEMA = { type: 'object', properties: { ops: { type: 'array', items: { type: 'object', additionalProperties: true,
  properties: { op: { type: 'string', enum: ['delete_range', 'keep_ranges', 'split', 'add_text', 'zoom', 'set_speed', 'set_volume', 'set_fx', 'add_transition', 'fade', 'set_layer', 'set_audio', 'set_music', 'set_text', 'set_transform', 'set_keyframe', 'set_track', 'delete_track', 'delete_item', 'move_clip', 'roll_edit', 'slip_edit', 'slide_edit', 'rate_stretch', 'split_layer', 'reorder_track', 'set_timeline_mode', 'move_clip_to_time', 'set_clip_track'] } }, required: ['op'] } } }, required: ['ops'] };
const fn = (name, description, parameters = { type: 'object', properties: {} }) => ({ type: 'function', function: { name, description, parameters } });
const TOOLS = [
  fn('get_timeline', 'Inspect the complete editable timeline: clips, overlays, audio, text, tracks, timing, effects, transitions, transforms and keyframes.'),
  fn('get_reference_analysis', 'Read the measured reference-video analysis created by Copy-to-template: shot boundaries, per-shot duration/pacing, transcript-caption timing, low-resolution motion estimates, and confidence/limitations. Call this before attempting to match the reference.', { type: 'object', properties: {} }),
  fn('create_motion_graphic', 'Create and add a transparent vector-based motion-graphic asset using the same native Frosty Motion Studio available to the human editor. The resulting SVG and PNG are saved in the project data directory; the PNG is inserted as an editable timeline overlay with animation keyframes. Use for title cards, lower thirds, stats, feature callouts, quotes, kinetic captions, wireframe 3D primitives, orbit, perspective grids and network line art. Supports themes studio/editorial/signal/cobalt/peach/mono, animations none/fade-up/pop-in/slide-left/slide-right/drift-zoom/rotate-in/pulse, and 3D camera orientation rotationX/rotationY/rotationZ in degrees (each -180..180). Arguments: type, theme, title, subtitle, shape, rotationX, rotationY, rotationZ, animation, start, duration, scale, track.', { type: 'object', properties: { type: { type: 'string', enum: MotionDesign.TYPES }, theme: { type: 'string', enum: Object.keys(MotionDesign.PALETTES) }, title: { type: 'string' }, subtitle: { type: 'string' }, shape: { type: 'string', enum: MotionDesign.TYPES }, rotationX: { type: 'number', minimum: -180, maximum: 180 }, rotationY: { type: 'number', minimum: -180, maximum: 180 }, rotationZ: { type: 'number', minimum: -180, maximum: 180 }, animation: { type: 'string', enum: MotionDesign.ANIMATIONS }, start: { type: 'number' }, duration: { type: 'number' }, scale: { type: 'number' }, track: { type: 'number' } }, required: ['type','title'] }),
  fn('get_assets', 'Inspect all imported media-bin assets, including names, paths, media type, duration, dimensions and audio/video capabilities. Use this before choosing assets or when the user asks to manipulate particular media.', { type: 'object', properties: {} }),
  fn('view_assets', 'Visually inspect available media-bin assets. Returns representative images for imported stills and sample frames for video assets so you can select and place them intentionally.', { type: 'object', properties: { limit: { type: 'number' } } }),
  fn('inspect_asset', 'Probe a specific imported asset by its exact path to learn duration, dimensions, streams and type before using it.', { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
  fn('detect_silence', 'Silent ranges in TIMELINE seconds.'),
  fn('get_transcript', 'Transcript segments in TIMELINE seconds (local Whisper).'),
  fn('view_frames', 'Look at sampled frames from the timeline clips.', { type: 'object', properties: { per_clip: { type: 'number' } } }),
  fn('watch_video', 'Send a low-res copy of the first clip to you as video (only if you accept video input).'),
  fn('apply_ops', 'Apply edit operations. Ops: delete_range{start,end}; keep_ranges{ranges}; split{at}; add_text{text,start,dur,pos}; zoom{clip_id,zoom}; set_speed{clip_id,speed}; set_volume{clip_id,volume}; set_fx{clip_id,fx:{brightness,contrast,saturation,gamma,blur,sharpen,grayscale,sepia,invert,vignette,flipH,flipV}}; add_transition{clip_id,type:fade|dissolve|wipeleft|wiperight|slideleft|slideright|circleopen|pixelize|fadeblack|radial|none,dur}; fade{clip_id,in,out}; set_layer{layer_id,track,start,in,out,x,y,scale,opacity,volume,chroma}; set_track{track,visible,muted,locked,name}; delete_track{track}; set_audio{audio_id,start,in,out,volume}; set_music{volume,duck}; set_text{text_id,text,start,dur,size,color,pos}; set_transform{clip_id,transform:{x,y,scaleX,scaleY,rotation,alpha,shearX,shearY}}; set_keyframe{item_id,property,time,value,interpolation:linear|bezier|constant}; delete_item{clip_id|layer_id|audio_id|text_id}; move_clip{clip_id,direction:-1|1}; roll_edit{clip_id,delta}; slip_edit{clip_id,delta,source_duration?}; slide_edit{clip_id,delta}; rate_stretch{clip_id,duration}; split_layer{layer_id,at}; reorder_track{from,to}; set_timeline_mode{mode:free|sequential}; move_clip_to_time{clip_id,start} (requires free mode); set_clip_track{clip_id,track} (requires free mode). Times are timeline seconds; do deletes from the end backwards.', OPS_SCHEMA),
  fn('web_search', 'Search the web. Returns title/url/snippet.', { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }),
  fn('web_read', 'Read a web page (or YouTube page text) as text.', { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }),
  fn('download_media', 'Download a video from a URL (YouTube, X, Reddit, Bilibili, TikTok…) into the media bin and append it to the timeline.', { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }),
  fn('generate_image', 'Generate an image asset from a prompt and add it to the timeline as a still clip. Requires an image-output model and may incur provider charges.', { type: 'object', properties: { prompt: { type: 'string' }, add_to_timeline: { type: 'boolean' } }, required: ['prompt'] }),
  fn('search_scenes', 'Search the indexed media library for scenes by visible content or dialogue. Index media first. Returns scene_key, source file, timestamps and caption/transcript.', { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] }),
  fn('add_scene', 'Add an exact result from search_scenes to the timeline. Only use a scene_key returned by search_scenes.', { type: 'object', properties: { scene_key: { type: 'string' } }, required: ['scene_key'] }),
  fn('finish', 'Call when done, with a one-sentence summary.', { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }),
];
const AGENT_SYSTEM = 'You are Frosty\'s autonomous video editor with access to the full exposed editing toolset. Inspect the timeline AND media-bin assets before editing; use view_frames for visual understanding, transcript/silence tools for audio, and inspect_asset/get_assets to choose assets deliberately. Use apply_ops to manipulate every supported property: clips, layers, tracks, text, audio, transitions, effects, transforms, keyframes, timing, ordering, and timeline mode. Preserve user media unless asked to remove it, ground edits in actual IDs and paths, verify after changes, and never claim unsupported features were changed. Search indexed media with search_scenes and add exact returned results with add_scene. ' +
  "You may also use generate_image to create a still asset when requested; do not generate images unless it serves the user's request. Work in small verified steps: look first (get_timeline, silence/transcript/frames as needed), edit, re-check get_timeline, then call finish. Prefer few, meaningful edits.";

// ctx: { silences(), transcript(), frames(n)->[dataUrl], video()->dataUrl|null, status(msg) }
async function runAgent({ apiKey, model, fallbacks, sort, request, timeline, history = [], ctx, TL, maxSteps = 8, permissions = {} }) {
  const safety = require('./agent-safety');
  const allowed = safety.normalizePermissions(permissions);
  const before = safety.snapshot(timeline);
  const tl = TL.clone(timeline), log = [], media = [];
  let usage = 0, summary = '';
  const messages = [{ role: 'system', content: AGENT_SYSTEM }, ...history, { role: 'user', content: `Request: ${request}\n\nInitial timeline:\n${JSON.stringify(TL.summarize(tl))}` }];
  try {
    for (let step = 0; step < maxSteps; step++) {
      ctx.status(`Agent step ${step + 1}…`);
      const { message, usage: u } = await chatRaw({ apiKey, model, fallbacks, sort, messages, tools: TOOLS });
      usage += u.cost || 0;
      messages.push({ role: 'assistant', content: message.content || '', tool_calls: message.tool_calls });
      if (!message.tool_calls?.length) { summary = message.content || 'Done.'; break; }
      const extra = []; let done = false;
      for (const call of message.tool_calls) {
        let args = {}; try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
        let result;
        try {
          if (!safety.permissionForTool(call.function.name, allowed)) {
            const required = ({ web_search: 'web', web_read: 'web', download_media: 'downloads', generate_image: 'imageGeneration' })[call.function.name];
            result = { blocked: true, error: `Permission denied: enable '${required}' in the AI Editor before using ${call.function.name}.` };
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
            continue;
          }
          switch (call.function.name) {
            case 'get_timeline': result = TL.summarize(tl); break;
            case 'get_reference_analysis': {
              const r = ctx.referenceAnalysis;
              result = r ? {
                schemaVersion: r.schemaVersion, source: r.source, pace: r.pace, transitions: r.transitions,
                cuts: { count: r.cuts?.count, threshold: r.cuts?.threshold, events: (r.cuts?.events || []).slice(0, 32), omittedEvents: Math.max(0, (r.cuts?.events || []).length - 32) },
                motion: r.motion,
                audio: r.audio ? { status: r.audio.status, rhythmStatus: r.audio.rhythmStatus, estimatedBpm: r.audio.estimatedBpm, beatConfidence: r.audio.beatConfidence, dynamicsDb: r.audio.dynamicsDb, onsetCount: r.audio.onsetCount, onsets: (r.audio.onsets || []).slice(0, 32), beatTimes: (r.audio.beatTimes || []).slice(0, 64) } : null,
                visualAnalysis: r.visualAnalysis ? {
                  status: r.visualAnalysis.status, styleBible: r.visualAnalysis.styleBible,
                  frames: (r.visualAnalysis.frames || []).slice(0, 24).map((frame) => ({ id: frame.id, description: String(frame.description || '').slice(0, 220), visibleText: (frame.visibleText || []).slice(0, 3), textPosition: frame.textPosition, typography: frame.typography, overlayElements: (frame.overlayElements || []).slice(0, 4), palette: (frame.palette || []).slice(0, 4), animationEvidence: frame.animationEvidence, confidence: frame.confidence })),
                  shots: (r.visualAnalysis.shots || []).slice(0, 16), notes: r.visualAnalysis.notes
                } : null,
                animation: { analysisStatus: r.animation?.analysisStatus, styleBible: r.animation?.styleBible, note: r.animation?.note },
                captions: { transcriptStatus: r.captions?.transcriptStatus, segmentCount: r.captions?.segmentCount, transcript: (r.captions?.transcript || []).slice(0, 80) },
                shots: (r.shots || []).slice(0, 32).map(({ index,start,end,duration,transition,motion,animation,audioAlignment,visualAnalysis,captionText,transcript }) => ({ index,start,end,duration,transition,motion,animation,audioAlignment,visualAnalysis: { status: visualAnalysis?.status, visibleText: (visualAnalysis?.visibleText || []).slice(0, 3), evidence: (visualAnalysis?.evidence || []).slice(0, 3) },captionText: String(captionText || '').slice(0, 160),transcript: (transcript || []).slice(0, 4) })),
                blueprint: (r.blueprint || []).slice(0, 32).map((shot) => ({ shot: shot.shot, sourceIn: shot.sourceIn, sourceOut: shot.sourceOut, duration: shot.duration, pacing: shot.pacing, incomingTransition: shot.incomingTransition, camera: shot.camera, caption: { text: String(shot.caption?.text || '').slice(0, 100), segments: shot.caption?.segments }, animation: shot.animation, audioAlignment: shot.audioAlignment, reviewRequired: shot.reviewRequired })),
                visualSamples: (r.visualSamples || []).map(({ id,time,shot,phase,visualDescription }) => ({ id,time,shot,phase,visualDescription: String(visualDescription || '').slice(0, 260) })),
                omittedShots: Math.max(0, (r.shots || []).length - 32), limitations: r.limitations
              } : { available: false, note: 'No measured reference analysis is attached to this job.' };
              break;
            }
            case 'create_motion_graphic': { if (typeof ctx.createMotionGraphic !== 'function') { result = { error: 'Motion Studio asset creation is unavailable in this session.' }; break; } const asset = await ctx.createMotionGraphic(args); media.push(asset); const layer = TL.addLayer(tl, asset, Math.max(0, Number(args.start) || 0), args.track); layer.name = asset.name; layer.out = asset.duration; layer.x = 0.5; layer.y = 0.5; layer.scale = Math.max(0.25, Math.min(1.5, Number(args.scale) || 1)); layer.opacity = 1; layer.motionDesign = asset.motionDesign; layer.designPath = asset.designPath; MotionDesign.applyAnimation(layer, args.animation || 'fade-up', asset.duration); log.push(`Created Motion Studio ${args.type || 'title-card'} graphic “${asset.name}” at ${(Number(args.start) || 0).toFixed(2)}s with ${args.animation || 'fade-up'} animation.`); result = { added: asset.name, path: asset.path, designPath: asset.designPath, duration: asset.duration, layerId: layer.id, type: asset.motionDesign?.type, animation: layer.animationPreset, timeline: TL.summarize(tl) }; break; }
            case 'get_assets': result = { assets: (ctx.assets ? await ctx.assets() : []).map((m) => ({ name: m.name, path: m.path, type: m.type, duration: m.duration, width: m.width, height: m.height, hasVideo: m.hasVideo, hasAudio: m.hasAudio })) }; break;
            case 'view_assets': { const imgs = ctx.assetFrames ? await ctx.assetFrames(args.limit || 12) : []; if (imgs.length) extra.push({ role: 'user', content: [{ type: 'text', text: 'Visual samples from available media-bin assets, labelled in order:' }, ...imgs.map((x) => ({ type: 'image_url', image_url: { url: x.dataUrl } }))] }); result = { samples: imgs.map((x) => ({ name: x.name, path: x.path, type: x.type })), note: imgs.length ? 'Images attached in order above.' : 'No visual samples available.' }; break; }
            case 'inspect_asset': result = await ctx.probe(args.path); break;
            case 'detect_silence': result = await ctx.silences(tl); break;
            case 'get_transcript': result = await ctx.transcript(tl); break;
            case 'view_frames': { const rawFrames = await ctx.frames(tl, args.per_clip || 2); const fr = rawFrames.map((frame, index) => typeof frame === 'string' ? { url: frame, label: `Frame ${index + 1}` } : { url: frame.url, label: frame.label || `Frame ${index + 1}` }).filter((frame) => frame.url); const content = [{ type: 'text', text: 'Frames sampled from editable timeline clips. Labels identify clip, source time and whether the frame is near a cut; compare adjacent labelled frames to infer title animation, zoom, and transitions. These images are samples, not a full motion-analysis truth.' }]; for (const frame of fr) content.push({ type: 'text', text: frame.label }, { type: 'image_url', image_url: { url: frame.url } }); extra.push({ role: 'user', content }); result = { frames: fr.map(({ label }) => label), count: fr.length }; break; }
            case 'watch_video': { const v = await ctx.video(tl); if (!v) result = { error: 'unavailable' }; else { extra.push({ role: 'user', content: [{ type: 'text', text: 'Low-res video of the first clip:' }, { type: 'video_url', video_url: { url: v } }] }); result = { sent: true }; } break; }
            case 'apply_ops': { const l = TL.applyOps(tl, args.ops); log.push(...l); result = { applied: l, timeline: TL.summarize(tl) }; break; }
            case 'web_search': result = await ctx.search(args.query); break;
            case 'web_read': result = await ctx.read(args.url); break;
            case 'download_media': { const m = await ctx.download(args.url); media.push(m); TL.addClip(tl, m); log.push(`Downloaded ${m.name}`); result = { added: m.name, duration: m.duration }; break; }
            case 'generate_image': { const m = await ctx.generateImage(args.prompt); media.push(m); if (args.add_to_timeline !== false) { TL.addClip(tl, m); log.push(`Generated image ${m.name} and added it to the timeline`); } else log.push(`Generated image ${m.name} in the media bin`); result = { added: m.name, type: m.type }; break; }
            case 'search_scenes': result = await ctx.searchScenes(args.query, args.limit || 10); break;
            case 'add_scene': { const scene = await ctx.addScene(args.scene_key); if (!scene) { result = { error: 'Scene key was not returned by the scene index. Search scenes first.' }; break; } const m = await ctx.probe(scene.src); media.push(m); const c = TL.addClip(tl, m); c.in = scene.start; c.out = scene.end; log.push(`Added indexed scene ${scene.name} ${scene.start}s–${scene.end}s`); result = { added: scene.name, start: scene.start, end: scene.end, timeline: TL.summarize(tl) }; break; }
            case 'finish': summary = args.summary || 'Done.'; done = true; result = { ok: true }; break;
            default: result = { error: 'unknown tool' };
          }
        } catch (e) { result = { error: e.message }; }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 14000) });
      }
      messages.push(...extra);
      if (done) break;
    }
    const verification = safety.validateEdit(before, tl);
    return { timeline: tl, log, media, summary: summary || 'Stopped at step limit.', cost: usage, verification, permissions: allowed };
  } catch (e) {
    // Model without tool support (or provider error): fall back to single-shot JSON planning.
    if (!/tool|function|endpoint|support/i.test(e.message)) throw e;
    ctx.status('Model lacks tool use — using JSON planner…');
    const plan = await planEdit({ apiKey, model, request, timeline: TL.summarize(timeline), transcript: await ctx.transcript(timeline).catch(() => []), silences: await ctx.silences(timeline).catch(() => []), frames: [] });
    const l = TL.applyOps(tl, plan.ops);
    const verification = safety.validateEdit(before, tl);
    return { timeline: tl, log: l, summary: plan.summary || 'Done.', cost: 0, verification, permissions: allowed };
  }
}

module.exports = { PYTHONS, hdr, chatRaw, listModels, keyInfo, generateImage, runAgent, chat, planEdit, planBrag, simpleBrag, transcribe };
