// Frosty "Reach": internet access for the editor and its AI agent (agent-reach style, re-implemented).
// Read pages (Jina Reader), search the web (DuckDuckGo HTML), download videos (yt-dlp), health-check everything.
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Frosty/0.3';

// Frosty's in-app Reach adapters are explicit: native means implemented by Frosty,
// while upstream means the installed Agent Reach/toolchain may extend coverage.
const PLATFORM_RULES = [
  ['youtube', /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i, 'video+captions', 'yt-dlp media/subtitles; optional YouTube Data API key enables metadata lookup and search'],
  ['bilibili', /(^|\.)bilibili\.com$/i, 'video+captions', 'yt-dlp support; access may be region/login restricted'],
  ['tiktok', /(^|\.)tiktok\.com$/i, 'video+captions', 'yt-dlp support for publicly accessible posts'],
  ['instagram', /(^|\.)instagram\.com$/i, 'video-limited', 'Public media only; login-protected posts may fail'],
  ['reddit', /(^|\.)reddit\.com$|(^|\.)redd\.it$/i, 'web+video-limited', 'Public pages and supported media; optional Reddit OAuth token enables API reads/search within token scope'],
  ['x-twitter', /(^|\.)x\.com$|(^|\.)twitter\.com$/i, 'web+video-limited', 'Public URL reading/download; configured X API v2 token enables post lookup and recent search'],
  ['vimeo', /(^|\.)vimeo\.com$/i, 'video+captions', 'Public videos via yt-dlp; private videos may need authentication'],
  ['twitch', /(^|\.)twitch\.tv$/i, 'video-limited', 'Public VOD support depends on yt-dlp and source availability'],
  ['facebook', /(^|\.)facebook\.com$|(^|\.)fb\.watch$/i, 'video-limited', 'Public posts only; login and age restrictions may block access'],
  ['soundcloud', /(^|\.)soundcloud\.com$/i, 'audio', 'Public track metadata/download when yt-dlp supports it'],
  ['pinterest', /(^|\.)pinterest\.com$/i, 'web+video-limited', 'Public pins only; dynamic pages may not be readable'],
  ['threads', /(^|\.)threads\.net$/i, 'web-limited', 'Public thread pages through reader fallback'],
  ['github', /(^|\.)github\.com$/i, 'web+repo-limited', 'Repository metadata, README and issue APIs; a configured token enables private/restricted access within token scope'],
  ['stackoverflow', /(^|\.)stackoverflow\.com$/i, 'web', 'Question/answer pages through reader fallback'],
  ['medium', /(^|\.)medium\.com$/i, 'web', 'Public articles through reader fallback'],
  ['npm', /(^|\.)npmjs\.com$/i, 'web', 'Package pages through reader fallback'],
  ['web', /.*/, 'web+search', 'Generic HTTP(S) reader and web search with fallback providers']
];

