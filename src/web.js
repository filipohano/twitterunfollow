#!/usr/bin/env node
// Entry point of the dashboard container: password-protected website that runs the bot in the background.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.js';
import { Runner } from './runner.js';
import { createApp } from './server.js';
import { log } from './util.js';

const MIN_PASSWORD = 12;
const COMMON = new Set(['password', 'passw0rd', 'password123', 'password1234', 'letmein', 'qwertyuiop', 'qwerty123456', 'iloveyou', 'administrator', 'welcome123', 'changeme123', 'unfollowbot', 'twitterunfollow']);
const password = process.env.UI_PASSWORD || '';
const weak = password.length < MIN_PASSWORD || new Set(password).size < 5 || COMMON.has(password.toLowerCase().replace(/[^a-z0-9]/g, ''));
if (weak) {
  console.error(`UI_PASSWORD is required, must be at least ${MIN_PASSWORD} characters and not a common password. It protects the page that holds the keys to your X account. (Run ./start-web.sh --reset-password to choose a new one.)`);
  process.exit(1);
}

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
const dataDir = process.env.DATA_DIR || './data';
const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const runner = new Runner({ dataDir });
const allowedHosts = (process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const trustProxy = process.env.TRUST_PROXY === '1';
const server = http.createServer(createApp({ runner, auth: createAuth({ password }), webDir, dataDir, allowedHosts, trustProxy }));
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.listen(port, host, () => {
  log(`Dashboard listening on http://${host}:${port}`);
  runner.autoResume();
});

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) process.exit(130);
    closing = true;
    log(`${sig} received: stopping the bot cleanly, then exiting.`);
    server.close();
    await runner.shutdown();
    process.exit(0);
  });
}
