#!/usr/bin/env bash
# Installs / updates / manages the web dashboard on a server that already has Docker.
#
#   ./start-web.sh                 install or update, then start (safe to run again any time)
#   ./start-web.sh logs            show what the bot is doing (Ctrl+C to leave)
#   ./start-web.sh stop            stop the dashboard (start again with ./start-web.sh)
#   ./start-web.sh show-password   print the dashboard password
#   ./start-web.sh uninstall       remove it completely
#
# Options for the install step:  --private | --public   who can open the page (see below)
#                                --port N               port to use (default 8080)
#                                --reset-password       choose a new dashboard password
#
# Needs bash (Ubuntu has it). If started with `sh script`, hand over to bash.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail
# Work from the folder this script really lives in (also when started through a symlink).
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

IMAGE=${WEB_IMAGE:-twitter-unfollow-web}
NAME=${WEB_NAME:-twitter-unfollow}
VOLUME=${WEB_VOLUME:-twitter-unfollow-data}
ENV_FILE=.web-env        # UI_PASSWORD lives here (only you can read it)
CONF_FILE=.web-config    # BIND / PORT choices
BUILD_ARGS=${BUILD_ARGS:-}   # extra `docker build` flags (e.g. for a corporate proxy)
MIN_PW=12

say()  { printf '%s\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ---- find a working docker (with or without sudo) ----
command -v docker >/dev/null 2>&1 || die "Docker is not installed on this machine. Install it first: https://docs.docker.com/engine/install/ubuntu/"
if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
  DOCKER=(sudo docker)
  say "(Using sudo for docker; you may be asked for your server password.)"
else
  die "Docker is installed but I can't talk to it. Is the Docker service running (sudo systemctl start docker)? Is your user allowed to use it?"
fi

# When run with sudo, files must still belong to the real user (a later non-sudo run has to read them).
fix_owner() {
  if [[ ${EUID:-$(id -u)} -eq 0 && -n "${SUDO_USER:-}" ]]; then chown "$SUDO_USER" "$@" 2>/dev/null || true; fi
}

cmd=${1:-install}
case "$cmd" in
  logs)      exec "${DOCKER[@]}" logs -f --tail 100 "$NAME" ;;
  stop)
    if "${DOCKER[@]}" stop -t 40 "$NAME" >/dev/null 2>&1; then
      say "Stopped. Run ./start-web.sh to start it again."
      say "Note: if an unfollow run was in progress it will CONTINUE automatically next time. To prevent that,"
      say "press 'Stop' on the dashboard page first, then run this command."
    else
      say "It isn't running."
    fi
    exit 0 ;;
  show-password)
    [[ -f "$ENV_FILE" ]] || die "No password has been set yet. Run ./start-web.sh first."
    grep -E '^UI_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2-
    exit 0 ;;
  uninstall)
    "${DOCKER[@]}" rm -f "$NAME" >/dev/null 2>&1 || true
    "${DOCKER[@]}" rmi "$IMAGE" >/dev/null 2>&1 || true
    say "Removed the container and the program image."
    read -r -p "Also delete the saved data (your X cookies, settings, list of who was unfollowed) and the dashboard password? [y/N] " yn || yn=n
    if [[ "$yn" =~ ^[Yy] ]]; then
      "${DOCKER[@]}" volume rm "$VOLUME" >/dev/null 2>&1 || true
      rm -f "$ENV_FILE" "$CONF_FILE"
      say "Deleted. (Also log out of x.com in your browser to make the old cookies useless.)"
    else
      say "Kept the data. Run ./start-web.sh again any time to bring it back."
    fi
    base_image=$(awk '/^FROM /{print $2; exit}' Dockerfile 2>/dev/null || true)
    if [[ -n "$base_image" ]]; then
      read -r -p "Also remove the downloaded browser base image ($base_image, ~3.5 GB; the next install downloads it again)? [Y/n] " yn2 || yn2=n
      [[ "$yn2" =~ ^[Nn] ]] || { "${DOCKER[@]}" rmi "$base_image" >/dev/null 2>&1 && say "Removed it." || say "(It is still in use by something else, so it was kept.)"; }
    fi
    exit 0 ;;
  install) shift || true ;;
  --*) ;;                       # options only: treat as install
  *) die "Unknown command '$cmd'. Try: ./start-web.sh   or   ./start-web.sh logs|stop|show-password|uninstall" ;;
esac

