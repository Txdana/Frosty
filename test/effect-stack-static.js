'use strict';
const fs = require('fs');
const assert = require('assert');
const ffmpeg = fs.readFileSync(require.resolve('../lib/ffmpeg.js'), 'utf8');
const ui = fs.readFileSync(require.resolve('../renderer/app.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8');
for (const token of ['function effectStackChain', 'function maskChain', 'masterFxChain', 'brightness', 'grayscale', 'hue', 'trackState?.effects', 'timeExpr =', 'geqExpr']) {
  assert(ffmpeg.includes(token), `FFmpeg effect stack support includes ${token}`);
}
for (const token of ['Effect stack', '+ Add effect', 'Clip mask', 'Invert mask', 'Keyframe ${title} at playhead', 'Keyframe mask ${labelText}', 'function renderGlobalEffects', 'Overlay mask']) {
  assert(ui.includes(token), `Inspector exposes ${token}`);
}
assert(html.includes('Track & master effects') && html.includes('id="globalEffects"'), 'Persistent global effect-stack editor exists');
console.log('Effect stack static checks passed');
