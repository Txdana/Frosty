'use strict';

// Frosty's own procedural motion-graphics system. It uses projected vector geometry
// and editable timeline keyframes; it does not embed source code from reference projects.
const clamp = (n, min, max) => Math.max(min, Math.min(max, Number(n) || 0));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[c]));
const PALETTES = {
  studio: { bg:'#0b1020', panel:'#111b30', ink:'#f5f8ff', muted:'#a9bad5', accent:'#7ce7d4', second:'#6aa9ff' },
  editorial: { bg:'#f3f0e9', panel:'#e8e2d5', ink:'#19211f', muted:'#5e6961', accent:'#d84d34', second:'#315b79' },
  signal: { bg:'#091d20', panel:'#0d2b2d', ink:'#eafffb', muted:'#7ebbb1', accent:'#f7cd4b', second:'#36d4b0' },
  cobalt: { bg:'#081c4b', panel:'#0d2c76', ink:'#ffffff', muted:'#c4d7ff', accent:'#57b4ff', second:'#a4f0ff' },
  peach: { bg:'#271522', panel:'#42263a', ink:'#fff6ef', muted:'#d7b6bc', accent:'#ffab8c', second:'#ffc9a9' },
  mono: { bg:'#090909', panel:'#161616', ink:'#ffffff', muted:'#b0b0b0', accent:'#ffffff', second:'#9b9b9b' }
};
const TYPES = ['title-card','lower-third','stat','feature','quote','kinetic-caption','wireframe-cube','wireframe-sphere','wireframe-cylinder','orbit','perspective-grid','network'];
const ANIMATIONS = ['none','fade-up','pop-in','slide-left','slide-right','drift-zoom','rotate-in','pulse'];

