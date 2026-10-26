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
  return `<section class="scene" data-i="${i}" style="--bg:${bg};--a:${a}">${body}</section>`;
}

function pageHtml(scenes, { width = 1280, height = 720, sceneSec = 3 } = {}) {
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}html,body{width:${width}px;height:${height}px;overflow:hidden;background:#000;font-family:'Segoe UI',Inter,Arial,sans-serif;color:#fff}
.scene{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:28px;text-align:center;padding:0 90px;
 background:radial-gradient(circle at 30% 20%,color-mix(in srgb,var(--a) 28%,var(--bg)),var(--bg) 70%);animation:sc ${sceneSec}s both}
@keyframes sc{0%{opacity:0}12%{opacity:1}88%{opacity:1}100%{opacity:0}}
h1{font-size:104px;font-weight:800;letter-spacing:-2px}h2{font-size:76px;font-weight:700}p{font-size:36px;color:#cfe3ff;opacity:.95}
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
module.exports = { pageHtml };
