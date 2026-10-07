# twitterunfollow

Unfollows everyone on your X/Twitter account, slowly enough not to trip rate limits.

- **No X API key.** It drives a real (headless) Chromium through the website using your logged-in session cookies.
- **A website you host yourself.** Open the page, paste your cookies, press a button, close the tab. The bot keeps
  working on your server; come back any time to check progress.
- **Runs in Docker.** One container, one command to install.

---

## Simplest option: a script you run in your own Chrome

No server, no Docker, no cookies leaving your computer. `browser/unfollow-all.js` is one file that you paste into Chrome
while you are logged in to x.com. It adds a small control panel (in Norwegian) to the page and clicks X's own
"Following" buttons for you, from your own IP address and your own session.

1. Go to `https://x.com/YOUR_HANDLE/following` (your **own** page; the script refuses to run anywhere else).
2. Press **F12** (Mac: **Cmd+Option+I**) → **Sources** → **Snippets** → **+ New snippet**, paste the whole of
   [`browser/unfollow-all.js`](browser/unfollow-all.js) (raw:
   `https://raw.githubusercontent.com/filipohano/twitterunfollow/claude/fervent-hopper-yq9efx/browser/unfollow-all.js`),
   and press **Ctrl+Enter** (Mac: **Cmd+Enter**). In the plain Console Chrome first asks you to type `allow pasting`.
3. Press **Forhåndsvis** (preview), check the numbers, add handles to keep, pick a speed, then press **Start** twice.
4. Keep the tab in its own visible window (Chrome slows hidden tabs down a lot). Progress is remembered in the browser,
   so you can stop and run it again later.

| Speed | Pause between unfollows | Caps (rolling) | About 1,000 accounts takes |
| --- | --- | --- | --- |
| Forsiktig | 15–45 s, break every 20 | 30 per hour, 150 per day | ~7 days |
| **Normal** (default) | 8–20 s, break every 30 | 60 per hour, 200 per day | ~5 days |
| Rask (high risk) | 4–10 s, break every 50 | 100 per hour, 300 per day | ~3–4 days |

The limit is X's tolerance, not the script. X publishes no unfollow limit, so these are judgement calls: community
reports call 100–150 per day safe and 300–400 per day high risk, so **Rask** is on the edge. The faster the speed, the
higher the chance X restricts the account. Automating the website goes against X's Terms of Service.

What the script does to stay out of trouble:

- Runs only on **your own** `/handle/following` page (on someone else's page the buttons would be your follows).
- Clicks the account's own unfollow button, then only confirms a dialog that names that exact `@handle`; it checks the
  keep list again right before every click, and reads X's answer to confirm the right account was unfollowed.
- Stops by itself the moment X answers "too many requests", "unable to follow/unfollow" or anything unexpected, and
  then refuses to start again for about an hour (remembered across page reloads). It also stops if X receives an
  unfollow it didn't ask for (for example from a second tab).
- Hour and day caps are counted in memory and in the browser's storage, so they hold even if storage is damaged.
- Tolerant keep list: handles separated by lines, spaces, commas or semicolons, with or without `@`, or pasted as x.com
  URLs. Anything unclear is treated as "keep". Preview shows keep-list entries it couldn't find (typos).

Like everything here it has been tested in a real browser against a mock of X's following page (including X's newer
one-item unfollow menu, instant button flips, slow-loading lists and refusals), not against a live account. If X's
page has changed in a way the script doesn't understand, it stops with an explanation instead of guessing.

Tips: in Snippets you may have to type `allow pasting` first; if the panel says it can't tell who you are, the window is
too narrow (X hides its left menu), so make it wider or undock DevTools into its own window.

---

## Install on your Ubuntu server (the whole thing)

You need: a server with **Docker already installed**, about **6 GB free disk space** and **2 GB RAM**
(the bot runs a real browser), and your X account logged in somewhere on your own computer.

### 1. Log in to your server

From your own computer (Windows 10/11, Mac and Linux all have `ssh` built in):

```bash
ssh YOUR_USER@YOUR_SERVER_ADDRESS
```

### 2. Download the bot

```bash
git clone -b claude/fervent-hopper-yq9efx https://github.com/filipohano/twitterunfollow.git
cd twitterunfollow
```

(If it says `git: command not found`: `sudo apt update && sudo apt install -y git`, then try again.)