# ---- options ----
BIND="" PORT="" RESET_PW=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --private) BIND=127.0.0.1 ;;
    --public)  BIND=0.0.0.0 ;;
    --port)    shift; PORT=${1:-}; [[ "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1 && "$PORT" -le 65535 ]] || die "--port needs a number between 1 and 65535" ;;
    --reset-password) RESET_PW=1 ;;
    *) die "Unknown option $1" ;;
  esac
  shift
done

# remembered choices from last time
if [[ -f "$CONF_FILE" ]]; then
  saved_bind=$(grep -E '^BIND=' "$CONF_FILE" | head -1 | cut -d= -f2- || true)
  saved_port=$(grep -E '^PORT=' "$CONF_FILE" | head -1 | cut -d= -f2- || true)
  BIND=${BIND:-$saved_bind}
  PORT=${PORT:-$saved_port}
fi
PORT=${PORT:-8080}

# ---- who may open the page? ----
if [[ -z "$BIND" ]]; then
  if [[ -t 0 ]]; then
    say ""
    bold "Who should be able to open the dashboard?"
    say "  1) Only me, through a secure SSH tunnel   (safest - recommended)"
    say "  2) Anyone who can reach this server over the network (plain http, no encryption!)"
    say "     Only choose this on a private home/office network or VPN (e.g. Tailscale)."
    read -r -p "Choose 1 or 2 [1]: " choice || choice=1
    [[ "${choice:-1}" == "2" ]] && BIND=0.0.0.0 || BIND=127.0.0.1
  else
    BIND=127.0.0.1
  fi
fi

