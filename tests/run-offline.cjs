'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const withStream = process.argv.includes('--with-stream');

const suites = [
  'malformed-regression.cjs',
  'binary-regression.cjs',
  'body-limit-regression.cjs'
];
if (withStream) {
  suites.push('stream-lifecycle-regression.cjs');
}

function cleanupTempOutputs() {
  for (const entry of fs.readdirSync(__dirname, { withFileTypes: true })) {
    const fullPath = path.join(__dirname, entry.name);
    if (entry.isDirectory() && (entry.name.includes('-mock-') || entry.name.includes('-regression-'))) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      fs.rmSync(fullPath, { force: true });
    }
  }
}

try {
  cleanupTempOutputs();
  for (const suite of suites) {
    const scriptPath = path.join(__dirname, suite);
    console.log(`\n=== Running ${suite} ===`);
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CPA_TEST_ASSERT: '1' }
    });
    if (result.status !== 0) {
      throw new Error(`${suite} failed with exit code ${result.status}`);
    }
  }
  console.log('\nALL_OFFLINE_SUITES_PASSED');
} finally {
  cleanupTempOutputs();
}