### 3. Install and start it

```bash
./start-web.sh
```

It builds everything (the first time takes **5–10 minutes**), starts it, and at the end tells you exactly how to
open the page. It asks two things first:

1. **Who can open the page.**
   - **1 – only you, via an SSH tunnel (recommended, just press Enter).** The page is invisible to the network. When you
     want to use it, run this on *your own computer* and leave the window open, then browse to <http://localhost:8080>:
     ```bash
     ssh -L 8080:localhost:8080 YOUR_USER@YOUR_SERVER_ADDRESS
     ```
   - **2 – reachable over the network.** Browse to `http://YOUR_SERVER_ADDRESS:8080`. This is **plain http**, so your
     password and cookies travel unencrypted. Only use it on a private home/office network or a VPN such as
     Tailscale. Docker ignores `ufw` rules for ports it publishes, so don't assume `ufw` hides it. (If you open it by a
     domain name instead of the IP and see *Host not allowed*, add `ALLOWED_HOSTS=your.domain` to the `.web-env` file and
     run `./start-web.sh` again.)
2. **A password for the dashboard.** At least 12 plain characters. Nothing shows while you type; that's normal. **Press
   Enter without typing anything to get a strong random password**, shown once at the end (save it in a password manager;
   `./start-web.sh show-password` prints it again).

If it says *permission denied* about Docker, the script falls back to `sudo` and may ask for your server password.
Options if you need them: `--private`, `--public`, `--port 8081`, `--reset-password`.

### 4. Use the dashboard

1. Open the page and log in with your password.
2. **Get your X cookies** (the page explains this too). On your own computer, log in to <https://x.com>, press **F12**
   (Mac Chrome: **Cmd+Option+I**), open **Application** (Firefox: **Storage**) → **Cookies** → `https://x.com`, and copy the
   **Value** of `auth_token` and of `ct0`. Paste them into **Settings** and press **Save settings**.
3. Optional: add accounts you want to **keep following** (one handle per line) under *Never unfollow these accounts*.
4. Press **Preview (nothing is unfollowed)** first. It lists who would be unfollowed and changes nothing.
5. Press **Unfollow everyone**, confirm, and you can close the tab. Come back whenever you like: the page shows how many
   are done, usage against your limits, whether the bot is resting, and a live log. **Stop** pauses it any time.
   **Download full list (CSV)** gives you everyone that was unfollowed.

> The two cookies are equivalent to being logged in as you. They are stored only on your server (in a Docker volume,
> file mode 600) and are never shown again by the page. **Forget my cookies** deletes them. Logging out of x.com in the
> browser you copied them from also makes them useless.

### Everyday commands (on the server, inside the `twitterunfollow` folder)

| Command | What it does |
| --- | --- |
| `./start-web.sh` | Install, update to the latest code, or start again. Safe to repeat. |
| `./start-web.sh logs` | Show what the bot is doing (Ctrl+C to leave). |
| `./start-web.sh stop` | Stop the dashboard. |
| `./start-web.sh show-password` | Print the dashboard password. |
| `./start-web.sh --reset-password` | Choose a new dashboard password. |
| `./start-web.sh uninstall` | Remove it (asks what to delete, including the ~3.5 GB browser image). |

It restarts by itself after a server reboot, and an unfollow run that was in progress **resumes automatically**.
(That also happens after `./start-web.sh stop`; to really end a run, press **Stop** on the page first.) After a restart
or update you simply log in again.

To update later: `cd twitterunfollow && git pull && ./start-web.sh`.

---

## How it avoids rate limits

X doesn't publish exact unfollow limits, so the defaults are conservative: community reports put soft limits at
roughly 150–200 unfollows per day. All of them can be changed on the page under *Speed limits* (within safe maximums).

| Mechanism | Default |
| --- | --- |
| Random pause between unfollows | 15–45 s |
| Longer break after every 20 unfollows | 3–6 min |
| Hard cap, rolling 1 hour | 30 |
| Hard cap, rolling 24 hours | 150 |
| On HTTP 429 / "limit reached" | exponential backoff from 15 min (honours X's reset time), doubling up to 4 h |
| Give up after repeated limit hits | after 5 in a row; shows "paused", press the button to try again later |
| Unexpected errors (network blip, browser crash, frozen page) | detected and retried automatically, up to 5 times |

The caps are counted from saved history, so they still hold after restarts (and the history is rebuilt from the
unfollow log if its file is ever damaged). A big list simply takes days (1,000 accounts ≈ 7 days at the defaults).

Safety checks built in: the bot clicks each account's own unfollow button (never a lookalike link inside someone's
bio), backs out if X's confirmation names a different account, and never says "done" unless the profile's *Following*
count agrees that the list is really empty. If X shows a login wall, a verification page or a changed layout, it
stops with an explanation instead of pretending everything is fine.

