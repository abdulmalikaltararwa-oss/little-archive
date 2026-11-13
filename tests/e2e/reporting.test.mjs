import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('failure reports redact ephemeral credentials, escape error HTML and remove binary captures', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'archive-report-check-'));
  const password = randomBytes(36).toString('base64url');
  const session = randomBytes(32).toString('base64url');
  try {
    const results = path.join(root, 'test-results');
    mkdirSync(results);
    writeFileSync(path.join(results, 'results.xml'), `<testsuites><testsuite><testcase name="Synthetic failure" classname="chromium" time="1"><failure>Fill ${password} and csrf ${session}; &lt;img src=x&gt;</failure></testcase></testsuite></testsuites>`);
    writeFileSync(path.join(results, 'server.log'), `password=${password}\nsession=${session}\n`);
    writeFileSync(path.join(results, 'trace.zip'), Buffer.from('binary capture is not a publishable artifact'));
    execFileSync(process.env.LA_E2E_PYTHON || 'python3', [fileURLToPath(new URL('./sanitize_results.py', import.meta.url)), root], { env: { ...process.env, LA_E2E_OWNER_PASSWORD: password }, stdio: 'pipe' });
    const xml = readFileSync(path.join(results, 'results.xml'), 'utf8');
    const log = readFileSync(path.join(results, 'server.log'), 'utf8');
    const report = readFileSync(path.join(root, 'playwright-report/index.html'), 'utf8');
    for (const text of [xml, log, report]) {
      assert.equal(text.includes(password), false);
      assert.equal(text.includes(session), false);
    }
    assert.equal(existsSync(path.join(results, 'trace.zip')), false);
    assert.match(report, /Synthetic failure/);
    assert.match(report, /1 failed/);
    assert.match(report, /&lt;img src=x&gt;/);
    assert.doesNotMatch(report, /<img src=x>/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
