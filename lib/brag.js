// Frosty launch-video scenes as HTML/CSS (brag/Hyperframes style). The page is frame-stepped
// deterministically: window.__seek(t) pauses every CSS animation and sets its clock, so an
// offscreen Electron window can capture exactly frame N and pipe it into FFmpeg.
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function sceneHtml(s, i) {
  const a = s.accent || '#6cc7ff', bg = s.bg || '#101a2b';
  const body = {
    hook: `<h1 class="pop grad">${esc(s.title)}</h1><p class="rise d1">${esc(s.subtitle)}</p>`,
    feature: `<div class="orb"></div><h2 class="slide">${esc(s.title)}</h2><p class="rise d1">${esc(s.subtitle)}</p>`,
    stat: `<div class="big pop">${esc(s.title)}</div><p class="rise d1">${esc(s.subtitle)}</p>`,
    code: `<pre class="term">${esc(s.title).split('\n').map((l, n) => `<span class="type" style="animation-delay:${0.2 + n * 0.5}s">${l}</span>`).join('\n')}</pre><p class="rise d2">${esc(s.subtitle)}</p>`,
    cta: `<h1 class="pop">${esc(s.title)}</h1><div class="btn pulse">${esc(s.subtitle || 'Get started')}</div>`,
  }[s.template] || `<h2 class="slide">${esc(s.title)}</h2><p class="rise d1">${esc(s.subtitle)}</p>`;
  const image = s.imageData ? `<img class="product-shot" src="${esc(s.imageData)}" alt="Product footage">` : '';
  return `<section class="scene" data-i="${i}" style="--bg:${bg};--a:${a}">${image}${body}</section>`;
}

