// Rolling-window action limiter. Remembers when each unfollow happened so the
// hourly/daily caps keep holding across container restarts (state lives in /data).

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export class RateLimiter {
  constructor({ perHour, perDay, actions = [] }) {
    this.perHour = perHour;
    this.perDay = perDay;
    this.actions = actions.filter(Number.isFinite).sort((a, b) => a - b);
  }

  prune(now) {
    // Timestamps "in the future" mean the clock stepped backwards (RTC-less server, VM resume, NTP fix).
    // Keep them, clamped to now: dropping them would forget recent activity and allow a fresh full quota.
    this.actions = this.actions.map((t) => Math.min(t, now)).filter((t) => t > now - DAY);
  }

  record(now = Date.now()) {
    this.actions.push(now);
    this.prune(now);
  }

  countIn(windowMs, now) {
    return this.actions.filter((t) => t > now - windowMs).length;
  }

  // Milliseconds to wait before one more action is allowed (0 = go ahead).
  waitMs(now = Date.now()) {
    this.prune(now);
    let wait = 0;
    for (const [windowMs, cap] of [[HOUR, this.perHour], [DAY, this.perDay]]) {
      const inWindow = this.actions.filter((t) => t > now - windowMs);
      if (inWindow.length >= cap) {
        // The action that must age out is the (count - cap + 1)-th oldest in the window.
        const blocking = inWindow[inWindow.length - cap];
        wait = Math.max(wait, blocking + windowMs - now);
      }
    }
    return Math.max(0, Math.ceil(wait));
  }

  usage(now = Date.now()) {
    return { hour: this.countIn(HOUR, now), day: this.countIn(DAY, now) };
  }
}
