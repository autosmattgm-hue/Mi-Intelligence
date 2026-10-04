'use strict';

/* ============================================================================
   MI — Launch on a LIVE (public) server in one command.
   ----------------------------------------------------------------------------
   1. Ensures the local MI server is running (probes GET /api/health).
   2. Opens a PUBLIC https://*.loca.lt tunnel to it — free, NO account needed.
   3. Prints the LIVE URL and opens it in your default browser.
   4. Keep this window open = the link stays live. Close it = tunnel stops.

   Works on Windows + macOS + Linux (Node 18+, zero npm dependencies).

   Usage:
     npm run live            (or)   node tools/live.js
   ========================================================================== */

const { spawn } = require('node:child_process');
const path = require('path');

const PORT = Number(process.env.PORT || 3009);
const LOCAL = 'http://localhost:' + PORT;
const NPX_CLI = process.env.NPX_CLI
  || path.join('C:', path.sep, 'Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npx-cli.js');
const URL_RE = /https:\/\/[a-z0-9-]+\.loca\.lt/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverUp() {
  try {
    const r = await fetch(LOCAL + '/api/health', { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

async function ensureServer() {
  if (await serverUp()) {
    console.log('■ MI server is already running on ' + LOCAL);
    return;
  }
  console.log('■ Starting MI server on ' + LOCAL + ' ...');
  try {
    spawn('node', ['server/index.js'], { cwd: path.join(__dirname, '..') });
  } catch (e) {
    throw new Error('Could not start the server: ' + e.message);
  }
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (await serverUp()) { console.log('■ MI server started.'); return; }
  }
  throw new Error('MI server did not come up on ' + LOCAL);
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url], { windowsVerbatimArguments: true });
    else if (process.platform === 'darwin') spawn('/usr/bin/open', [url]);
    else spawn('xdg-open', [url]);
  } catch { /* optional */ }
}

async function runTunnel() {
  console.log('■ Creating public tunnel (localtunnel) ...');
  let child;
  try {
    child = spawn('node', [NPX_CLI, '--yes', 'localtunnel', '--port', String(PORT)], { stdout: 'pipe', stderr: 'pipe' });
  } catch (e) {
    throw new Error('Could not start localtunnel: ' + e.message + '\nRun it again — the first run downloads the tunnel client.');
  }
  const stdout = child.stdout, stderr = child.stderr;
  let buf = '';
  let found = false;
  const onData = (chunk) => {
    buf += chunk.toString();
    if (found) return;
    const m = buf.match(URL_RE);
    if (m) {
      found = true;
      const url = m[0];
      console.log('');
      console.log('  🎉  MI IS LIVE ON THE PUBLIC INTERNET');
      console.log('  ─────────────────────────────────────────────────');
      console.log('  ▶  OPEN  ' + url);
      console.log('  ─────────────────────────────────────────────────');
      console.log('');
      console.log('  Share that link with anyone. Keep this window open.');
      console.log('  Close the window to stop the live server.\n');
      openBrowser(url);
    }
  };
  if (stdout) stdout.on('data', onData);
  if (stderr) stderr.on('data', onData);
  // Wait up to 90s for the public URL (first run downloads the client).
  for (let i = 0; i < 90 && !found; i++) await sleep(1000);
  if (!found) {
    console.error('Timed out waiting for the tunnel URL.\nLast output:\n' + buf.slice(-600));
    process.exitCode = 1;
    return;
  }
  // Keep this process alive — the window must stay open for the tunnel.
  for (;;) await sleep(60000);
}

(async () => {
  console.log('══════════════════════════════════════════════');
  console.log('  MI — Master Intelligence · GO LIVE');
  console.log('══════════════════════════════════════════════');
  try {
    await ensureServer();
    await runTunnel();
  } catch (e) {
    console.error('Error: ' + e.message);
    process.exitCode = 1;
  }
})();