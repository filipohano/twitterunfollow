// Small shared helpers: logging, randomness and an interruptible sleep so that
// Ctrl+C / `docker stop` ends long waits immediately.

const waiters = new Set();
let stopRequested = false;

export const isStopping = () => stopRequested;

export function requestStop() {
  stopRequested = true;
  for (const wake of [...waiters]) wake();
}

export function resetStop() {
  stopRequested = false;
}

export function sleep(ms) {
  if (stopRequested || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      waiters.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    waiters.add(wake);
  });
}

export const randBetween = (min, max) => min + Math.random() * (max - min);

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

export function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}
