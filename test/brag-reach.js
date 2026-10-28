const assert = require('assert');
const crypto = require('crypto');
const brag = require('../lib/brag');
const reach = require('../lib/reach');

const scenes = brag.validateStoryboard([
  { template: 'hook', title: 'Launch <now>', subtitle: 'A useful tool', bg: '#112233', accent: '#abcdef' },
  { template: 'cta', title: 'Try it', subtitle: 'Start today', imagePath: 'product.png' },
]);
assert.strictEqual(scenes.length, 2);
assert.strictEqual(scenes[0].title, 'Launch <now>');
assert.match(brag.pageHtml(scenes, { sceneSec: 3 }), /window\.__seek/);
assert.match(brag.pageHtml([{ ...scenes[1], imageData: 'data:image/png;base64,AAAA' }]), /product-shot/);
assert.throws(() => brag.validateStoryboard([]), /at least one scene/);
const draft = brag.createDraft({ name: 'Launch', scenes: [{ template: 'hook', title: 'Hello', imagePath: 'product.png', imageData: 'data:image/png;base64,AAAA' }], metadata: { fps: 60 } });
assert.strictEqual(draft.format, 'frosty-brag');
assert.strictEqual(draft.scenes[0].imageData, undefined, 'saved drafts should not inline potentially large image data');
assert.strictEqual(brag.parseDraft(draft).scenes[0].imagePath, 'product.png');
assert.throws(() => brag.parseDraft({ format: 'frosty-brag', version: 999, scenes: [{ title: 'x' }] }), /newer than this Frosty version/);
assert.throws(() => brag.parseDraft({ format: 'not-frosty', scenes: [{ title: 'x' }] }), /not a supported/);
assert.deepStrictEqual(brag.normalizeRenderOptions({ width: 99999, height: 0, fps: 48, sceneSec: 50 }), { width: 3840, height: 720, fps: 30, sceneSec: 12 });
assert.deepStrictEqual(brag.normalizeRenderOptions({ width: 1080, height: 1920, fps: 60, sceneSec: 2 }), { width: 1080, height: 1920, fps: 60, sceneSec: 2 });
const copy = brag.makeShareCopy({ name: 'Frosty', tagline: 'Edit better', features: ['Fast', 'Flexible'], platform: 'linkedin', url: 'https://example.com' });
assert.match(copy, /Frosty/); assert.match(copy, /Fast/); assert.match(copy, /https:\/\/example.com/);
assert.strictEqual(reach.classifyUrl('https://youtu.be/abc').platform, 'youtube');
assert.strictEqual(reach.classifyUrl('https://vimeo.com/123').platform, 'vimeo');
assert.strictEqual(reach.classifyUrl('https://github.com/openai').platform, 'github');
assert.strictEqual(reach.classifyUrl('not a url').platform, 'unknown');
assert.strictEqual(reach.classifyUrl('file://youtube.com/video').platform, 'unknown');
assert.throws(() => reach.validateHttpUrl('file:///C:/Windows/win.ini'), /http\(s\)/i);
assert.throws(() => reach.validateHttpUrl('http://127.0.0.1/admin'), /blocked by Reach/i);
assert.throws(() => reach.validateHttpUrl('http://192.168.1.10/'), /blocked by Reach/i);
assert.throws(() => reach.validateHttpUrl('http://[::ffff:172.16.0.1]/'), /blocked by Reach/i, 'IPv4-mapped IPv6 private range is blocked');
assert.throws(() => reach.validateHttpUrl('http://[::ffff:7f00:1]/'), /blocked by Reach/i, 'hex IPv4-mapped IPv6 loopback is blocked');
assert.throws(() => reach.validateHttpUrl('http://203.0.113.9/'), /blocked by Reach/i);
assert.throws(() => reach.validateHttpUrl('http://localhost:3000/'), /blocked by Reach/i);
assert.throws(() => reach.validateHttpUrl('https://user:pass@example.com/'), /credentials/i);
assert.strictEqual(reach.validateHttpUrl('https://example.com/path').hostname, 'example.com');
assert.strictEqual(reach.parseDDG('<a class="result__a" href="http://127.0.0.1/admin">local</a>').length, 0);
const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello there\n\n00:00:01.000 --> 00:00:02.000\nHello there\n\n00:00:02.000 --> 00:00:03.000\nWelcome to Frosty';
assert.strictEqual(reach.parseVtt(vtt), 'Hello there Welcome to Frosty');
const vttSegments = reach.parseVttSegments(vtt);
assert.deepStrictEqual(vttSegments.map(x => [x.start, x.end]), [[0,1],[1,2],[2,3]], 'caption parser preserves cue timestamps');
assert.strictEqual(vttSegments[2].text, 'Welcome to Frosty');
assert.strictEqual(reach.parseBing('<li class="b_algo"><h2><a href="https://example.com/story">Example story</a></h2><p>Snippet</p></li>')[0].title, 'Example story');
assert.match(reach.stripHtml('<p>Hello <b>world</b></p><script>ignore()</script>'), /Hello world/);
assert.strictEqual(reach.platformCapabilities().some(p => p.platform === 'medium'), true);
const releaseBytes = Buffer.from('verified test binary');
const releaseHash = crypto.createHash('sha256').update(releaseBytes).digest('hex');
assert.strictEqual(reach.verifyReleaseAsset(releaseBytes, `${releaseHash}  yt-dlp`, 'yt-dlp').verified, true);
assert.throws(() => reach.verifyReleaseAsset(releaseBytes, `${'0'.repeat(64)}  yt-dlp`, 'yt-dlp'), /checksum verification failed/i);
assert.throws(() => reach.verifyReleaseAsset(releaseBytes, `${releaseHash}  another-file`, 'yt-dlp'), /No SHA-256 checksum/i);
assert.strictEqual(typeof reach.inspectVideo, 'function', 'metadata inspection must be exported for the IPC workflow');
const caps = reach.platformCapabilities({ github: 'gh-token', reddit: 'rd-token', x: 'x-token', youtube: 'yt-key' });
assert.strictEqual(caps.every(p => Array.isArray(p.operations) && p.liveAvailabilityChecked === false && p.implementedBy && typeof p.authenticationConfigured === 'boolean'), true);
assert.match(caps.find(p => p.platform === 'github').authentication, /credential configured/);
assert.strictEqual(reach.normalizeTokens({ github: '  gh-token  ', x: 123 }).github, 'gh-token');
assert.strictEqual(reach.normalizeTokens({ x: 123 }).x, '');
assert.strictEqual(reach.isPublicIpv6('2606:4700:4700::1111'), true);
assert.strictEqual(reach.isPublicIpv6('fd00::1'), false);
assert.strictEqual(reach.isPublicIpv6('::ffff:192.168.1.1'), false);
assert.strictEqual(reach.validateHttpUrl('https://[2606:4700:4700::1111]/').hostname, '[2606:4700:4700::1111]');
const platformFixtures = [
  ['https://www.youtube.com/watch?v=abc', 'youtube'], ['https://www.bilibili.com/video/BV1', 'bilibili'],
  ['https://www.tiktok.com/@user/video/1', 'tiktok'], ['https://www.instagram.com/p/abc', 'instagram'],
  ['https://www.reddit.com/r/test', 'reddit'], ['https://x.com/example/status/1', 'x-twitter'],
  ['https://vimeo.com/123', 'vimeo'], ['https://www.twitch.tv/videos/123', 'twitch'],
  ['https://www.facebook.com/example', 'facebook'], ['https://soundcloud.com/example/track', 'soundcloud'],
  ['https://www.pinterest.com/pin/123', 'pinterest'], ['https://www.threads.net/@user/post/123', 'threads'],
  ['https://github.com/example/repo', 'github'], ['https://stackoverflow.com/questions/1', 'stackoverflow'],
  ['https://medium.com/@user/story', 'medium'], ['https://www.npmjs.com/package/example', 'npm'],
  ['https://example.com/article', 'web']
];
for (const [url, platform] of platformFixtures) assert.strictEqual(reach.classifyUrl(url).platform, platform, `${url} should map to ${platform}`);

console.log('Brag/Reach tests passed');

(async () => {
  const net = require('net');
  const proxy = await reach.startPinnedProxy();
  const requestConnect = (authority) => new Promise((resolve, reject) => {
    const u = new URL(proxy.url); const socket = net.connect(Number(u.port), '127.0.0.1'); let received = '';
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Pinned proxy CONNECT test timed out')); });
    socket.on('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.on('data', chunk => { received += chunk.toString(); if (received.includes('\r\n\r\n')) { socket.destroy(); resolve(received.split('\r\n')[0]); } });
    socket.on('error', reject);
  });
  try {
    assert.match(await requestConnect('127.0.0.1:443'), /^HTTP\/1\.1 403 /, 'the external downloader proxy must reject loopback CONNECT targets');
    assert.match(await requestConnect('127.0.0.1:80'), /^HTTP\/1\.1 403 /, 'the external downloader proxy must reject non-HTTPS ports');
  } finally { await proxy.close(); }
  console.log('Pinned downloader proxy security tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
