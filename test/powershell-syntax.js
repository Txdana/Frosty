'use strict';
// Regression: every PowerShell script must parse. A single bad token (for example "$name:" inside a
// double-quoted string) makes the whole script unusable, which silently broke `npm run dist`.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

function listScripts(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'bin', 'obj'].includes(entry.name) || entry.name.startsWith('build-')) continue;
      listScripts(full, out);
    } else if (entry.name.endsWith('.ps1')) out.push(full);
  }
  return out;
}

const shells = process.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh'];
const shell = shells.find(name => {
  const probe = spawnSync(name, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
});
if (!shell) {
  console.log('PowerShell syntax check skipped: no pwsh/powershell found on PATH.');
  process.exit(0);
}

const parser = '$f=$env:FROSTY_PS_FILE;$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$t,[ref]$e);' +
  'if($e.Count){$e|ForEach-Object{"line $($_.Extent.StartLineNumber): $($_.Message)"};exit 1}';
const failures = [];
const scripts = listScripts(root);
for (const file of scripts) {
  const result = spawnSync(shell, ['-NoProfile', '-Command', parser], { encoding: 'utf8', env: { ...process.env, FROSTY_PS_FILE: file, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' } });
  if (result.status !== 0) failures.push(`${path.relative(root, file)}\n${(result.stdout || result.stderr || '').trim()}`);
}
if (failures.length) {
  console.error(`PowerShell syntax errors:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`PowerShell syntax check passed for ${scripts.length} scripts (${shell}).`);