// IPv4 ranges that must not be used as public web endpoints. The list includes
// private, loopback, link-local, carrier-grade NAT, documentation, benchmarking,
// multicast and reserved ranges. DNS rebinding remains a separate network-layer risk.
function isBlockedIpv4(host) {
  const a = host.split('.').map(Number);
  if (a.length !== 4 || a.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return a[0] === 0 || a[0] === 10 || a[0] === 127 ||
    (a[0] === 169 && a[1] === 254) ||
    (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
    (a[0] === 192 && a[1] === 168) ||
    (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
    (a[0] === 192 && a[1] === 0 && a[2] === 0) ||
    (a[0] === 192 && a[1] === 0 && a[2] === 2) ||
    (a[0] === 192 && a[1] === 88 && a[2] === 99) ||
    (a[0] === 198 && (a[1] === 18 || a[1] === 19 || a[1] === 51 && a[2] === 100)) ||
    (a[0] === 203 && a[1] === 0 && a[2] === 113) || a[0] >= 224;
}
function mappedIpv4(host) {
  // Node's URL parser can retain IPv4-mapped IPv6 literals in either dotted
  // decimal or two-hex-group notation. They still route to an IPv4 address.
  const h = host.toLowerCase();
  if (!h.startsWith('::ffff:')) return null;
  const tail = h.slice('::ffff:'.length);
  if (net.isIP(tail) === 4) return tail;
  const parts = tail.split(':');
  if (parts.length !== 2 || parts.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  const hi = parseInt(parts[0], 16), lo = parseInt(parts[1], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}
// Reject URL forms that could invoke local files, credentials, or obvious private-network targets.
// This is defense in depth, not a substitute for OS/network sandboxing.
function validateHttpUrl(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { throw new Error('Enter a valid full http(s) URL.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) URLs are supported.');
  if (u.username || u.password) throw new Error('URLs containing embedded credentials are not supported.');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal') {
    throw new Error('Local and internal network URLs are blocked by Reach.');
  }
  const ipVersion = net.isIP(host);
  const mapped = ipVersion === 6 ? mappedIpv4(host) : null;
  if (ipVersion === 4 && isBlockedIpv4(host) || mapped && isBlockedIpv4(mapped)) {
    throw new Error('Private, loopback, link-local and reserved IP addresses are blocked by Reach.');
  }
  if (ipVersion === 6) {
    const h = host.toLowerCase();
    const first = parseInt(h.split(':')[0] || '0', 16);
    // Only global-unicast 2000::/3 is considered routable here. Explicitly reject
    // mapped IPv4 above and special/documentation/transition ranges within 2000::/3.
    const globalUnicast = (first & 0xe000) === 0x2000;
    if (!globalUnicast || h.startsWith('2001:db8:') || h.startsWith('2001:0:') || h.startsWith('2002:') || h.startsWith('2001:20:')) {
      throw new Error('Private, loopback, link-local and reserved IP addresses are blocked by Reach.');
    }
  }
  return u;
}
async function assertPublicHostname(url) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (net.isIP(host)) return;
  let records;
  try { records = await dns.lookup(host, { all: true, verbatim: true }); }
  catch { throw new Error(`Reach could not resolve host: ${host}`); }
  if (!records.length) throw new Error(`Reach could not resolve host: ${host}`);
  for (const record of records) {
    if (record.family === 4 && isBlockedIpv4(record.address)) throw new Error('Host resolves to a private or reserved address; Reach blocked the request.');
    if (record.family === 6 && !isPublicIpv6(record.address)) throw new Error('Host resolves to a private or reserved address; Reach blocked the request.');
    if (![4, 6].includes(record.family)) throw new Error('Host resolved to an unsupported address family; Reach blocked the request.');
  }
  return records;
}
// Resolve once, validate every answer, then pin the socket lookup to that exact
// public address. This closes the validate-then-resolve DNS-rebinding window.
async function pinnedFetch(url, options = {}) {
  // Do not rely on a second DNS lookup performed by the HTTP stack. Resolve
  // once, reject the entire answer set if ANY address is non-public, and pin
  // this request to one validated address for the lifetime of this socket.
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const ipFamily = net.isIP(host);
  const records = ipFamily ? [{ address: host, family: ipFamily }] : await assertPublicHostname(url);
  if (!records.length || records.some(r => (r.family === 4 && isBlockedIpv4(r.address)) ||
      (r.family === 6 && !isPublicIpv6(r.address)))) {
    throw new Error('Host resolves to a private or reserved address; Reach blocked the request.');
  }
  const record = records[0];
  const transport = url.protocol === 'https:' ? https : http;
  const headers = Object.fromEntries(new Headers(options.headers || {}).entries());
  const body = options.body;
  const maxBytes = Math.max(1024, Math.min(Number(options.maxResponseBytes) || 8 * 1024 * 1024, 32 * 1024 * 1024));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let req;
    const finish = (fn, value) => { if (settled) return; settled = true; options.signal?.removeEventListener('abort', onAbort); fn(value); };
    const onAbort = () => { const e = new Error('Reach request cancelled.'); e.name = 'AbortError'; try { req?.destroy(e); } catch {} finish(reject, e); };
    if (options.signal?.aborted) { finish(reject, Object.assign(new Error('Reach request cancelled.'), { name: 'AbortError' })); return; }
    req = transport.request(url, {
      method: options.method || 'GET', headers, signal: undefined,
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) callback(null, [{ address: record.address, family: record.family }]);
        else callback(null, record.address, record.family);
      },
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: true,
    }, (res) => {
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          const e = new Error(`Reach response exceeded the ${maxBytes}-byte safety limit.`);
          req.destroy(e); finish(reject, e); return;
        }
        chunks.push(chunk);
      });
      res.on('error', (e) => finish(reject, e));
      res.on('end', () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) if (value != null) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
        const status = res.statusCode || 502;
        // Fetch's Response constructor disallows bodies for these status codes.
        try { finish(resolve, new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders })); }
        catch (e) { finish(reject, e); }
      });
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    req.setTimeout(Math.max(1000, Math.min(Number(options.timeoutMs) || 30000, 60000)), () => req.destroy(new Error('Reach request timed out.')));
    req.on('error', (e) => finish(reject, e));
    if (body != null) req.write(body);
    req.end();
  });
}
function isPublicIpv6(address) {
  const h = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(h) !== 6) return false;
  const mapped = mappedIpv4(h);
  if (mapped) return !isBlockedIpv4(mapped);
  const first = parseInt(h.split(':')[0] || '0', 16);
  return (first & 0xe000) === 0x2000 &&
    !h.startsWith('2001:db8:') && !h.startsWith('2001:0:') &&
    !h.startsWith('2002:') && !h.startsWith('2001:20:');
}

async function fetchWithSafeRedirects(input, options = {}, maxRedirects = 5) {
  let current = validateHttpUrl(input);
  let currentOptions = { ...options, headers: new Headers(options.headers || {}), redirect: 'manual' };
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await pinnedFetch(current, currentOptions);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (hop === maxRedirects) throw new Error('Too many redirects while reading this URL.');
    const next = validateHttpUrl(new URL(location, current).toString());
    if (next.origin !== current.origin) {
      // Never forward bearer/basic/cookie credentials across an origin change.
      currentOptions.headers.delete('authorization');
      currentOptions.headers.delete('proxy-authorization');
      currentOptions.headers.delete('cookie');
    }
    current = next;
  }
  throw new Error('Too many redirects while reading this URL.');
}

