# twitterunfollow

Unfollows everyone on your X/Twitter account, slowly enough not to trip rate limits. It drives a real
(headless) Chromium through the website using your logged-in session cookies, so **no API key is needed**.
It runs in a throwaway Docker container and exits when your following list is empty.

## 1. Get your session cookies

Log in to https://x.com in your normal browser, open DevTools → **Application** (Chrome) / **Storage** (Firefox)
→ **Cookies** → `https://x.com`, and copy the values of:

- `auth_token`
- `ct0`

```bash
cp .env.example .env     # then paste the two values in, without quotes
```

> `auth_token` is equivalent to being logged in as you. Keep `.env` private (it is git-ignored and
> docker-ignored). Logging out of x.com in that browser invalidates the cookies.

Logging in with username/password from a bot is deliberately not supported: it triggers X's login
challenges and 2FA, which is far more likely to get an account flagged than reusing an existing session.

## 2. Run it in Docker

```bash
docker build -t twitter-unfollow .
mkdir -p data

# Preview first: lists who WOULD be unfollowed, touches nothing (writes data/would-unfollow.txt)
docker run --rm --init --ipc=host --env-file .env -e DRY_RUN=true -v "$PWD/data:/data" twitter-unfollow

# The real run (foreground; Ctrl+C stops cleanly)
docker run --rm --init --ipc=host --env-file .env -v "$PWD/data:/data" twitter-unfollow

# ...or in the background
docker run -d --rm --init --ipc=host --name unfollow --env-file .env -v "$PWD/data:/data" twitter-unfollow
docker logs -f unfollow
docker stop unfollow      # safe at any time
```

`--rm` deletes the container when it finishes; everything worth keeping lives in `./data`.

To protect people from being unfollowed, put handles in `KEEP=alice,@bob` in `.env`, or one per line in
`data/keep.txt` and set `KEEP_FILE=/data/keep.txt`.

## How it avoids rate limits

X doesn't publish exact unfollow limits, so the defaults are conservative and everything is tunable in `.env`:

| Mechanism | Default |
| --- | --- |
| Random pause between unfollows | 15–45 s |
| Longer break after every N unfollows | every 20, for 3–6 min |
| Hard cap, rolling 1 hour | 40 |
| Hard cap, rolling 24 hours | 250 |
| On HTTP 429 / "limit reached" | exponential backoff from 15 min (honours X's reset time), doubling up to 4 h |
| Give up after N consecutive limit hits | 5 → exits with code 2 |

The hourly/daily caps are counted from a history saved in `data/state.json`, so they still hold if you stop and
restart. When a cap is reached the bot just sleeps until it frees up, so a big list simply takes several days
(1,000 accounts ≈ 4 days at the defaults). Use `docker stop` any time and run it again later to continue where
it left off; the following list itself is the source of truth for what is left.

Every unfollowed handle is appended to `data/unfollowed.jsonl` in case you want to re-follow anyone.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Finished (list empty), stopped by you, or `MAX_TOTAL` reached |
| 1 | Error: bad config, cookies expired, account locked/suspended, X's UI changed, or some accounts couldn't be unfollowed |
| 2 | Gave up after repeated rate limits — progress is saved, run again later |

## Without Docker

```bash
npm ci
npx playwright-core install chromium
set -a; . ./.env; set +a
node src/cli.js
```

## Tests

`npm test` runs the whole bot in real Chromium against a mock of X's following page (`test/mock-x.js`):
pagination/scrolling, keep list, dry run, 429 and action-limit handling, resuming from saved state, bad cookies.
It needs a Chromium (`npx playwright-core install chromium`, or point `CHROMIUM_PATH` at one).

## Caveats

- **Not verified against live x.com.** The bot relies on X's `data-testid` attributes (`UserCell`,
  `*-unfollow`, `confirmationSheetConfirm`, …), all collected in `src/x.js`. They have been stable for years, but if X
  changes its UI the bot will fail safe (it stops after 5 failed attempts in a row and saves a screenshot to
  `data/`), and the fix is confined to that file. Try `DRY_RUN=true` first to confirm it can see your list.
- Automating the website goes against X's Terms of Service, and rate limits are the platform's to change.
  Use it on your own account only, and keep the pacing conservative.
- On Linux, files in `./data` are created by root inside the container (`sudo chown -R $USER data` to edit them).
