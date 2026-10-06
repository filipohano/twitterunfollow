#!/usr/bin/env node
import { ConfigError, loadConfig } from './config.js';
import { run } from './bot.js';
import { FatalError } from './x.js';
import { log, requestStop } from './util.js';

let signals = 0;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (++signals > 1) process.exit(130);
    log(`${sig} received: finishing up (send it again to force quit). Progress is saved.`);
    requestStop();
  });
}

try {
  const summary = await run(loadConfig());
  log(`Finished: ${summary.status}. Unfollowed ${summary.unfollowed} account(s) this run.`);
  if (summary.skipped.length) log(`Could not unfollow: ${summary.skipped.map((h) => `@${h}`).join(', ')}`);
  if (summary.status === 'rate-limited') process.exitCode = 2;
  else if (summary.skipped.length) process.exitCode = 1;
} catch (e) {
  if (e instanceof ConfigError || e instanceof FatalError) {
    log(`ERROR: ${e.message}`);
    process.exitCode = e.exitCode ?? 1;
  } else {
    console.error(e);
    process.exitCode = 1;
  }
}