function parseBing(html) {
  const out = [];
  for (const chunk of String(html || '').split(/<li class=\"b_algo\"/i).slice(1)) {
    const m = /<h2[^>]*>\s*<a[^>]+href=\"([^\"]+)\"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (!m) continue;
    let url; try { url = validateHttpUrl(m[1].replace(/&amp;/g, '&')).toString(); } catch { continue; }
    const title = stripHtml(m[2]);
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(chunk);
    if (title && !out.some(x => x.url === url)) out.push({ title, url, snippet: stripHtml(snippetMatch?.[1] || '') });
    if (out.length >= 8) break;
  }
  return out;
}
function classifyUrl(url) {
  let host; try { host = validateHttpUrl(url).hostname.toLowerCase(); } catch (e) { return { platform: 'unknown', adapter: 'none', note: e.message }; }
  const hit = PLATFORM_RULES.find(([, re]) => re.test(host));
  return { platform: hit[0], adapter: hit[2], note: hit[3], host };
}
function normalizeTokens(tokens = {}) {
  if (!tokens || typeof tokens !== 'object') return {};
  const take = (key, max = 8192) => typeof tokens[key] === 'string' ? tokens[key].trim().slice(0, max) : '';
  return { github: take('github', 512), reddit: take('reddit', 8192), x: take('x', 8192), youtube: take('youtube', 512) };
}
function platformCapabilities(tokens = {}) {
  const t = normalizeTokens(tokens);
  return PLATFORM_RULES.map(([platform, , adapter, note]) => {
    const authRequired = { github: 'github', reddit: 'reddit', 'x-twitter': 'x', youtube: 'youtube' }[platform];
    const api = { github: 'GitHub REST API', reddit: 'Reddit OAuth API', 'x-twitter': 'X API v2', youtube: 'YouTube Data API v3' }[platform] || '';
    return {
      platform, adapter, note,
      status: platform === 'web' ? 'generic-fallback' : 'public-source-adapter',
      implementedBy: adapter.includes('video') || adapter.includes('captions') || adapter.includes('audio') ? 'yt-dlp extractor plus Frosty metadata/download/caption workflow' : 'Frosty safe HTTP reader and web search',
      operations: adapter.includes('video') || adapter.includes('captions') ? ['classify-url', 'inspect-public-video', 'download-public-media', 'fetch-available-english-captions'] : adapter.includes('audio') ? ['classify-url', 'inspect-public-media', 'download-public-media'] : adapter.includes('search') ? ['classify-url', 'search-web', 'read-public-url'] : ['classify-url', 'read-public-url'],
      authentication: authRequired ? (t[authRequired] ? `${api} credential configured` : `${api} credential not configured`) : 'Public-source access; provider-specific login may still be required',
      authenticationConfigured: authRequired ? Boolean(t[authRequired]) : false,
      liveAvailabilityChecked: false
    };
  });
}
function apiHeaders(token, extra = {}) {
  const headers = { 'User-Agent': UA, Accept: 'application/json', ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
async function apiJson(url, headers, maxResponseBytes = 4 * 1024 * 1024, maxRedirects = 5) {
  const response = await fetchWithSafeRedirects(url, { headers, signal: AbortSignal.timeout(15000), maxResponseBytes }, maxRedirects);
  if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
  return response.json();
}
function extractYouTubeId(url) {
  const u = url instanceof URL ? url : validateHttpUrl(url);
  if (/(^|\.)youtu\.be$/i.test(u.hostname)) return u.pathname.split('/').filter(Boolean)[0] || '';
  if (/youtube\.com$/i.test(u.hostname)) {
    if (u.pathname === '/watch') return u.searchParams.get('v') || '';
    const m = /^\/(?:shorts|embed|live)\/([^/?]+)/.exec(u.pathname);
    return m?.[1] || '';
  }
  return '';
}
async function authenticatedRead(target, tokens) {
  const u = target instanceof URL ? target : validateHttpUrl(target);
  const t = normalizeTokens(tokens);
  if (/^(?:www\.)?github\.com$/i.test(u.hostname)) {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0], repo = parts[1].replace(/\.git$/i, '');
    if (!/^[\w.-]{1,100}$/.test(owner) || !/^[\w.-]{1,100}$/.test(repo)) return null;
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const headers = apiHeaders(t.github, { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
    if (parts[2] === 'issues' && /^\d+$/.test(parts[3] || '')) {
      const issue = await apiJson(`${base}/issues/${parts[3]}`, headers);
      return `GitHub issue: ${issue.title || '(untitled)'}\nRepository: ${owner}/${repo}\nState: ${issue.state || 'unknown'}\nCreated: ${issue.created_at || 'unknown'}\nURL: ${issue.html_url || u.toString()}\n\n${String(issue.body || '').slice(0, 12000)}`;
    }
    const repoData = await apiJson(base, headers);
    let readme = '';
    try {
      const readmeData = await apiJson(`${base}/readme`, headers, 2 * 1024 * 1024);
      if (readmeData.encoding === 'base64' && readmeData.content) readme = Buffer.from(readmeData.content.replace(/\s/g, ''), 'base64').toString('utf8').slice(0, 14000);
    } catch { /* private repos without README access can still show repository metadata */ }
    return `GitHub repository: ${repoData.full_name || `${owner}/${repo}`}\nDescription: ${repoData.description || '(none)'}\nDefault branch: ${repoData.default_branch || 'unknown'}\nStars: ${repoData.stargazers_count ?? 'unknown'} · Forks: ${repoData.forks_count ?? 'unknown'} · Open issues: ${repoData.open_issues_count ?? 'unknown'}\nLicense: ${repoData.license?.spdx_id || 'not reported'}\nURL: ${repoData.html_url || u.toString()}\n\nREADME\n${readme || '(README unavailable or empty)'}`;
  }
  if (/^(?:www\.)?reddit\.com$/i.test(u.hostname) && t.reddit) {
    const pathPart = u.pathname.replace(/\/$/, '');
    const response = await apiJson(`https://oauth.reddit.com${pathPart}.json?raw_json=1`, apiHeaders(t.reddit, { 'User-Agent': 'Frosty/1.2 (desktop editor)' }), 2 * 1024 * 1024);
    const posts = Array.isArray(response) ? response : [response];
    const flatten = posts.flatMap(x => x?.data?.children || []).slice(0, 25).map(x => x.data).filter(Boolean);
    if (flatten.length) return flatten.map(x => `${x.title || 'Reddit post'}\n${x.author ? `u/${x.author}` : ''} · score ${x.score ?? 'n/a'} · comments ${x.num_comments ?? 'n/a'}\nhttps://www.reddit.com${x.permalink || u.pathname}\n\n${String(x.selftext || x.url || '').slice(0, 4000)}`).join('\n\n---\n\n').slice(0, 16000);
  }
  if (/^(?:www\.)?(?:x\.com|twitter\.com)$/i.test(u.hostname) && t.x) {
    const id = /\/status\/(\d+)/.exec(u.pathname)?.[1];
    if (!id) return null;
    const tweet = await apiJson(`https://api.x.com/2/tweets/${id}?tweet.fields=created_at,lang,public_metrics,author_id`, apiHeaders(t.x));
    const d = tweet.data;
    if (d) return `X post by user ${d.author_id || 'unknown'}\nCreated: ${d.created_at || 'unknown'} · Language: ${d.lang || 'unknown'}\nMetrics: ${JSON.stringify(d.public_metrics || {})}\nURL: ${u}\n\n${String(d.text || '').slice(0, 10000)}`;
  }
  const ytId = extractYouTubeId(u);
  if (ytId && t.youtube) {
    const details = await apiJson(`https://youtube.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${encodeURIComponent(ytId)}&key=${encodeURIComponent(t.youtube)}`, apiHeaders(''), 4 * 1024 * 1024, 0);
    const v = details.items?.[0];
    if (v) return `YouTube video: ${v.snippet?.title || 'Untitled'}\nChannel: ${v.snippet?.channelTitle || 'unknown'} · Published: ${v.snippet?.publishedAt || 'unknown'}\nDuration: ${v.contentDetails?.duration || 'unknown'} · Views: ${v.statistics?.viewCount || 'not available'}\nURL: https://www.youtube.com/watch?v=${encodeURIComponent(ytId)}\n\n${String(v.snippet?.description || '').slice(0, 10000)}`;
  }
  return null;
}
async function authenticatedSearch(query, tokens = {}) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) return [];
  const t = normalizeTokens(tokens);
  const attempts = [];
  if (t.github) attempts.push(async () => {
    const data = await apiJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=5`, apiHeaders(t.github, { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }));
    return (data.items || []).map(x => ({ title: x.full_name || x.name, url: x.html_url, snippet: `${x.description || 'No description'} · ${x.stargazers_count || 0} stars · ${x.language || 'language not specified'}`, provider: 'GitHub API' }));
  });
  if (t.reddit) attempts.push(async () => {
    const data = await apiJson(`https://oauth.reddit.com/search.json?q=${encodeURIComponent(q)}&limit=5&sort=relevance&raw_json=1`, apiHeaders(t.reddit, { 'User-Agent': 'Frosty/1.2 (desktop editor)' }));
    return (data.data?.children || []).map(x => x.data).filter(Boolean).map(x => ({ title: x.title || 'Reddit post', url: `https://www.reddit.com${x.permalink || ''}`, snippet: String(x.selftext || '').slice(0, 400), provider: 'Reddit API' }));
  });
  if (t.x) attempts.push(async () => {
    const data = await apiJson(`https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(q + ' -is:retweet')}&max_results=10&tweet.fields=created_at,lang,public_metrics,author_id`, apiHeaders(t.x));
    return (data.data || []).map(x => ({ title: `Post by ${x.author_id || 'unknown user'}`, url: `https://x.com/i/web/status/${x.id}`, snippet: String(x.text || '').slice(0, 400), provider: 'X API v2' }));
  });
  if (t.youtube) attempts.push(async () => {
    const data = await apiJson(`https://youtube.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(q)}&key=${encodeURIComponent(t.youtube)}`, apiHeaders(''), 4 * 1024 * 1024, 0);
    return (data.items || []).map(x => ({ title: x.snippet?.title || 'YouTube video', url: `https://www.youtube.com/watch?v=${x.id?.videoId || ''}`, snippet: String(x.snippet?.description || '').slice(0, 400), provider: 'YouTube Data API' }));
  });
  const all = []; const failures = [];
  for (const attempt of attempts) {
    try { for (const item of await attempt()) if (item.url && !all.some(x => x.url === item.url)) all.push(item); }
    catch (e) { failures.push(e.message); }
  }
  if (all.length) return all.slice(0, 20);
  return [];
}

function stripHtml(html) {
  return String(html || '').replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/article|\/section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
async function readUrl(url, { tokens = {} } = {}) {
  const target = validateHttpUrl(url); await assertPublicHostname(target);
  const failures = [];
  try { const authenticated = await authenticatedRead(target, tokens); if (authenticated) return authenticated; }
  catch (e) { failures.push(`Authenticated provider API: ${e.message}`); }
  try {
    const res = await fetchWithSafeRedirects('https://r.jina.ai/' + url, { headers: { 'User-Agent': UA, Accept: 'text/plain' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`reader returned ${res.status}`);
    const text = (await res.text()).slice(0, 20000);
    if (text.trim()) return text;
    throw new Error('reader returned an empty page');
  } catch (e) { failures.push(`Jina Reader: ${e.message}`); }
  try {
    const res = await fetchWithSafeRedirects(url, { headers: { 'User-Agent': UA, Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`direct request returned ${res.status}`);
    const text = stripHtml(await res.text()).slice(0, 16000);
    if (text.length < 40) throw new Error('direct page yielded little readable text');
    return `[Fallback: direct page extraction; layout and dynamic content may be missing]\nURL: ${res.url}\n\n${text}`;
  } catch (e) { failures.push(`Direct reader: ${e.message}`); }
  throw new Error(`Could not read this page. ${failures.join('; ')}`);
}

function parseDDG(html) {
  const out = [];
  const strip = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').trim();
  for (const chunk of html.split('class="result__a"').slice(1)) {
    const m = /href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(chunk);
    if (!m) continue;
    let u = m[1].replace(/&amp;/g, '&');
    const q = /[?&]uddg=([^&]+)/.exec(u);
    if (q) { try { u = decodeURIComponent(q[1]); } catch { continue; } }
    if (u.startsWith('//')) u = 'https:' + u;
    try { u = validateHttpUrl(u).toString(); } catch { continue; }
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(chunk);
    out.push({ title: strip(m[2]), url: u, snippet: strip(sn && sn[1]) });
    if (out.length >= 8) break;
  }
  return out;
}
async function search(q, tokens = {}) {
  q = String(q || '').trim().slice(0, 500);
  if (!q) throw new Error('Enter a search query.');
  const authenticated = await authenticatedSearch(q, tokens);
  if (authenticated.length) return authenticated;
  const failures = [];
  try {
    const res = await fetchWithSafeRedirects('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);
    const results = parseDDG(await res.text()); if (results.length) return results;
    failures.push('DuckDuckGo returned no parseable results');
  } catch (e) { failures.push(e.message); }
  try {
    const res = await fetchWithSafeRedirects('https://www.bing.com/search?q=' + encodeURIComponent(q), { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`Bing returned ${res.status}`);
    const results = parseBing(await res.text());
    if (results.length) return results;
    failures.push('Bing returned no parseable results');
  } catch (e) { failures.push(e.message); }
  try {
    const res = await fetchWithSafeRedirects('https://www.google.com/search?q=' + encodeURIComponent(q), { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`search fallback returned ${res.status}`);
    const html = await res.text(), results = [];
    for (const match of html.matchAll(/<a href="\/url\?q=([^&"]+)[^>]*>([\s\S]*?)<\/a>/gi)) {
      let url; try { url = validateHttpUrl(decodeURIComponent(match[1])).toString(); } catch { continue; }
      const title = stripHtml(match[2]); if (title && !results.some(r => r.url === url)) results.push({ title, url, snippet: '' });
      if (results.length >= 8) break;
    }
    if (results.length) return results;
    throw new Error('fallback returned no parseable results');
  } catch (e) { failures.push(e.message); }
  throw new Error(`Search providers failed: ${failures.join('; ')}`);
}


function verifyReleaseAsset(bytes, sumsText, assetName) {
  const expected = String(sumsText || '').split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?([^\s]+)$/i.exec(line.trim())).find(m => m && path.basename(m[2]) === assetName)?.[1];
  if (!expected) throw new Error(`No SHA-256 checksum for ${assetName} was found in the release checksum file.`);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`SHA-256 checksum verification failed for ${assetName}.`);
  return { sha256: actual, verified: true };
}

// ---- yt-dlp (system install, or auto-fetched into Frosty's data folder) ----
const exeName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
function onPath(cmd) { try { return spawnSync(cmd, ['--version'], { windowsHide: true }).status === 0; } catch { return false; } }
async function ytdlp(binDir) {
  if (onPath('yt-dlp')) return 'yt-dlp';
  const local = path.join(binDir, exeName);
  if (fs.existsSync(local)) {
    // Re-verify the cached binary against the SHA-256 recorded at install time before every reuse.
    let recorded = '';
    try { recorded = fs.readFileSync(local + '.sha256', 'utf8').trim().toLowerCase(); } catch {}
    const actual = crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex');
    if (recorded && recorded === actual) return local;
    try { fs.unlinkSync(local); } catch {}
    try { fs.unlinkSync(local + '.sha256'); } catch {}
    // fall through and re-download a verified copy
  }
  fs.mkdirSync(binDir, { recursive: true });
  const headers = { 'User-Agent': UA };
  const [res, sumsRes] = await Promise.all([
    fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + exeName, { headers, signal: AbortSignal.timeout(60000) }),
    fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS', { headers, signal: AbortSignal.timeout(20000) })
  ]);
  if (!res.ok) throw new Error('Could not fetch yt-dlp (' + res.status + '). Install it from github.com/yt-dlp/yt-dlp.');
  if (!sumsRes.ok) throw new Error('Could not fetch the yt-dlp release checksum file; refusing to install an unverified executable.');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > 100 * 1024 * 1024) throw new Error('Downloaded yt-dlp size is invalid; refusing to install it.');
  const sums = await sumsRes.text();
  let verified;
  try { verified = verifyReleaseAsset(bytes, sums, exeName); }
  catch (e) { throw new Error(`${e.message} Refusing to execute the downloaded binary.`); }
  const temp = `${local}.download-${process.pid}`;
  fs.writeFileSync(temp, bytes, { flag: 'wx' });
  if (process.platform !== 'win32') fs.chmodSync(temp, 0o755);
  fs.renameSync(temp, local);
  fs.writeFileSync(local + '.sha256', verified.sha256);
  return local;
}
function runTool(bin, args, { timeoutMs = 15 * 60 * 1000, maxOutputChars = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', settled = false, timer;
    const finish = (fn, value) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(value); };
    const append = (which, chunk) => {
      const value = which === 'out' ? out : err;
      if (value.length + chunk.length > maxOutputChars) { try { p.kill(); } catch {} finish(reject, new Error('yt-dlp output exceeded the configured safety limit.')); return; }
      if (which === 'out') out += chunk; else err += chunk;
    };
    p.stdout.on('data', (d) => append('out', String(d))); p.stderr.on('data', (d) => append('err', String(d)));
    p.on('error', (e) => finish(reject, e));
    timer = setTimeout(() => { try { p.kill(); } catch {} finish(reject, new Error('yt-dlp operation timed out.')); }, Math.max(1000, timeoutMs));
    p.on('close', (c) => (c === 0 ? finish(resolve, out) : finish(reject, new Error(err.split('\n').filter(Boolean).slice(-3).join(' ') || `yt-dlp exited with code ${c}`))));
  });
}

// yt-dlp is a separate process and cannot inherit the Node HTTP client's pinned
// DNS lookup. Route every downloader HTTP request through this loopback-only
// proxy instead. Each HTTPS CONNECT resolves and validates the whole DNS answer
// set, then opens its TCP connection to one validated IP; TLS still terminates
// in yt-dlp with the original hostname, preserving certificate/SNI checks.
async function startPinnedProxy() {
  const server = http.createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD', 'POST'].includes(String(req.method || '').toUpperCase())) { res.writeHead(405, { 'content-type': 'text/plain', connection: 'close' }); res.end('Method blocked by Frosty Reach proxy'); return; }
      let target;
      try { target = new URL(req.url, `http://${req.headers.host || ''}`); } catch { throw new Error('Proxy request URL is invalid.'); }
      target = validateHttpUrl(target.toString());
      if (target.protocol !== 'http:') throw new Error('HTTPS proxy traffic must use CONNECT.');
      const bodyChunks = []; let bodyLength = 0;
      for await (const chunk of req) { bodyLength += chunk.length; if (bodyLength > 1024 * 1024) throw new Error('Proxy request body exceeded 1 MiB.'); bodyChunks.push(chunk); }
      const headers = { ...req.headers }; for (const h of ['host', 'connection', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'content-length']) delete headers[h];
      headers.connection = 'close';
      const response = await pinnedFetch(target, { method: req.method, headers, body: bodyLength ? Buffer.concat(bodyChunks) : undefined, timeoutMs: 30000, maxResponseBytes: 32 * 1024 * 1024 });
      const responseHeaders = {};
      for (const [name, value] of response.headers.entries()) if (!['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'].includes(name.toLowerCase())) responseHeaders[name] = value;
      const bytes = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, responseHeaders); if (req.method === 'HEAD') res.end(); else res.end(bytes);
    } catch (error) { if (!res.headersSent) res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' }); res.end(String(error?.message || 'Blocked by Frosty Reach')); }
  });
  server.on('connect', async (request, client, head) => {
    let upstream;
    const reject = (status, reason) => {
      if (!client.destroyed) { const body = String(reason || 'Blocked by Frosty Reach'); client.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); }
    };
    try {
      const authority = String(request.url || '');
      const match = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+)):(\d{1,5})$/i.exec(authority);
      if (!match) throw new Error('Malformed CONNECT authority.');
      const host = (match[1] || match[2]).toLowerCase().replace(/\.$/, ''); const port = Number(match[3]);
      // Do not allow arbitrary ports through a public-address pin; HTTPS media
      // and provider endpoints use 443. Blocking alternate ports reduces SSRF.
      if (port !== 443) throw new Error('Only public HTTPS port 443 is supported.');
      const urlHost = net.isIP(host) === 6 ? `[${host}]` : host;
      const target = validateHttpUrl(`https://${urlHost}:${port}/`);
      const family = net.isIP(host);
      const records = family ? [{ address: host, family }] : await assertPublicHostname(target);
      if (!records?.length || records.some(r => (r.family === 4 && isBlockedIpv4(r.address)) || (r.family === 6 && !isPublicIpv6(r.address)))) throw new Error('Host resolves to a private or reserved address; Reach blocked the tunnel.');
      const selected = records[0];
      upstream = net.connect({ host: selected.address, port, family: selected.family });
      const cleanUp = () => { try { upstream?.destroy(); } catch {} };
      client.on('error', cleanUp); client.on('close', cleanUp); upstream.on('error', () => { reject(502, 'Could not connect to public HTTPS host.'); });
      upstream.once('connect', () => {
        if (client.destroyed) { upstream.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Frosty-Reach\r\n\r\n');
        if (head?.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
    } catch (error) { reject(403, error?.message); try { upstream?.destroy(); } catch {} }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise(resolve => server.close(() => resolve())) };
}
async function runYtDlpPinned(bin, args, options) {
  const proxy = await startPinnedProxy();
  try { return await runTool(bin, [...args, '--proxy', proxy.url], options); }
  finally { await proxy.close(); }
}
// Inspect first, so Copy can reject long videos before downloading the full media.
async function inspectVideo(url, { binDir } = {}) {
  const parsed = validateHttpUrl(url); await assertPublicHostname(parsed);
  const bin = await ytdlp(binDir);
  const raw = await runYtDlpPinned(bin, ['--no-playlist', '--dump-single-json', '--skip-download', '--no-warnings', url], { timeoutMs: 120000 });
  let info; try { info = JSON.parse(raw.trim().split(/\r?\n/).pop()); } catch { throw new Error('Could not read video metadata from this link.'); }
  return { title: String(info.title || 'Video').slice(0, 160), duration: Number(info.duration) || 0, webpage_url: info.webpage_url || url, uploader: String(info.uploader || '').slice(0, 160), thumbnail: info.thumbnail || '', platform: classifyUrl(url).platform, extractor: String(info.extractor_key || info.extractor || '').slice(0, 100), availability: info.availability || 'unknown', liveStatus: info.live_status || null, width: Number(info.width) || null, height: Number(info.height) || null, fps: Number(info.fps) || null, formatCount: Array.isArray(info.formats) ? info.formats.length : 0, subtitlesAvailable: Object.keys(info.subtitles || {}).length > 0, automaticCaptionsAvailable: Object.keys(info.automatic_captions || {}).length > 0, durationVerified: Number.isFinite(Number(info.duration)) && Number(info.duration) > 0 };
}

// Download best <=1080p mp4 and return the file path. Optional maxDuration is enforced before download.
async function download(url, { binDir, outDir, ffmpeg, maxDuration = 0 }) {
  const parsed = validateHttpUrl(url); await assertPublicHostname(parsed);
  const bin = await ytdlp(binDir);
  if (maxDuration > 0) {
    const info = await inspectVideo(url, { binDir });
    if (!info.duration) throw new Error('The source duration is unavailable, so the 2-minute limit cannot be verified.');
    if (info.duration > maxDuration) throw new Error(`This video is ${Math.ceil(info.duration)} seconds long. Copy supports videos up to ${maxDuration} seconds.`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const out = await runYtDlpPinned(bin, ['--no-playlist', '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4', '--ffmpeg-location', ffmpeg,
    '-o', path.join(outDir, '%(title).80s.%(ext)s'), '--print', 'after_move:filepath', '--no-warnings', url], { timeoutMs: 15 * 60 * 1000 });
  const file = out.trim().split(/\r?\n/).pop();
  if (!file || !fs.existsSync(file)) throw new Error('Download finished but file not found');
  return file;
}

function parseVttSegments(vtt) {
  const text = String(vtt || '').replace(/^\uFEFF/, '');
  const blocks = text.split(/\r?\n\s*\r?\n/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const ti = lines.findIndex(x => /(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}/.test(x));
    if (ti < 0) continue;
    const m = /((?:\d{2}:)?\d{2}:\d{2})[.,](\d{3})\s+-->\s+((?:\d{2}:)?\d{2}:\d{2})[.,](\d{3})/.exec(lines[ti]);
    if (!m) continue;
    const seconds = (clock, ms) => { const parts = clock.split(':').map(Number); return +(parts.reduce((n,x)=>n*60+x,0) + Number(ms)/1000).toFixed(3); };
    const clean = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '\"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
    if (clean) out.push({ start: seconds(m[1], m[2]), end: seconds(m[3], m[4]), text: clean });
  }
  return out.filter(x => x.end >= x.start).slice(0, 20000);
}
function parseVtt(vtt) {
  const out = [];
  for (const segment of parseVttSegments(vtt)) if (segment.text && segment.text !== out[out.length - 1]) out.push(segment.text);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}
async function extractTranscript(url, { binDir, outDir } = {}) {
  const parsed = validateHttpUrl(url); await assertPublicHostname(parsed);
  const bin = await ytdlp(binDir || path.join(process.cwd(), '.frosty-bin'));
  const dir = fs.mkdtempSync(path.join(outDir || os.tmpdir(), 'frosty-captions-'));
  try {
    await runYtDlpPinned(bin, ['--no-playlist', '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,en', '--sub-format', 'vtt/best', '--convert-subs', 'vtt', '--no-warnings', '-o', path.join(dir, 'caption.%(ext)s'), url], { timeoutMs: 120000 });
    const files = fs.readdirSync(dir).filter((f) => /\.(vtt|srt|ass)$/i.test(f));
    for (const file of files) {
      const transcript = parseVttSegments(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (transcript.length) return { transcript: transcript.map(x => x.text).join(' ').slice(0, 50000), segments: transcript, source: 'yt-dlp subtitles', language: /\.([a-z]{2}(?:-[A-Z]{2})?)\./.exec(file)?.[1] || 'en', fileName: file };
    }
    throw new Error('No English subtitle track was available for this public URL. Try local Whisper transcription after downloading the video.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
async function diagnostics({ binDir, tokens = {} } = {}) {
  const rows = [];
  const normalizedTokens = normalizeTokens(tokens);
  for (const [platform, , adapter, note] of PLATFORM_RULES) {
    const tokenKey = { github: 'github', reddit: 'reddit', 'x-twitter': 'x', youtube: 'youtube' }[platform];
    rows.push({ platform, adapter, registered: true, auth: tokenKey ? (normalizedTokens[tokenKey] ? 'configured' : 'not configured') : 'provider-dependent', note: `${note}; requires a public/accessible source` });
  }
  rows.push({ platform: 'captions', adapter: 'yt-dlp subtitles', registered: true, auth: 'source-dependent', note: 'Fetches public English subtitle tracks; local Whisper remains the fallback for downloaded files.' });
  return rows;
}

async function doctor({ ffmpeg, binDir, apiKey, python }) {
  const r = [];
  const ok = (name, good, note) => r.push({ name, ok: !!good, note });
  ok('FFmpeg', fs.existsSync(ffmpeg) || ffmpeg === 'ffmpeg', ffmpeg);
  const py = python.map((c) => ({ c, s: spawnSync(c[0], [...c.slice(1), '-c', 'import faster_whisper'], { windowsHide: true }) })).find((x) => x.s.status === 0);
  ok('Whisper (python + faster-whisper)', py, py ? py.c.join(' ') : 'run: pip install faster-whisper');
  ok('yt-dlp', onPath('yt-dlp') || fs.existsSync(path.join(binDir, exeName)), 'auto-installs on first download');
  const reachCli = spawnSync('agent-reach', ['version'], { windowsHide: true, encoding: 'utf8', timeout: 3000 });
  ok('Upstream Agent Reach CLI', reachCli.status === 0, reachCli.status === 0 ? String(reachCli.stdout || '').trim().slice(0, 160) : 'Optional bridge not installed; Frosty native web/video adapters remain available. Frosty does not claim full upstream channel parity.');
  ok('OpenRouter key', !!apiKey, apiKey ? 'set' : 'add in Settings');
  try { await fetchWithSafeRedirects('https://r.jina.ai/https://example.com', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }).then((x) => { if (!x.ok) throw 0; }); ok('Web reader', true, 'r.jina.ai reachable'); }
  catch { ok('Web reader', false, 'no internet or blocked'); }
  return r;
}
module.exports = { readUrl, search, parseDDG, parseBing, verifyReleaseAsset, inspectVideo, download, doctor, ytdlp, startPinnedProxy, runYtDlpPinned, classifyUrl, platformCapabilities, normalizeTokens, authenticatedRead, authenticatedSearch, isPublicIpv6, isBlockedIpv4, parseVtt, parseVttSegments, extractTranscript, diagnostics, stripHtml, validateHttpUrl, assertPublicHostname, fetchWithSafeRedirects };
