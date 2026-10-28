'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const idx = require('../lib/scene-index');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-scene-index-test-'));
  try {
    const src = path.join(dir, 'demo.mp4'); fs.writeFileSync(src, 'stable test media bytes');
    const indexFile = path.join(dir, 'library', 'index.json');
    const ff = {
      probe: async () => ({ name: 'demo.mp4', duration: 4, hasVideo: true, hasAudio: true }),
      detectScenes: async () => [2],
      thumb: async (_src, out) => { fs.writeFileSync(out, Buffer.from([0xff,0xd8,0xff,0xd9])); return out; }
    };
    const transcribe = async () => [{ start: 0.5, end: 1.5, text: 'A robot drives forward' }, { start: 2.2, end: 3.1, text: 'The vehicle stops' }];
    const first = await idx.indexMedia({ src, ff, indexFile, transcribe });
    assert.strictEqual(first.added, 2, 'both detected scene spans indexed');
    assert(first.index.scenes.every(s => s.sourceFingerprint && s.key && s.transcriptSegments.length), 'records include source fingerprint and timestamped transcript');
    const hits = idx.search(idx.load(indexFile), 'robot drives');
    assert(hits.length > 0 && hits[0].score > 0, 'scene search retrieves dialogue matches');
    assert(['lexical','phrase+lexical'].includes(hits[0].matchType));
    const second = await idx.indexMedia({ src, ff, indexFile, transcribe });
    assert.strictEqual(second.added, 0, 're-index skips completed source scenes');
    fs.appendFileSync(src, 'changed');
    const third = await idx.indexMedia({ src, ff, indexFile, transcribe });
    assert.strictEqual(third.index.scenes.length, 2, 'changed source replaces stale records instead of duplicating them');
    assert.strictEqual(idx.search(idx.load(indexFile), '   ').length, 0, 'empty search yields no results');
    assert(Math.abs(idx.cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9, 'cosine similarity identifies identical vectors');
    assert.strictEqual(idx.cosineSimilarity([1, 0], [1]), null, 'cosine similarity rejects dimension mismatch');
    const semanticIndex = { scenes: [
      { key: 'car', name: 'car', start: 0, end: 1, caption: 'A car on a road', embedding: [1, 0, 0, 0, 0, 0, 0, 0] },
      { key: 'cat', name: 'cat', start: 1, end: 2, caption: 'A cat on a sofa', embedding: [0, 1, 0, 0, 0, 0, 0, 0] }
    ] };
    const semanticHits = await idx.searchHybrid(semanticIndex, 'automobile moving down a street', 10, { embed: async () => [0.99, 0.01, 0, 0, 0, 0, 0, 0] });
    assert.strictEqual(semanticHits[0].key, 'car', 'semantic-only results rank by vector similarity without lexical overlap');
    assert.strictEqual(semanticHits[0].matchType, 'semantic', 'semantic-only result is identified accurately');
    const fallbackHits = await idx.searchHybrid(semanticIndex, 'car road', 10, { embed: async () => { throw new Error('offline'); } });
    assert.strictEqual(fallbackHits[0].key, 'car', 'embedding service failure falls back to lexical retrieval');
    const legacyHits = idx.search({ version: 1, scenes: [{ key: 'legacy', name: 'legacy interview', caption: 'office discussion', transcript: 'hello there' }] }, 'office');
    assert.strictEqual(legacyHits[0]?.key, 'legacy', 'legacy records without tags remain searchable');
    // The actual indexing path persists text embeddings and upgrades results to hybrid retrieval.
    const embeddedSrc = path.join(dir, 'embedded.mp4'); fs.writeFileSync(embeddedSrc, 'embedded test bytes');
    const embeddedIndexFile = path.join(dir, 'embedded-library', 'index.json');
    const embeddedReport = await idx.indexMedia({ src: embeddedSrc, ff, indexFile: embeddedIndexFile, embed: async (text) => { assert(text.includes('demo.mp4') || text.includes('embedded.mp4'), 'embedding input includes scene context'); return [1, 0, 0, 0, 0, 0, 0, 0]; } });
    assert.strictEqual(embeddedReport.added, 2, 'embedding-enabled index builds scene records');
    assert(embeddedReport.index.scenes.every((scene) => Array.isArray(scene.embedding) && scene.embedding.length === 8), 'indexMedia persists embeddings to every eligible scene');
    const indexedSemanticHits = await idx.searchHybrid(idx.load(embeddedIndexFile), 'an unrelated paraphrase', 10, { embed: async () => [1, 0, 0, 0, 0, 0, 0, 0] });
    assert(indexedSemanticHits.length > 0 && indexedSemanticHits.every((hit) => hit.matchType.includes('semantic')), 'persisted vectors participate in semantic/hybrid retrieval');
    console.log('scene index tests passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