function projected(point, width, height, opts = {}) {
  const rx = Number(opts.rx ?? -0.42), ry = Number(opts.ry ?? 0.58), rz = Number(opts.rz ?? 0.24);
  let [x,y,z] = point;
  let y1 = y*Math.cos(rx)-z*Math.sin(rx), z1 = y*Math.sin(rx)+z*Math.cos(rx); y=y1; z=z1;
  let x1 = x*Math.cos(ry)+z*Math.sin(ry), z2 = -x*Math.sin(ry)+z*Math.cos(ry); x=x1; z=z2;
  let x2 = x*Math.cos(rz)-y*Math.sin(rz), y2 = x*Math.sin(rz)+y*Math.cos(rz); x=x2; y=y2;
  const camera = 4.8, factor = camera / Math.max(1.4, camera - z);
  return [width*0.74 + x*width*0.155*factor, height*0.5 + y*height*0.24*factor, z];
}
function pathLine(a,b, style='solid') { return `<line x1="${a[0].toFixed(2)}" y1="${a[1].toFixed(2)}" x2="${b[0].toFixed(2)}" y2="${b[1].toFixed(2)}" ${style==='hidden'?'stroke-dasharray="7 9" opacity="0.22"':''}/>`; }
function geometrySvg(type, w, h, palette, options) {
  const lines = [];
  const opts = options || {};
  const stroke = `stroke="${palette.accent}" stroke-width="${Math.max(1.5, w/850)}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  if (type === 'wireframe-cube') {
    const s=1.1, v=[[-s,-s,-s],[s,-s,-s],[s,s,-s],[-s,s,-s],[-s,-s,s],[s,-s,s],[s,s,s],[-s,s,s]].map(p=>projected(p,w,h,opts));
    const edges=[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    for(const [a,b] of edges) lines.push(pathLine(v[a],v[b],(a<4&&b<4)?'hidden':'solid'));
    for(const p of v) lines.push(`<circle cx="${p[0]}" cy="${p[1]}" r="${w/230}" fill="${palette.ink}"/>`);
  } else if (type === 'wireframe-sphere' || type === 'orbit') {
    // Sample a real 3D sphere and project each curve. Camera rotations are shared
    // with the cube/cylinder and therefore editable from both the human UI and AI.
    const polyline = (points) => points.slice(1).forEach((point, i) => {
      const prior = points[i];
      lines.push(pathLine(prior, point, (prior[2] + point[2]) < 0 ? 'hidden' : 'solid'));
    });
    const steps = 48;
    for (let i = 0; i < 12; i++) {
      const lon = i * Math.PI / 12;
      const points = [];
      for (let j = 0; j <= steps; j++) {
        const theta = Math.PI * j / steps;
        points.push(projected([Math.sin(theta) * Math.cos(lon), Math.cos(theta), Math.sin(theta) * Math.sin(lon)], w, h, opts));
      }
      polyline(points);
    }
    for (let i = 1; i < 8; i++) {
      const theta = Math.PI * i / 8, points = [];
      for (let j = 0; j <= steps; j++) {
        const lon = 2 * Math.PI * j / steps;
        points.push(projected([Math.sin(theta) * Math.cos(lon), Math.cos(theta), Math.sin(theta) * Math.sin(lon)], w, h, opts));
      }
      polyline(points);
    }
    if (type === 'orbit') for (let i = 0; i < 5; i++) {
      const angle = i * 1.25;
      const point = projected([1.42 * Math.cos(angle), 0.24 * Math.sin(angle * 2), 1.42 * Math.sin(angle)], w, h, opts);
      lines.push(`<circle cx="${point[0].toFixed(2)}" cy="${point[1].toFixed(2)}" r="${w/125}" fill="${i%2?palette.second:palette.accent}" stroke="none"/>`);
    }
  } else if (type === 'wireframe-cylinder') {
    const steps = 48;
    const polyline = (points) => points.slice(1).forEach((point, i) => {
      const prior = points[i];
      lines.push(pathLine(prior, point, (prior[2] + point[2]) < 0 ? 'hidden' : 'solid'));
    });
    for (const y of [-0.95, 0.95]) {
      const ring = [];
      for (let j = 0; j <= steps; j++) {
        const a = 2 * Math.PI * j / steps;
        ring.push(projected([0.82 * Math.cos(a), y, 0.82 * Math.sin(a)], w, h, opts));
      }
      polyline(ring);
    }
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8;
      const top = projected([0.82 * Math.cos(a), -0.95, 0.82 * Math.sin(a)], w, h, opts);
      const bottom = projected([0.82 * Math.cos(a), 0.95, 0.82 * Math.sin(a)], w, h, opts);
      lines.push(pathLine(top, bottom, Math.sin(a) < 0 ? 'hidden' : 'solid'));
    }
  } else if (type === 'perspective-grid') {
    const horizon=h*0.40, van=w*0.74, base=h*0.92;
    for(let x=-w*0.1;x<=w*1.1;x+=w*0.045) lines.push(`<line x1="${van}" y1="${horizon}" x2="${x}" y2="${base}" opacity="0.5"/>`);
    for(let i=1;i<=12;i++){const y=horizon+(base-horizon)*(i/12)**1.9;lines.push(`<line x1="${w*0.45}" y1="${y}" x2="${w}" y2="${y}" opacity="${0.12+i/60}"/>`);}
  } else if (type === 'network') {
    const pts=[];for(let i=0;i<22;i++){const x=w*(0.54+((i*37)%41)/100),y=h*(0.16+((i*53)%67)/100);pts.push([x,y]);}
    pts.forEach((p,i)=>pts.slice(i+1).forEach((q,j)=>{if((i*7+j*3)%5===0)lines.push(`<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" opacity="0.35"/>`);}));
    pts.forEach((p,i)=>lines.push(`<circle cx="${p[0]}" cy="${p[1]}" r="${i%4===0?w/250:w/500}" fill="${i%4===0?palette.ink:palette.accent}" stroke="none"/>`));
  }
  return `<g ${stroke}>${lines.join('')}</g>`;
}
function generateSvg(input = {}) {
  const o = { type:'title-card', theme:'studio', title:'Make it move.', subtitle:'Editable motion graphics', shape:'wireframe-cube', width:1920, height:1080, accent:'', ink:'', background:'', lineArt:true, ...input };
  if (!TYPES.includes(o.type)) throw new Error(`Unsupported motion graphic type: ${o.type}`);
  const width=Math.round(clamp(o.width,320,3840)), height=Math.round(clamp(o.height,240,3840));
  const p={...(PALETTES[o.theme]||PALETTES.studio)};
  if(/^#[0-9a-f]{6}$/i.test(o.accent))p.accent=o.accent;
  if(/^#[0-9a-f]{6}$/i.test(o.ink))p.ink=o.ink;
  if(/^#[0-9a-f]{6}$/i.test(o.background))p.bg=o.background;
  const title=esc(String(o.title||'').slice(0,180)), subtitle=esc(String(o.subtitle||'').slice(0,300));
  const big=Math.round(Math.min(width/12, height/5.6));
  const x=width*0.09, center=height*0.52;
  let art='';
  if (o.lineArt !== false) {
    // Motion Studio exposes degrees, while legacy callers may still provide rx/ry/rz radians.
    // Explicit legacy radians take precedence unless the corresponding degree field is supplied.
    const geometryOptions = { ...o };
    const rotations = [['rotationX', 'rx', -0.42], ['rotationY', 'ry', 0.58], ['rotationZ', 'rz', 0.24]];
    for (const [degreesKey, radiansKey, fallback] of rotations) {
      const hasDegrees = Object.prototype.hasOwnProperty.call(input, degreesKey) && input[degreesKey] !== '' && input[degreesKey] != null;
      const hasRadians = Object.prototype.hasOwnProperty.call(input, radiansKey) && input[radiansKey] !== '' && input[radiansKey] != null;
      if (hasDegrees && Number.isFinite(Number(input[degreesKey]))) geometryOptions[radiansKey] = Number(input[degreesKey]) * Math.PI / 180;
      else if (hasRadians && Number.isFinite(Number(input[radiansKey]))) geometryOptions[radiansKey] = Number(input[radiansKey]);
      else geometryOptions[radiansKey] = fallback;
    }
    art=geometrySvg((o.shape && TYPES.includes(o.shape))?o.shape:'wireframe-cube',width,height,p,geometryOptions);
  }
  const commonText=`font-family="Inter,Segoe UI,Arial,sans-serif" fill="${p.ink}"`;
  let visual='';
  if(o.type==='title-card') visual=`<text x="${x}" y="${center-30}" ${commonText} font-size="${big}" font-weight="800" letter-spacing="-2">${title}</text><text x="${x+4}" y="${center+Math.min(height*0.09,90)}" fill="${p.muted}" font-size="${Math.round(big*0.28)}" font-weight="500">${subtitle}</text>`;
  else if(o.type==='lower-third') visual=`<rect x="${width*0.055}" y="${height*0.70}" width="${width*0.60}" height="${height*0.19}" rx="${height*0.025}" fill="${p.panel}" opacity="0.96"/><rect x="${width*0.055}" y="${height*0.70}" width="${width*0.012}" height="${height*0.19}" fill="${p.accent}"/><text x="${width*0.085}" y="${height*0.78}" ${commonText} font-size="${Math.round(big*0.39)}" font-weight="800">${title}</text><text x="${width*0.085}" y="${height*0.84}" fill="${p.muted}" font-size="${Math.round(big*0.21)}">${subtitle}</text>`;
  else if(o.type==='stat') visual=`<text x="${x}" y="${center-15}" fill="${p.accent}" font-size="${Math.round(big*1.5)}" font-weight="900">${title}</text><text x="${x+4}" y="${center+Math.round(big*0.55)}" ${commonText} font-size="${Math.round(big*0.32)}">${subtitle}</text>`;
  else if(o.type==='feature') visual=`<rect x="${x}" y="${height*0.24}" width="${width*0.42}" height="${height*0.46}" rx="${height*0.035}" fill="${p.panel}" stroke="${p.accent}" stroke-opacity="0.7"/><circle cx="${x+width*0.075}" cy="${height*0.34}" r="${height*0.035}" fill="${p.accent}"/><text x="${x+width*0.045}" y="${height*0.48}" ${commonText} font-size="${Math.round(big*0.52)}" font-weight="800">${title}</text><text x="${x+width*0.045}" y="${height*0.57}" fill="${p.muted}" font-size="${Math.round(big*0.24)}">${subtitle}</text>`;
  else if(o.type==='quote') visual=`<text x="${x}" y="${height*0.31}" fill="${p.accent}" font-size="${Math.round(big*1.55)}" font-weight="900">“</text><text x="${x}" y="${center}" ${commonText} font-size="${Math.round(big*0.55)}" font-weight="700">${title}</text><text x="${x+4}" y="${center+Math.round(big*0.55)}" fill="${p.muted}" font-size="${Math.round(big*0.25)}">${subtitle}</text>`;
  else if(o.type==='kinetic-caption') visual=`<rect x="${width*0.07}" y="${height*0.70}" width="${width*0.86}" height="${height*0.17}" rx="${height*0.025}" fill="${p.bg}" opacity="0.88"/><text x="${width/2}" y="${height*0.81}" text-anchor="middle" ${commonText} font-size="${Math.round(big*0.48)}" font-weight="900">${title}</text>`;
  else visual=`<text x="${x}" y="${height*0.88}" ${commonText} font-size="${Math.round(big*0.23)}" font-weight="700">${title}</text><text x="${x+4}" y="${height*0.93}" fill="${p.muted}" font-size="${Math.round(big*0.15)}">${subtitle}</text>`;
  const bg=o.transparent===false?`<rect width="100%" height="100%" fill="${p.bg}"/>`:'';
  const motif=o.type==='title-card'||o.type==='feature'||o.type==='quote'?`<path d="M ${x} ${height*0.12} H ${x+width*0.12}" stroke="${p.accent}" stroke-width="${height*0.008}" stroke-linecap="round"/>`:'';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${title}</title>${bg}<defs><linearGradient id="accentGlow" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p.accent}" stop-opacity="0.45"/><stop offset="1" stop-color="${p.second}" stop-opacity="0.03"/></linearGradient></defs><ellipse cx="${width*0.78}" cy="${height*0.47}" rx="${width*0.19}" ry="${height*0.31}" fill="url(#accentGlow)" opacity="0.32"/>${art}${motif}${visual}</svg>`;
}

function animationKeyframes(preset, duration, layer = {}) {
  const d=clamp(duration,0.2,120), end=Math.max(0.15,d), x=Number(layer.x ?? 0.5), y=Number(layer.y ?? 0.5), scale=Number(layer.scale ?? 0.72), opacity=Number(layer.opacity ?? 1);
  const k = (a,b,c='bezier') => [{t:0,v:a,interpolation:c},{t:Math.min(0.55,end*0.22),v:b,interpolation:c}];
  const keyframes={};
  if(preset==='none') return keyframes;
  if(preset==='fade-up'){keyframes.opacity=[{t:0,v:0,interpolation:'bezier'},{t:Math.min(0.65,end*0.18),v:opacity,interpolation:'bezier'}];keyframes.y=[{t:0,v:clamp(y+0.09,0,1),interpolation:'bezier'},{t:Math.min(0.65,end*0.18),v:y,interpolation:'bezier'}];}
  else if(preset==='pop-in'){keyframes.opacity=[{t:0,v:0,interpolation:'bezier'},{t:Math.min(0.4,end*0.15),v:opacity,interpolation:'bezier'}];keyframes.scale=k(Math.max(0.03,scale*0.72),scale);}
  else if(preset==='slide-left'){keyframes.x=k(clamp(x+0.15,0,1),x);keyframes.opacity=[{t:0,v:0,interpolation:'linear'},{t:Math.min(0.45,end*0.14),v:opacity,interpolation:'bezier'}];}
  else if(preset==='slide-right'){keyframes.x=k(clamp(x-0.15,0,1),x);keyframes.opacity=[{t:0,v:0,interpolation:'linear'},{t:Math.min(0.45,end*0.14),v:opacity,interpolation:'bezier'}];}
  else if(preset==='drift-zoom'){keyframes.scale=[{t:0,v:scale*0.9,interpolation:'bezier'},{t:end,v:scale*1.02,interpolation:'linear'}];keyframes.y=[{t:0,v:clamp(y+0.025,0,1),interpolation:'bezier'},{t:end,v:clamp(y-0.025,0,1),interpolation:'linear'}];}
  else if(preset==='rotate-in'){keyframes.rotation=[{t:0,v:-7,interpolation:'bezier'},{t:Math.min(0.6,end*0.2),v:0,interpolation:'bezier'}];keyframes.opacity=[{t:0,v:0,interpolation:'linear'},{t:Math.min(0.5,end*0.16),v:opacity,interpolation:'bezier'}];}
  else if(preset==='pulse'){keyframes.scale=[{t:0,v:scale,interpolation:'linear'},{t:end*0.48,v:scale*1.04,interpolation:'bezier'},{t:end,v:scale,interpolation:'bezier'}];}
  else if(preset==='fade'){keyframes.opacity=[{t:0,v:0,interpolation:'bezier'},{t:Math.min(0.55,end*0.18),v:opacity,interpolation:'bezier'}];}
  return keyframes;
}
function applyAnimation(layer, preset, duration) {
  if (!layer || typeof layer !== 'object') throw new Error('A timeline layer is required.');
  if (!ANIMATIONS.includes(preset)) throw new Error(`Unsupported animation preset: ${preset}`);
  layer.keyframes = { ...(layer.keyframes || {}), ...animationKeyframes(preset, duration, layer) };
  layer.animationPreset = preset;
  return layer;
}
const api = { PALETTES, TYPES, ANIMATIONS, projected, geometrySvg, generateSvg, animationKeyframes, applyAnimation };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.FrostyMotionDesign = api;
