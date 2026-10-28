'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const TL = require('./timeline');
const ff = require('./ffmpeg');
async function materializeNestedSequences(timeline, sequences = {}, options = {}, deps = {}) {
  const fs = deps.fs || require('fs');
  const os = deps.os || require('os');
  const path = deps.path || require('path');
  const TL = deps.TL || require('./timeline');
  const ff = deps.ff || require('./ffmpeg');
  const useEnabledProxies = deps.useEnabledProxies || ((tl) => tl);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-sequences-'));
  const rendered = new Map();
  const stack = new Set();
  let serial = 0;
  async function resolve(tl, depth = 0) {
    if (depth > 16) throw new Error('Nested sequence depth exceeds the safe limit (16).');
    const copy = TL.ensure(TL.clone(options.useProxies ? useEnabledProxies(tl) : tl));
    for (let i = 0; i < (copy.video || []).length; i++) {
      const clip = copy.video[i];
      if (clip.type !== 'sequence' && !clip.sequenceId) continue;
      const id = clip.sequenceId;
      if (!id || !sequences[id]) throw new Error(`Nested sequence reference is missing: ${id || '(empty)'}`);
      if (stack.has(id)) throw new Error(`Nested sequence cycle detected at ${id}`);
      let renderedPath = rendered.get(id);
      if (!renderedPath) {
        stack.add(id);
        const child = await resolve(sequences[id], depth + 1);
        renderedPath = path.join(tempDir, `sequence-${++serial}.mp4`);
        const childOptions = {
          width: Number(options.width) || Number(child.settings?.width) || 1280,
          height: Number(options.height) || Number(child.settings?.height) || 720,
          fps: TL.frameRateString(child), crf: Number(options.crf) || 20,
          audioBitrate: options.audioBitrate || '192k',
        };
        // Keep every intermediate render alive until the root materialization is
        // cleaned up. A nested sequence may also be referenced by a sibling/root
        // clip; deleting child intermediates here leaves cached paths stale.
        await ff.exportTimeline(child, renderedPath, childOptions);
        stack.delete(id); rendered.set(id, renderedPath);
      }
      const probed = await ff.probe(renderedPath);
      const originalIn = Math.max(0, Number(clip.in) || 0);
      const originalOut = Number(clip.out) > originalIn ? Number(clip.out) : Number(probed.duration);
      clip.src = renderedPath; clip.type = 'video'; delete clip.sequenceId;
      clip.in = Math.min(originalIn, Math.max(0, Number(probed.duration) - 0.05));
      clip.out = Math.max(clip.in + 0.05, Math.min(Number(probed.duration) || originalOut, originalOut));
      clip.hasAudio = !!probed.hasAudio; clip.name = clip.name || sequences[id].name || 'Nested sequence';
    }
    return copy;
  }
  try {
    const resolved = await resolve(timeline);
    resolved.__materializedFiles = [...rendered.values()];
    return { timeline: resolved, cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }) };
  } catch (e) { fs.rmSync(tempDir, { recursive: true, force: true }); throw e; }
}

module.exports = { materializeNestedSequences };
