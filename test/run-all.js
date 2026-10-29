'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..');
const tests = [
  'smoke.js', 'ffmpeg-license-boundary.js', 'effect-stack-static.js', 'effect-stack-runtime.js', 'media-workflow.js',
  'analysis-static.js', 'color-audio-production.js', 'scene-index.js', 'embedding-client.js',
  'brag-reach.js', 'agent-safety.js', 'frame-preview-playback.js', 'sequence-render-runtime.js',
  'bezier-mask-runtime.js', 'project-format.js', 'native-installer-timeline.js',
  'native-transform-render.js', 'native-ai-planner.js', 'reference-template.js', 'reference-template-runtime.js', 'reference-comparator-runtime.js', 'motion-reference-integration.js', 'motion-design.js', 'motion-integration-static.js', 'powershell-syntax.js'
];
function run(command, args, label, options = {}) {
  console.log(`\n[TEST] ${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', encoding: 'utf8', ...options });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
}
function python() {
  const options = process.platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
  for (const [command, prefix] of options) {
    const probe = spawnSync(command, [...prefix, '--version'], { cwd: root, stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return { command, prefix };
  }
  throw new Error('Python 3 is required for the WPF/GPU static integration checks.');
}
function nativeBuild() {
  const configuration = 'Release';
  // Reuse a dedicated Release build tree so reruns are incremental; Windows E2E separately performs a fresh MSVC build and WPF publish.
  const build = path.join(root, 'native', 'build-p2');
  const args = ['-S', 'native', '-B', build, `-DCMAKE_BUILD_TYPE=${configuration}`];
  const boostCandidates = [
    process.env.Boost_INCLUDE_DIR,
    process.env.BOOST_INCLUDE_DIR,
    process.env.BOOST_ROOT,
    process.env.BOOST_ROOT ? path.join(process.env.BOOST_ROOT, 'include') : null,
    process.env.VCPKG_ROOT ? path.join(process.env.VCPKG_ROOT, 'installed', 'x64-windows', 'include') : null,
    process.env.VCPKG_INSTALLATION_ROOT ? path.join(process.env.VCPKG_INSTALLATION_ROOT, 'installed', 'x64-windows', 'include') : null
  ].filter(Boolean);
  const boostInclude = boostCandidates.find(candidate => fs.existsSync(path.join(candidate, 'boost', 'property_tree', 'ptree.hpp')));
  if (boostInclude) args.push(`-DBoost_INCLUDE_DIR=${boostInclude}`, '-DBoost_NO_BOOST_CMAKE=ON');
  run('cmake', args, 'Configure native C++ engine');
  run('cmake', ['--build', build, '--config', configuration, '--parallel', '2'], 'Build native C++ engine and AI integration tests');
  run('ctest', ['--test-dir', build, '-C', configuration, '--output-on-failure'], 'Run native CTest suite');
}
function windowsSmoke() {
  if (process.platform !== 'win32') return;
  const powershell = process.env.POWERSHELL || 'powershell.exe';
  run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join('test', 'windows-e2e.ps1')], 'Publish WPF app and launch Windows self-test smoke test');
}
(async () => {
  try {
    for (const test of tests) run(process.execPath, [path.join('test', test)], `Node regression: ${test}`);
    const py = python();
    run(py.command, [...py.prefix, path.join('test', 'native-wpf-static.py')], 'Validate WPF XAML/native ABI/static wiring');
    run(py.command, [...py.prefix, path.join('test', 'gpu-preview-static.py')], 'Validate Direct3D GPU preview integration');
    nativeBuild();
    windowsSmoke();
    console.log('\nAll Frosty test gates passed. A Windows app smoke test is run automatically on Windows; Linux results do not certify Windows/WPF runtime behavior.');
  } catch (error) {
    console.error(`\nTEST GATE FAILED: ${error.message}`);
    process.exitCode = 1;
  }
})();
