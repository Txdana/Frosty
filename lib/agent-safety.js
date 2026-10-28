'use strict';
const crypto = require('crypto');
const mediaWorkflow = require('./media-workflow');

const DEFAULT_PERMISSIONS = Object.freeze({ web: false, downloads: false, imageGeneration: false });
function normalizePermissions(input = {}) {
  return Object.fromEntries(Object.keys(DEFAULT_PERMISSIONS).map(k => [k, input[k] === true]));
}
function snapshot(timeline) { return JSON.parse(JSON.stringify(timeline || {})); }
function fingerprint(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function summarizeDiff(before, after) {
  const groups = ['video', 'layers', 'audio', 'text'];
  const diff = { added: [], removed: [], changed: [], unchanged: 0, beforeHash: fingerprint(before), afterHash: fingerprint(after) };
  for (const group of groups) {
    const a = new Map((before?.[group] || []).filter(Boolean).map(x => [String(x.id || `${group}:${JSON.stringify(x)}`), x]));
    const b = new Map((after?.[group] || []).filter(Boolean).map(x => [String(x.id || `${group}:${JSON.stringify(x)}`), x]));
    for (const [id, item] of b) {
      if (!a.has(id)) diff.added.push({ group, id, name: item.name || item.text || item.title || id });
      else if (JSON.stringify(a.get(id)) !== JSON.stringify(item)) diff.changed.push({ group, id, name: item.name || item.text || item.title || id });
      else diff.unchanged++;
    }
    for (const [id, item] of a) if (!b.has(id)) diff.removed.push({ group, id, name: item.name || item.text || item.title || id });
  }
  if (JSON.stringify(before?.music ?? null) !== JSON.stringify(after?.music ?? null)) diff.changed.push({ group: 'music', id: 'music', name: 'Background music' });
  if (JSON.stringify(before?.settings ?? null) !== JSON.stringify(after?.settings ?? null)) diff.changed.push({ group: 'settings', id: 'settings', name: 'Project settings' });
  return diff;
}
function validateEdit(before, after) {
  const validation = mediaWorkflow.validateTimeline(after);
  const diff = summarizeDiff(before, after);
  return { valid: validation.valid, errors: validation.errors, warnings: validation.warnings, diff, verified: validation.valid && diff.afterHash === fingerprint(after) };
}
function permissionForTool(toolName, permissions) {
  const p = normalizePermissions(permissions);
  if (['web_search', 'web_read'].includes(toolName)) return p.web;
  if (toolName === 'download_media') return p.downloads;
  if (toolName === 'generate_image') return p.imageGeneration;
  return true;
}
module.exports = { DEFAULT_PERMISSIONS, normalizePermissions, snapshot, fingerprint, summarizeDiff, validateEdit, permissionForTool };