# ---- dashboard password ----
password_ok() { # >= MIN_PW printable ASCII characters, no space at either end
  local p=$1
  [[ ${#p} -ge $MIN_PW ]] || return 1
  [[ "$p" =~ ^[[:print:]]+$ ]] || return 1
  [[ "$p" != " "* && "$p" != *" " ]] || return 1
}
existing_pw=""
[[ -f "$ENV_FILE" ]] && existing_pw=$(grep -E '^UI_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
GENERATED_PW=""
if [[ -z "$existing_pw" ]] || ! LC_ALL=C password_ok "$existing_pw" || [[ "$RESET_PW" == 1 ]]; then
  [[ -n "$existing_pw" && "$RESET_PW" != 1 ]] && say "The saved dashboard password is too short or unusable, so we need a new one."
  pw=${UI_PASSWORD:-}
  if [[ -z "$pw" ]]; then
    [[ -t 0 ]] || die "No terminal to ask for a password. Run this in an interactive SSH session (or set UI_PASSWORD=... in the environment)."
    say ""
    bold "Choose a password for the dashboard."
    say "It protects a page that can control your X account, so it must be long: at least $MIN_PW characters,"
    say "letters/numbers/symbols only (no accents or emoji), no space at the start or end."
    say "Press Enter without typing anything to have a strong random one created for you (recommended)."
    say "(Nothing appears on screen while you type - that is normal.)"
    while true; do
      IFS= read -r -s -p "Password: " pw; echo
      if [[ -z "$pw" ]]; then
        pw=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24 || true)
        [[ ${#pw} -eq 24 ]] || die "Could not generate a password."
        GENERATED_PW=$pw
        break
      fi
      IFS= read -r -s -p "Again:    " pw2; echo
      LC_ALL=C password_ok "$pw" || { say "That won't do: at least $MIN_PW plain characters, no space at the start or end. Try again."; continue; }
      [[ "$pw" == "$pw2" ]] || { say "They didn't match - try again."; continue; }
      break
    done
  fi
  LC_ALL=C password_ok "$pw" || die "The password must be at least $MIN_PW plain characters (letters, numbers, symbols) with no space at the start or end."
  # keep any extra lines the user added to the file; replace only UI_PASSWORD
  umask 077
  { [[ -f "$ENV_FILE" ]] && grep -v '^UI_PASSWORD=' "$ENV_FILE" || true; printf 'UI_PASSWORD=%s\n' "$pw"; } > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
fi
chmod 600 "$ENV_FILE" 2>/dev/null || true
fix_owner "$ENV_FILE"

# ---- is the port free? (before touching a working install) ----
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
old_port=$("${DOCKER[@]}" port "$NAME" 8080/tcp 2>/dev/null | head -1 | sed 's/.*://' || true)
if [[ "$old_port" != "$PORT" ]] && port_busy "$PORT"; then
  die "Port $PORT is already used by another program on this server. Choose another one, for example:  ./start-web.sh --port 8081"
fi

# ---- build ----
say ""
bold "Building the program (first time takes several minutes and downloads ~1.5 GB)..."
# shellcheck disable=SC2086
"${DOCKER[@]}" build $BUILD_ARGS -t "$IMAGE" . || die "The build failed. Check that the server has internet access and enough free disk space (df -h shows it; about 6 GB are needed), then run ./start-web.sh again."

# ---- (re)start ----
if "${DOCKER[@]}" container inspect "$NAME" >/dev/null 2>&1; then
  say "Stopping the old version (a run in progress will resume by itself)..."
  "${DOCKER[@]}" stop -t 40 "$NAME" >/dev/null 2>&1 || true
  "${DOCKER[@]}" rm "$NAME" >/dev/null
fi
# The program runs as an unprivileged user; make sure it owns its data volume (needed once for volumes created earlier).
"${DOCKER[@]}" run --rm -u 0 --entrypoint sh -v "$VOLUME:/data" "$IMAGE" -c 'chown -R pwuser:pwuser /data' >/dev/null
if ! "${DOCKER[@]}" run -d --name "$NAME" --restart unless-stopped --init \
    --shm-size=1g --cap-drop=ALL --security-opt no-new-privileges --pids-limit 2048 \
    --log-opt max-size=10m --log-opt max-file=3 \
    --env-file "$ENV_FILE" -v "$VOLUME:/data" -p "$BIND:$PORT:8080" "$IMAGE" >/dev/null; then
  "${DOCKER[@]}" rm -f "$NAME" >/dev/null 2>&1 || true
  die "Docker could not start the dashboard (is port $PORT in use? try ./start-web.sh --port 8081)."
fi

say "Starting..."
status=starting
for _ in $(seq 1 45); do
  status=$("${DOCKER[@]}" container inspect -f '{{if .State.Running}}{{.State.Health.Status}}{{else}}exited{{end}}' "$NAME" 2>/dev/null || echo exited)
  [[ "$status" == healthy || "$status" == exited ]] && break
  # a container that keeps restarting (bad password file, etc.) never becomes healthy
  restarts=$("${DOCKER[@]}" container inspect -f '{{.RestartCount}}' "$NAME" 2>/dev/null || echo 0)
  [[ "$restarts" -ge 2 ]] && break
  sleep 2
done
if [[ "$status" != healthy ]]; then
  say ""; say "--- last log lines ---"; "${DOCKER[@]}" logs --tail 30 "$NAME" 2>&1 || true
  "${DOCKER[@]}" stop "$NAME" >/dev/null 2>&1 || true
  die "The dashboard did not start properly (see the log above). If it complains about the password, run: ./start-web.sh --reset-password"
fi

# remember the choices only once they have worked
printf 'BIND=%s\nPORT=%s\n' "$BIND" "$PORT" > "$CONF_FILE"
chmod 600 "$CONF_FILE" 2>/dev/null || true
fix_owner "$CONF_FILE"

ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^172\.17\.' | head -1 || true)
who=${SUDO_USER:-${USER:-youruser}}
say ""
bold "Done! The dashboard is running."
say ""
if [[ -n "$GENERATED_PW" ]]; then
  bold "Your dashboard password (save it in a password manager now):"
  say "    $GENERATED_PW"
  say "(You can show it again later with:  ./start-web.sh show-password )"
  say ""
fi
if [[ "$BIND" == 127.0.0.1 ]]; then
  say "To open it:"
  say "  1. On YOUR OWN computer (not the server) open a terminal and run:"
  say "       ssh -L $PORT:localhost:$PORT $who@${ip:-SERVER-ADDRESS}"
  say "     and leave that window open."
  say "  2. Then open  http://localhost:$PORT  in your browser and log in with your password."
else
  say "Open  http://${ip:-SERVER-ADDRESS}:$PORT  in your browser and log in with your password."
  say "WARNING: this is plain http. Anyone on the network can see what you type (including your X cookies)."
  say "Only use it on a network you trust, and don't port-forward it to the internet."
  say "(If you open it by a domain name rather than the IP, add a line  ALLOWED_HOSTS=your.domain.name  to $ENV_FILE and run this script again.)"
fi
say ""
say "It keeps running in the background and comes back after a server reboot (you will need to log in again)."
say "Handy commands:  ./start-web.sh logs   |   ./start-web.sh stop   |   ./start-web.sh show-password   |   ./start-web.sh uninstall"
if [[ ${EUID:-$(id -u)} -eq 0 && -n "${SUDO_USER:-}" ]]; then
  say "(You don't need 'sudo' in front of this script: it asks for it by itself when needed.)"
fi