## Things worth knowing

- **Server IP vs. your IP.** You copy cookies from your home/work browser but the bot uses them from the server. If
  the server is in a different country or on a data-centre IP range, X may treat the session as suspicious, ask you to
  verify, or log it out. If that happens the page shows *Not logged in*: log in again in your browser and paste fresh cookies.
  A server on your own network is the safest place to run this.
- **Not verified against live x.com.** The bot relies on X's `data-testid` attributes and its internal
  `friendships/destroy` call (all in `src/x.js`). Independent open-source projects and live captures from 2026 show X's
  site still uses them, and the bot is tested end-to-end in a real browser against a mock of X's following page (also
  inside the Docker image), but it has not been run against a real account. **Use Preview first** to confirm it can see
  your list.
- Automating the website goes against X's Terms of Service. Use it on your own account only.
- Wrong dashboard passwords lock out *that address* for a while (30 s, doubling each time, up to 1 h); other addresses
  are unaffected. The dashboard password is kept in plain text in `.web-env` (readable only by you) and, like any Docker
  environment variable, shows up in `docker inspect`; don't paste that output anywhere public.
- The container runs as an unprivileged user with all Linux capabilities dropped.

## Troubleshooting

| You see | Do this |
| --- | --- |
| The page won't load | Option 1: is the `ssh -L …` window still open? Run `./start-web.sh logs` on the server. |
| *Host not allowed* | You opened it by a domain name. Add `ALLOWED_HOSTS=that.name` to `.web-env`, run `./start-web.sh`. |
| *Port 8080 is already used* | `./start-web.sh --port 8081` (and use 8081 in the ssh command / address). |
| *Not logged in* on the page | The cookies expired or you logged out of x.com. Copy fresh ones. |
| *Paused because of X rate limits* | Nothing is wrong; wait a few hours and press **Unfollow everyone** again. |
| *The bot could not read your whole list* | X stopped showing the list part-way. Try again later. |
| Build fails / out of space | `df -h` (need ~6 GB free). `docker system prune` frees old images. |
| Forgot the dashboard password | `./start-web.sh show-password`, or `./start-web.sh --reset-password` |

---

## Command-line mode (no website)

Everything also works without the dashboard:

```bash
cp .env.example .env          # paste auth_token and ct0 into it, no quotes
docker build -t twitter-unfollow .
mkdir -p data
# preview only (writes data/would-unfollow.txt)
docker run --rm --init --user root --env-file .env -e DRY_RUN=true -v "$PWD/data:/data" twitter-unfollow node src/cli.js
# the real run
docker run --rm --init --user root --env-file .env -v "$PWD/data:/data" twitter-unfollow node src/cli.js
```

(`--user root` lets the container write into your `data` folder; the dashboard setup does not need it.) All options
(keep list, pacing, caps, backoff) are documented in `.env.example`. Exit codes: `0` finished/stopped, `1` error (bad
config, expired cookies, locked account, X's UI changed), `2` gave up after repeated rate limits (progress is saved, run
again later). Without Docker: `npm ci && npx playwright-core install chromium`, load `.env`, `node src/cli.js`.

## Development & tests

`npm test` runs everything in real Chromium against a mock of X (`test/mock-x.js`): the Chrome-console script (28 tests), the bot (pagination, keep list,
dry run, 429 / action-limit handling, wrong-row and false-"done" protections, resume), the HTTP API (login lockout, CSRF,
Host checks, secrets handling, crash and frozen-browser recovery, restart-resume) and the dashboard UI. It needs a
Chromium: `npx playwright-core install chromium`, or set `CHROMIUM_PATH`.

Layout: `src/x.js` (everything that touches X's UI), `src/bot.js` (the unfollow loop), `src/runner.js` (background
job + progress), `src/server.js` / `src/web.js` (API + entry point), `web/` (the page), `start-web.sh` (installer).
