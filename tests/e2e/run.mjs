/** Start a disposable production-configured instance, then run the browser suite.
 * No fixed password, auth bypass, demo adapter, or existing user profile is used.
 */
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localModelEnvironment } from './environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.LA_E2E_PYTHON || 'python3';
const localModel = localModelEnvironment(process.env);
const dataDir = await mkdtemp(path.join(tmpdir(), 'little-archive-e2e-'));
const ownerPassword = randomBytes(36).toString('base64url');
const port = await new Promise((resolve, reject) => {
  const socket = createServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const assigned = socket.address().port;
    socket.close(error => error ? reject(error) : resolve(assigned));
  });
});
const baseURL = `http://127.0.0.1:${port}`;
const environment = {
  ...process.env,
  PYTHONUNBUFFERED: '1',
  LA_DATA_DIR: dataDir,
  LA_ADMIN_PASSWORD: ownerPassword,
  LA_PUBLIC_URL: baseURL,
  ...localModel,
  LA_E2E_BASE_URL: baseURL,
  LA_E2E_OWNER_PASSWORD: ownerPassword,
  LA_E2E_DATA_DIR: dataDir,
  LA_E2E_PYTHON: python,
};

let server;
let runner;
let serverLog = '';
let interrupted = false;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const redact = value => String(value).replaceAll(ownerPassword, '[ephemeral credential]').replace(/[A-Za-z0-9_-]{43,}/g, '[redacted ephemeral value]');
const record = chunk => {
  // Bounded failure diagnostics. Never write the generated credential to artifacts.
  serverLog = (serverLog + String(chunk)).slice(-150_000);
};
const relay = (stream, destination) => {
  let pending = '';
  stream.on('data', chunk => {
    pending += String(chunk);
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      destination.write(redact(pending.slice(0, end + 1)));
      pending = pending.slice(end + 1);
    }
  });
  stream.on('end', () => { if (pending) destination.write(redact(pending)); });
};
const stop = async processHandle => {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  processHandle.kill('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (processHandle.exitCode === null && processHandle.signalCode === null && Date.now() < deadline) await wait(50);
  if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill('SIGKILL');
};
const onSignal = () => {
  interrupted = true;
  runner?.kill('SIGTERM');
  server?.kill('SIGTERM');
};
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

let result = 1;
try {
  server = spawn(python, [
    '-m', 'uvicorn', 'server.app:create_app', '--factory', '--host', '127.0.0.1',
    '--port', String(port), '--workers', '1', '--log-level', 'warning', '--no-access-log',
  ], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverError;
  server.once('error', error => { serverError = error; });
  server.stdout.on('data', record);
  server.stderr.on('data', record);
  const deadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < deadline && !interrupted) {
    if (serverError) throw serverError;
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('The isolated server exited before becoming ready.');
    try {
      const health = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (health.ok && (await health.json()).status === 'ok') { ready = true; break; }
    } catch { /* The socket is not listening yet. */ }
    await wait(150);
  }
  if (!ready) throw new Error('The isolated server did not become ready before the startup deadline.');
  console.log('Isolated Little Archive is ready. Running real-browser regression tests.');
  // Invoke the installed exact-version runner directly, without npx downloads.
  runner = spawn(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', ...process.argv.slice(2)], {
    cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay(runner.stdout, process.stdout);
  relay(runner.stderr, process.stderr);
  result = await new Promise((resolve, reject) => {
    runner.once('error', reject);
    runner.once('exit', code => resolve(code ?? 1));
  });
} catch (error) {
  console.error(redact(error.message));
} finally {
  await stop(runner);
  await stop(server);
  if (result !== 0 && serverLog) {
    await mkdir(path.join(root, 'test-results'), { recursive: true });
    await writeFile(path.join(root, 'test-results/e2e-server.log'), redact(serverLog), { mode: 0o600 });
    console.error('Server diagnostics saved to test-results/e2e-server.log.');
  }
  const reports = spawnSync(python, [path.join(root, 'tests/e2e/sanitize_results.py'), root], { cwd: root, env: environment, encoding: 'utf8' });
  if (reports.status !== 0) {
    // Fail closed: no report should be uploaded if sanitization could not finish.
    await rm(path.join(root, 'playwright-report'), { recursive: true, force: true });
    await rm(path.join(root, 'test-results'), { recursive: true, force: true });
    console.error('Could not sanitize browser results; removed artifacts and failed the run.');
    result = 1;
  }
  await rm(dataDir, { recursive: true, force: true });
}
process.exitCode = interrupted ? 130 : result;