function pageHtml(scenes, { width = 1280, height = 720, sceneSec = 3 } = {}) {
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}html,body{width:${width}px;height:${height}px;overflow:hidden;background:#000;font-family:'Segoe UI',Inter,Arial,sans-serif;color:#fff}
.scene{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:28px;text-align:center;padding:0 90px;
 background:radial-gradient(circle at 30% 20%,color-mix(in srgb,var(--a) 28%,var(--bg)),var(--bg) 70%);animation:sc ${sceneSec}s both}
@keyframes sc{0%{opacity:0}12%{opacity:1}88%{opacity:1}100%{opacity:0}}
.product-shot{position:absolute;right:64px;bottom:54px;max-width:30%;max-height:38%;object-fit:contain;border:1px solid #ffffff44;border-radius:22px;box-shadow:0 20px 80px #0008}h1{font-size:104px;font-weight:800;letter-spacing:-2px}h2{font-size:76px;font-weight:700}p{font-size:36px;color:#cfe3ff;opacity:.95}
.grad{background:linear-gradient(90deg,#fff,var(--a));-webkit-background-clip:text;color:transparent}
.big{font-size:190px;font-weight:900;color:var(--a)}
.pop{animation:pop .7s cubic-bezier(.2,1.4,.4,1) both}@keyframes pop{0%{transform:scale(.6);opacity:0}100%{transform:scale(1);opacity:1}}
.rise{animation:rise .6s ease-out both}.d1{animation-delay:.35s}.d2{animation-delay:.9s}@keyframes rise{0%{transform:translateY(30px);opacity:0}100%{transform:none;opacity:.95}}
.slide{animation:slide .6s ease-out both}@keyframes slide{0%{transform:translateX(-80px);opacity:0}100%{transform:none;opacity:1}}
.orb{width:120px;height:120px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff,var(--a));animation:pop .6s both,float 2.4s ease-in-out infinite .6s}
@keyframes float{50%{transform:translateY(-14px)}}
.term{font:34px Consolas,monospace;text-align:left;background:#0008;border:1px solid #fff3;border-radius:14px;padding:28px 36px;color:#9dffb0}
.type{display:block;overflow:hidden;white-space:pre;width:0;animation:typing .5s steps(24) forwards}@keyframes typing{to{width:26ch}}
.btn{font-size:40px;font-weight:700;padding:20px 54px;border-radius:60px;background:var(--a);color:#0b1220}
.pulse{animation:rise .6s .4s both,pl 1.2s ease-in-out infinite .9s}@keyframes pl{50%{transform:scale(1.07)}}
</style>${scenes.map(sceneHtml).join('')}<script>
const S=[...document.querySelectorAll('.scene')];
window.__seek=(t)=>{const i=Math.min(S.length-1,Math.floor(t/${sceneSec}));S.forEach((el,n)=>{el.style.display=n===i?'flex':'none';
 if(n===i)el.getAnimations({subtree:true}).forEach(a=>{a.pause();a.currentTime=(t-i*${sceneSec})*1000;});});};
window.__seek(0);</script>`;
}
function makeShareCopy({ name = 'My project', tagline = '', platform = 'general', url = '', features = [] } = {}) {
  const clean = (v) => String(v || '').replace(/[\r\n\t]+/g, ' ').trim();
  const title = clean(name) || 'My project';
  const line = clean(tagline);
  const bullets = (Array.isArray(features) ? features : String(features).split(/\r?\n/))
    .map(clean).filter(Boolean).slice(0, 8).map((x) => `• ${x}`);
  const link = clean(url);
  const platformText = {
    youtube: `${title} — ${line}\n\n${bullets.join('\n')}\n\n${link}`,
    instagram: `${title}\n${line}\n\n${bullets.join('\n')}\n\n${link}\n\n#ProductLaunch #MadeWithFrosty`,
    tiktok: `${title}: ${line}\n${bullets.slice(0, 3).join('\n')}\n${link}\n#ProductLaunch #MadeWithFrosty`,
    linkedin: `${title}${line ? ` — ${line}` : ''}\n\n${bullets.join('\n')}\n\n${link}`,
    x: `${title}${line ? ` — ${line}` : ''}${link ? ` ${link}` : ''}`,
    general: `${title}${line ? ` — ${line}` : ''}\n\n${bullets.join('\n')}\n\n${link}`,
  };
  return (platformText[platform] || platformText.general).replace(/\n{3,}/g, '\n\n').trim();
}

function validateStoryboard(scenes) {
  if (!Array.isArray(scenes) || !scenes.length) throw new Error('A storyboard needs at least one scene.');
  return scenes.map((scene, i) => ({
    template: ['hook', 'feature', 'stat', 'code', 'cta'].includes(scene.template) ? scene.template : 'feature',
    title: String(scene.title || `Scene ${i + 1}`).slice(0, 180),
    subtitle: String(scene.subtitle || '').slice(0, 360),
    bg: /^#[0-9a-f]{6}$/i.test(scene.bg || '') ? scene.bg : '#101a2b',
    accent: /^#[0-9a-f]{6}$/i.test(scene.accent || '') ? scene.accent : '#6cc7ff',
    imagePath: typeof scene.imagePath === 'string' ? scene.imagePath : '',
    imageData: typeof scene.imageData === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(scene.imageData) ? scene.imageData : '',
  }));
}

function normalizeRenderOptions(options = {}) {
  const dimensions = { '1280x720': [1280, 720], '1920x1080': [1920, 1080], '1080x1920': [1080, 1920], '1080x1080': [1080, 1080], '3840x2160': [3840, 2160] };
  const width = Math.max(320, Math.min(3840, Math.round(Number(options.width) || 1280)));
  const height = Math.max(320, Math.min(2160, Math.round(Number(options.height) || 720)));
  const fps = [24, 25, 30, 50, 60].includes(Number(options.fps)) ? Number(options.fps) : 30;
  const sceneSec = Math.max(1, Math.min(12, Number(options.sceneSec) || 3));
  return { width, height, fps, sceneSec };
}
function createDraft({ name = 'launch-storyboard', scenes = [], soundtrack = '', metadata = {} } = {}) {
  const safeScenes = validateStoryboard(scenes).map(({ imageData, ...scene }) => scene);
  return { format: 'frosty-brag', version: 1, savedAt: new Date().toISOString(), name: String(name || 'launch-storyboard').slice(0, 120), scenes: safeScenes, soundtrack: typeof soundtrack === 'string' ? soundtrack : '', metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {} };
}
function parseDraft(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !['frosty-brag', undefined].includes(parsed.format)) throw new Error('This file is not a supported Frosty Brag storyboard.');
  if (parsed.version != null && Number(parsed.version) > 1) throw new Error(`Storyboard version ${parsed.version} is newer than this Frosty version supports.`);
  return { name: String(parsed.name || 'Launch').slice(0, 120), scenes: validateStoryboard(parsed.scenes), soundtrack: typeof parsed.soundtrack === 'string' ? parsed.soundtrack : '', metadata: parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata) ? parsed.metadata : {} };
}

module.exports = { pageHtml, makeShareCopy, validateStoryboard, normalizeRenderOptions, createDraft, parseDraft };
