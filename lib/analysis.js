// Structured media/timeline analysis and color/audio measurement helpers.
const fs = require('fs');
const os = require('os');
const path = require('path');
const TL = require('./timeline');
const crypto = require('crypto');

function parseMetric(log, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...String(log).matchAll(new RegExp(`${escaped}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'gi'))];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}
function parseTimedEvents(log, startPattern, endPattern) {
  const events = []; let open = null;
  for (const line of String(log || '').split(/\r?\n/)) {
    const sm = startPattern.exec(line);
    if (sm) open = Number(sm[1]);
    const em = endPattern.exec(line);
    if (em && open !== null) { const end = Number(em[1]); if (Number.isFinite(open) && Number.isFinite(end) && end >= open) events.push({ start: +open.toFixed(3), end: +end.toFixed(3), duration: +(end - open).toFixed(3) }); open = null; }
  }
  return events;
}
function csvCell(v) { const x = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return `\"${x.replace(/\"/g, '\"\"')}\"`; }
function exportReport(report, format = 'json') {
  const kind = String(format || 'json').toLowerCase();
  if (kind === 'json') return JSON.stringify(report, null, 2);
  // Accept both timeline reports ({ mediaReports }) and single-source reports
  // returned by analyzeMedia(); otherwise CSV/HTML exports silently look empty.
  const mediaReports = Array.isArray(report?.mediaReports)
    ? report.mediaReports
    : (report && (report.source || report.name) && (report.summary || report.media) ? [report] : []);
  if (kind === 'csv') {
    const rows = [['type','source','startSeconds','endSeconds','durationSeconds','metric','value','confidence','details']];
    for (const media of mediaReports) {
      rows.push(['media', media.source, '', '', media.summary?.durationSeconds, 'resolution', media.summary?.resolution, media.confidence?.metadata, media.name]);
      for (const scene of media.sceneSegments || []) rows.push(['scene', media.source, scene.start, scene.end, scene.duration, 'cut', scene.cutAt, scene.confidence, scene.caption || scene.transcript || '']);
      for (const silence of media.silence || []) rows.push(['silence', media.source, silence[0], silence[1], +(silence[1]-silence[0]).toFixed(3), 'silence', true, 'medium', '']);
      for (const black of media.blackSegments || []) rows.push(['black', media.source, black.start, black.end, black.duration, 'black-frame interval', true, 'medium', '']);
      for (const [metric, value] of Object.entries(media.audio || {})) if (typeof value === 'number') rows.push(['audio', media.source, '', '', '', metric, value, media.confidence?.audioMetrics, '']);
    }
    return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  }
  if (kind === 'html') {
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
    const rows = mediaReports.map(m => `<section><h2>${esc(m.name)}</h2><p>${esc(m.summary?.resolution || 'Audio only')} · ${esc(m.summary?.durationSeconds)} s · ${esc(m.scenes?.length || 0)} cuts</p><p>Audio: ${esc(m.audio?.integratedLufs ?? 'n/a')} LUFS · Peak ${esc(m.audio?.peakDbfs ?? 'n/a')} dBFS</p><h3>Warnings</h3><ul>${(m.warnings || []).map(w=>`<li>${esc(w)}</li>`).join('')}</ul><h3>Scene segments</h3><table><thead><tr><th>Start</th><th>End</th><th>Duration</th><th>Caption / transcript</th></tr></thead><tbody>${(m.sceneSegments || []).map(x=>`<tr><td>${esc(x.start)}</td><td>${esc(x.end)}</td><td>${esc(x.duration)}</td><td>${esc(x.caption || x.transcript || '')}</td></tr>`).join('')}</tbody></table></section>`).join('');
    return `<!doctype html><html><head><meta charset=\"utf-8\"><title>Frosty analysis report</title><style>body{font:15px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#222}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.4rem;text-align:left}section{border-top:2px solid #777;padding:1rem 0}</style></head><body><h1>Frosty structured analysis</h1><p>Generated ${esc(report.analyzedAt)} · ${esc(report.kind || 'analysis')}</p><pre>${esc(JSON.stringify(report.timeline || (report.source ? { source: report.source, summary: report.summary } : {}), null, 2))}</pre>${rows}</body></html>`;
  }
  throw new Error(`Unsupported report format: ${format}`);
}
function parseLoudness(log) {
  const integrated = /Integrated loudness:\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/i.exec(log);
  const range = /Loudness range:\s*LRA:\s*(-?\d+(?:\.\d+)?)\s*LU/i.exec(log);
  const truePeak = /True peak:\s*Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/i.exec(log);
  return { integratedLufs: integrated ? +integrated[1] : null, loudnessRangeLu: range ? +range[1] : null, truePeakDbfs: truePeak ? +truePeak[1] : null };
}
function confidenceLabel(score) { return score >= 0.75 ? 'high' : score >= 0.45 ? 'medium' : 'low'; }
function metadataConfidence(probe) {
  const evidence = [Number(probe?.duration) > 0, !!(probe?.hasVideo && Number(probe?.width) > 0 && Number(probe?.height) > 0), !!probe?.hasAudio].filter(Boolean).length;
  return confidenceLabel(evidence / 3);
}
function audioConfidence(audio) {
  if (!audio) return 'not-applicable';
  const measured = ['integratedLufs', 'truePeakDbfs', 'peakDbfs', 'rmsDbfs'].filter(k => Number.isFinite(audio[k])).length;
  return measured >= 3 ? 'high' : measured >= 1 ? 'medium' : 'low';
}

async function analyzeMedia(src, ff, { sceneThreshold = 0.3, silenceNoiseDb = -30, silenceMinDuration = 0.5, scopes = true } = {}) {
  if (!src || !fs.existsSync(src)) throw new Error(`Media file not found: ${src || '(empty path)'}`);
  const probe = await ff.probe(src);
  const report = { schemaVersion: 1, source: path.resolve(src), name: path.basename(src), analyzedAt: new Date().toISOString(), media: probe, video: null, audio: null, scenes: [], silence: [], warnings: [], confidence: { metadata: metadataConfidence(probe), audioMetrics: probe.hasAudio ? 'low' : 'not-applicable', sceneDetection: probe.hasVideo ? 'low' : 'not-applicable' } };
  if (probe.hasVideo) {
    try {
      const threshold = Math.max(0.05, Math.min(0.95, +sceneThreshold || 0.3));
      const events = typeof ff.detectSceneEvents === 'function'
        ? await ff.detectSceneEvents(src, threshold)
        : (await ff.detectScenes(src, threshold)).map(time => ({ time, score: null, confidence: 'low', threshold }));
      report.sceneEvents = events.filter(e => Number.isFinite(e.time) && e.time > 0 && e.time < probe.duration).sort((a, b) => a.time - b.time);
      report.scenes = [...new Set(report.sceneEvents.map(e => +e.time.toFixed(3)))];
      report.confidence.sceneDetection = report.sceneEvents.some(e => e.confidence === 'high') ? 'high' : report.sceneEvents.length ? 'medium' : 'low';
      const boundaries = [0, ...report.scenes, probe.duration].filter(Number.isFinite).sort((a,b)=>a-b);
      const eventAt = (time) => report.sceneEvents.find(e => Math.abs(e.time - time) <= 0.004);
      report.sceneSegments = boundaries.slice(0, -1).map((start, i) => {
        const end = boundaries[i + 1]; const event = eventAt(start);
        return { start: +start.toFixed(3), end: +end.toFixed(3), duration: +(end-start).toFixed(3), cutAt: i ? +start.toFixed(3) : null,
          confidence: i === 0 ? 'high' : (event?.confidence || 'low'), boundaryScore: event?.score ?? null, detectionThreshold: threshold, caption: '', transcript: '' };
      }).filter(x => x.duration > 0.02);
      report.video = { sceneCount: report.scenes.length, sceneTimesSeconds: report.scenes, sceneScores: report.sceneEvents.map(e => ({ time: e.time, score: e.score, confidence: e.confidence })), estimatedShotDurationsSeconds: report.scenes.map((t, i) => +(t - (i ? report.scenes[i - 1] : 0)).toFixed(3)) };
      try {
        const blackLog = await ff.run(['-hide_banner','-i',src,'-vf','blackdetect=d=0.1:pix_th=0.10','-an','-f','null','-']);
        report.blackSegments = [...blackLog.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)].map(m=>({start:+(+m[1]).toFixed(3),end:+(+m[2]).toFixed(3),duration:+(+m[3]).toFixed(3)}));
        if (report.blackSegments.some(x => x.duration >= 1)) report.warnings.push('One or more black-frame intervals last at least one second; check for unintended blank footage.');
      } catch (e) { report.warnings.push(`Black-frame detection unavailable: ${e.message}`); }
      try {
        const freezeLog = await ff.run(['-hide_banner','-i',src,'-vf','freezedetect=n=-50dB:d=2','-an','-f','null','-']);
        report.freezeSegments = parseTimedEvents(freezeLog, /freeze_start:\s*(-?[\d.]+)/, /freeze_end:\s*(-?[\d.]+)/);
        if (report.freezeSegments.length) report.warnings.push(`${report.freezeSegments.length} possible frozen-frame interval(s) detected; intentional holds may be valid.`);
      } catch (e) { report.warnings.push(`Freeze detection unavailable: ${e.message}`); }
    } catch (e) { report.warnings.push(`Scene detection failed: ${e.message}`); }
  }
  if (probe.hasAudio) {
    let astats = '', loudness = '';
    try { astats = await ff.run(['-hide_banner', '-i', src, '-vn', '-af', 'astats=metadata=0:reset=0', '-f', 'null', '-']); }
    catch (e) { astats = e.message || ''; }
    try { loudness = await ff.run(['-hide_banner', '-i', src, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']); }
    catch (e) { loudness = e.message || ''; }
    try { report.silence = await ff.detectSilence(src, { noiseDb: silenceNoiseDb, minDur: silenceMinDuration }); }
    catch (e) { report.warnings.push(`Silence detection failed: ${e.message}`); }
    report.audio = {
      peakDbfs: parseMetric(astats, 'Peak level dB'), rmsDbfs: parseMetric(astats, 'RMS level dB'), samplePeakDbfs: parseMetric(astats, 'Peak level dB'),
      ...parseLoudness(loudness), silenceCount: report.silence.length,
      silenceDurationSeconds: +report.silence.reduce((n, r) => n + Math.max(0, r[1] - r[0]), 0).toFixed(3),
      silenceRangesSeconds: report.silence,
    };
    report.confidence.audioMetrics = audioConfidence(report.audio);
    if (report.audio.truePeakDbfs != null && report.audio.truePeakDbfs > -1) report.warnings.push('Audio true peak is close to 0 dBFS; consider leaving more headroom.');
    if (report.audio.integratedLufs == null) report.warnings.push('Integrated loudness could not be measured by this FFmpeg build.');
  }
  if (scopes && probe.hasVideo) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-scopes-'));
    report.colorScopes = {};
    for (const [name, filter] of [['waveform', 'waveform=mode=column:scale=ire:graticule=green'], ['vectorscope', 'format=yuv444p,vectorscope=mode=color:graticule=color:flags=white'], ['histogram', 'format=yuv444p,histogram=display_mode=parade:level_height=120']]) {
      const out = path.join(dir, `${name}.png`);
      try {
        await ff.run(['-y', '-hide_banner', '-ss', '0', '-i', src, '-frames:v', '1', '-vf', `${filter},scale=640:360:force_original_aspect_ratio=decrease`, out]);
        if (fs.existsSync(out) && fs.statSync(out).size) report.colorScopes[name] = out;
      } catch (e) { report.warnings.push(`${name} scope unavailable: ${String(e.message || e).split('\n').slice(-1)[0]}`); }
    }
  }
  report.summary = {
    durationSeconds: +(+probe.duration || 0).toFixed(3), resolution: probe.width && probe.height ? `${probe.width}x${probe.height}` : null,
    hasVideo: !!probe.hasVideo, hasAudio: !!probe.hasAudio, sceneCount: report.scenes.length,
    silenceCount: report.silence.length, warningCount: report.warnings.length,
  };
  return report;
}

async function generateScopesFromFrame(framePath, ff, { outputDir } = {}) {
  if (!framePath || !fs.existsSync(framePath)) throw new Error('A rendered timeline frame is required for scopes.');
  const dir = outputDir || fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-playhead-scopes-'));
  fs.mkdirSync(dir, { recursive: true });
  const scopes = {};
  const filters = [
    ['waveform', 'waveform=mode=column:scale=ire:graticule=green'],
    ['vectorscope', 'format=yuv444p,vectorscope=mode=color:graticule=color:flags=white'],
    ['histogram', 'format=yuv444p,histogram=display_mode=parade:level_height=120'],
  ];
  for (const [name, filter] of filters) {
    const out = path.join(dir, `${name}.png`);
    await ff.run(['-y', '-hide_banner', '-i', framePath, '-frames:v', '1', '-vf', `${filter},scale=640:360:force_original_aspect_ratio=decrease`, out]);
    if (!fs.existsSync(out) || fs.statSync(out).size < 64) throw new Error(`FFmpeg did not produce the ${name} scope.`);
    scopes[name] = out;
  }
  return { scopes, directory: dir };
}

async function measureTimelineMix(timeline, ff, options = {}) {
  const tl = TL.ensure(TL.clone(timeline));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosty-mix-meter-'));
  const output = path.join(dir, 'mix-meter.mp4');
  let graph;
  try {
    graph = ff.buildExport(tl, output, { width: 320, height: 180, fps: options.fps || 12, crf: 35, audioBitrate: '96k', ...options });
    await ff.run(graph.args);
    const [stats, loudness] = await Promise.all([
      ff.run(['-hide_banner', '-i', output, '-vn', '-af', 'astats=metadata=0:reset=0', '-f', 'null', '-']),
      ff.run(['-hide_banner', '-i', output, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']),
    ]);
    const parsed = parseLoudness(loudness);
    return {
      kind: 'frosty-rendered-timeline-mix', measuredAt: new Date().toISOString(),
      durationSeconds: +graph.total.toFixed(3), peakDbfs: parseMetric(stats, 'Peak level dB'),
      rmsDbfs: parseMetric(stats, 'RMS level dB'), samplePeakDbfs: parseMetric(stats, 'Peak level dB'),
      ...parsed, measurement: 'Decoded rendered timeline output (includes clip audio, overlays, music, ducking and timeline mix processing).',
      confidence: 'high',
    };
  } finally {
    graph?.cleanup?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function analyzeTimeline(timeline, ff, options = {}) {
  const tl = TL.ensure(TL.clone(timeline));
  const sources = new Set();
  for (const group of [tl.video, tl.layers, tl.audio]) for (const item of (group || [])) if (item.src && fs.existsSync(item.src)) sources.add(item.src);
  if (tl.music?.src && fs.existsSync(tl.music.src)) sources.add(tl.music.src);
  const reports = [];
  for (const src of sources) {
    const report = await analyzeMedia(src, ff, options);
    if (options.includeTranscript && report.media?.hasAudio && typeof options.transcribe === 'function') {
      try {
        const segments = await options.transcribe(src);
        report.transcript = (Array.isArray(segments) ? segments : []).map(x => typeof x === 'string' ? { start: 0, end: report.summary?.durationSeconds || 0, text: x } : x).filter(x => x && typeof x.text === 'string').map(x => ({ start: +Number(x.start || 0).toFixed(3), end: +Number(x.end || 0).toFixed(3), text: String(x.text).slice(0, 4000) }));
        for (const scene of report.sceneSegments || []) scene.transcript = report.transcript.filter(t => t.end > scene.start && t.start < scene.end).map(t => t.text).join(' ').trim();
        report.confidence.transcript = report.transcript.length ? 'model-generated; review recommended' : 'unavailable';
      } catch (e) { report.warnings.push(`Transcript unavailable: ${e.message}`); report.confidence.transcript = 'unavailable'; }
    }
    try { const st = fs.statSync(src); report.sourceFingerprint = crypto.createHash('sha256').update(`${path.resolve(src)}|${st.size}|${Math.trunc(st.mtimeMs)}`).digest('hex'); report.file = { sizeBytes: st.size, modifiedAt: st.mtime.toISOString() }; }
    catch { report.sourceFingerprint = null; }
    reports.push(report);
  }
  const layout = TL.layout(tl);
  const total = Math.max(0, ...layout.map(x => x.end), ...(tl.layers || []).map(x => (+x.start || 0) + Math.max(0, (+x.out || 0) - (+x.in || 0))), ...(tl.audio || []).map(x => (+x.start || 0) + Math.max(0, (+x.out || 0) - (+x.in || 0))), ...(tl.text || []).map(x => (+x.start || 0) + (+x.dur || 0)));
  const missing = [];
  for (const group of ['video', 'layers', 'audio']) for (const item of tl[group] || []) if (item.src && !fs.existsSync(item.src)) missing.push({ itemId: item.id || null, path: item.src, group });
  if (tl.music?.src && !fs.existsSync(tl.music.src)) missing.push({ itemId: tl.music.id || null, path: tl.music.src, group: 'music' });
  const warnings = [];
  const clipIssues = [];
  const validationItems = ['video','layers','audio'].flatMap(group => (tl[group] || []).map(item => ({ ...item, __group: group })));
  if (tl.music?.src) validationItems.push({ ...tl.music, __group: 'music' });
  for (const item of validationItems) {
    const group = item.__group;
    const sourceDuration = Number(item.sourceDuration || item.duration || 0);
    if (item.src && !fs.existsSync(item.src)) clipIssues.push({ severity: 'error', code: 'missing-media', itemId: item.id || null, group, message: `Missing media: ${item.src}` });
    if (Number(item.out) <= Number(item.in)) clipIssues.push({ severity: 'error', code: 'invalid-trim', itemId: item.id || null, group, message: 'Clip out-point must be after its in-point.' });
    if (sourceDuration > 0 && Number(item.out) > sourceDuration + 0.05) clipIssues.push({ severity: 'warning', code: 'trim-beyond-source', itemId: item.id || null, group, message: 'Clip out-point extends beyond the known source duration.' });
    if (Number(item.speed) > 8 || Number(item.speed) > 0 && Number(item.speed) < 0.125) clipIssues.push({ severity: 'warning', code: 'extreme-speed', itemId: item.id || null, group, message: 'Playback speed is outside the recommended 0.125×–8× range.' });
  }
  const sourceDurations = new Map(reports.map(r => [path.resolve(r.source), Number(r.summary?.durationSeconds || 0)]));
  for (const item of validationItems) {
    const group = item.__group;
    const duration = sourceDurations.get(path.resolve(item.src || ''));
    if (duration > 0 && Number.isFinite(Number(item.out)) && Number(item.out) > duration + 0.05 && !clipIssues.some(x => x.itemId === (item.id || null) && x.code === 'trim-beyond-source')) clipIssues.push({ severity: 'warning', code: 'trim-beyond-source', itemId: item.id || null, group, message: `Clip out-point (${item.out}s) exceeds source duration (${duration}s).` });
  }
  if (missing.length) warnings.push(`${missing.length} timeline media reference(s) are missing.`);
  if (clipIssues.length) warnings.push(`${clipIssues.length} clip validation issue(s) detected.`);
  if (!layout.length && !(tl.layers || []).length && !(tl.text || []).length) warnings.push('Timeline appears to be empty.');
  const loudness = reports.map(r => r.audio?.integratedLufs).filter(Number.isFinite);
  return { schemaVersion: 1, kind: 'frosty-timeline-analysis', analyzedAt: new Date().toISOString(), timeline: { mode: tl.mode || 'sequential', durationSeconds: +total.toFixed(3), frameRate: TL.frameRateString(tl), videoClipCount: (tl.video || []).length, overlayCount: (tl.layers || []).length, audioClipCount: (tl.audio || []).length, textOverlayCount: (tl.text || []).length, sourceCount: sources.size }, mediaReports: reports, missingMedia: missing, warnings, aggregate: { meanSourceIntegratedLufs: loudness.length ? +(loudness.reduce((a,b)=>a+b,0)/loudness.length).toFixed(2) : null, totalDetectedSilenceSeconds: +reports.reduce((n,r)=>n+(r.audio?.silenceDurationSeconds||0),0).toFixed(3), totalDetectedScenes: reports.reduce((n,r)=>n+r.scenes.length,0), totalBlackSeconds: +reports.reduce((n,r)=>n+(r.blackSegments||[]).reduce((a,x)=>a+x.duration,0),0).toFixed(3), totalFreezeSegments: reports.reduce((n,r)=>n+(r.freezeSegments||[]).length,0) }, clipIssues, confidence: { timelineStructure: 'high', aggregateLoudness: loudness.length ? 'medium' : 'low', sceneCounts: 'medium' } };
}
module.exports = { analyzeMedia, analyzeTimeline, generateScopesFromFrame, measureTimelineMix, parseMetric, parseLoudness, parseTimedEvents, confidenceLabel, metadataConfidence, audioConfidence, exportReport };
