#!/usr/bin/env bash
#
# Secure Mission Control for a private Tailscale-only deployment.
#
# Why this exists:
#   Mission Control originally listened on 0.0.0.0:3000 and the browser talked
#   directly to the OpenClaw gateway port. That works for early setup, but it
#   leaves too much security policy spread across Contabo firewall rules,
#   browser-origin exceptions, and local service binds. This script captures the
#   hardened target state as a repeatable runbook:
#     - Mission Control listens only on localhost.
#     - Tailscale Serve exposes HTTPS / to Mission Control.
#     - Tailscale Serve exposes WSS /gw to the loopback OpenClaw gateway.
#     - Mission Control can safely enable HSTS and secure cookies.
#     - OpenClaw can disable insecure browser auth origins.
#     - UFW denies public inbound traffic while allowing Tailscale.
#
# Migration contract:
#   The script is idempotent and dry-runs by default. Set TAILSCALE_DOMAIN,
#   MISSION_CONTROL_PROJECT_ROOT, or OPENCLAW_STATE_DIR to reuse it on another
#   host. It writes timestamped backups into .data/hardening-backups so secrets
#   are not accidentally left as untracked repo files.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${MISSION_CONTROL_PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_DIR/openclaw.json}"
OPENCLAW_ENV_PATH="${OPENCLAW_ENV_PATH:-$OPENCLAW_STATE_DIR/.env}"
MISSION_CONTROL_ENV_PATH="${MISSION_CONTROL_ENV_PATH:-$PROJECT_ROOT/.env}"

TAILSCALE_DOMAIN="${TAILSCALE_DOMAIN:-vmi3328105.tail9bd1e6.ts.net}"
MISSION_CONTROL_PORT="${MISSION_CONTROL_PORT:-3000}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
TAILSCALE_INTERFACE="${TAILSCALE_INTERFACE:-tailscale0}"
TAILSCALE_UDP_PORT="${TAILSCALE_UDP_PORT:-41641}"

APPLY=0
CONFIGURE_UFW=1
BUILD_APP=1
RESTART_SERVICES=1

usage() {
  cat <<USAGE
Secure Mission Control behind Tailscale HTTPS.

Usage:
  $0 [--apply] [--skip-ufw] [--skip-build] [--no-restart]

Default mode is dry-run. Set env vars to migrate to another host:
  TAILSCALE_DOMAIN=$TAILSCALE_DOMAIN
  MISSION_CONTROL_PROJECT_ROOT=$PROJECT_ROOT
  OPENCLAW_STATE_DIR=$OPENCLAW_STATE_DIR
  MISSION_CONTROL_PORT=$MISSION_CONTROL_PORT
  OPENCLAW_GATEWAY_PORT=$OPENCLAW_GATEWAY_PORT
  TAILSCALE_INTERFACE=$TAILSCALE_INTERFACE

Examples:
  $0
  $0 --apply
  TAILSCALE_DOMAIN=myhost.example.ts.net $0 --apply
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=1
      ;;
    --skip-ufw)
      CONFIGURE_UFW=0
      ;;
    --skip-build)
      BUILD_APP=0
      ;;
    --no-restart)
      RESTART_SERVICES=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

run() {
  # Shared command wrapper: every mutating command must go through this or a
  # more specialized wrapper so dry-run output remains a faithful migration log.
  if [[ "$APPLY" -eq 1 ]]; then
    echo "+ $*"
    "$@"
  else
    printf 'dry-run:'
    printf ' %q' "$@"
    printf '\n'
  fi
}

require_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "error: required file not found: $file" >&2
    exit 1
  fi
}

backup_file() {
  # Back up secret-bearing files outside git-tracked paths. This is intentionally
  # inside .data/, which the repo already ignores, and backups are chmod 600.
  local file="$1"
  [[ "$APPLY" -eq 1 ]] || return 0
  local backup_dir="$PROJECT_ROOT/.data/hardening-backups"
  mkdir -p "$backup_dir"
  chmod 700 "$backup_dir" 2>/dev/null || true
  local backup="$backup_dir/$(basename "$file").bak.$(date +%Y%m%d%H%M%S)"
  cp "$file" "$backup"
  chmod 600 "$backup" 2>/dev/null || chmod --reference="$file" "$backup" 2>/dev/null || true
  echo "backup: $backup"
}

set_env_var() {
  # Update simple KEY=value env files without reordering unrelated settings.
  # This keeps local operator comments and secrets stable while making the
  # hardened access path portable across hosts.
  local file="$1"
  local key="$2"
  local value="$3"

  if [[ "$APPLY" -ne 1 ]]; then
    echo "dry-run: set $key in $file"
    return
  fi

  KEY="$key" VALUE="$value" FILE="$file" node <<'NODE'
const fs = require('fs')
const file = process.env.FILE
const key = process.env.KEY
const value = process.env.VALUE
const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
const lines = raw.split(/\r?\n/)
let found = false
const next = lines.map((line) => {
  if (line.startsWith(`${key}=`)) {
    found = true
    return `${key}=${value}`
  }
  return line
})
if (!found) {
  if (next.length > 0 && next[next.length - 1] !== '') next.push('')
  next.push(`${key}=${value}`)
}
fs.writeFileSync(file, next.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n'))
NODE
}

update_openclaw_config() {
  # Keep OpenClaw's gateway private and require the HTTPS Tailscale origin for
  # browser control UI access. The gateway token itself remains an env reference.
  if [[ "$APPLY" -ne 1 ]]; then
    echo "dry-run: update $OPENCLAW_CONFIG_PATH gateway.controlUi for HTTPS origin"
    return
  fi

  OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG_PATH" TAILSCALE_DOMAIN="$TAILSCALE_DOMAIN" node <<'NODE'
const fs = require('fs')
const file = process.env.OPENCLAW_CONFIG_PATH
const domain = process.env.TAILSCALE_DOMAIN
const config = JSON.parse(fs.readFileSync(file, 'utf8'))
config.gateway ||= {}
config.gateway.controlUi ||= {}
config.gateway.controlUi.allowInsecureAuth = false
config.gateway.controlUi.allowedOrigins = [`https://${domain}`]
config.gateway.bind = config.gateway.bind || 'loopback'
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
NODE
}

check_tailscale_serve_enabled() {
  # Tailscale Serve must be enabled in the tailnet admin UI before local CLI
  # commands can publish HTTPS handlers. Failing here prevents a partial restart
  # that would remove direct :3000 access before HTTPS is ready.
  if tailscale serve status --json >/tmp/mc-tailscale-serve-status.json 2>/tmp/mc-tailscale-serve-status.err; then
    return 0
  fi

  echo "error: Tailscale Serve status failed." >&2
  cat /tmp/mc-tailscale-serve-status.err >&2 || true
  echo "Enable Serve for this node in the Tailscale admin UI, then rerun this script." >&2
  exit 1
}

configure_tailscale_serve() {
  check_tailscale_serve_enabled

  # / serves the UI. /gw serves the browser WebSocket bridge to the loopback
  # OpenClaw gateway, so the gateway can stay bound to localhost.
  run_tailscale serve --bg --yes "http://127.0.0.1:$MISSION_CONTROL_PORT"
  run_tailscale serve --bg --yes --set-path=/gw "http://127.0.0.1:$OPENCLAW_GATEWAY_PORT"

  if [[ "$APPLY" -eq 1 ]]; then
    tailscale serve status
  fi
}

run_tailscale() {
  # Tailscale may allow status reads but reject Serve writes until the operator
  # is delegated with `sudo tailscale set --operator=$USER`. This wrapper reports
  # that exact recovery path instead of leaving a cryptic "serve config denied".
  if [[ "$APPLY" -ne 1 ]]; then
    printf 'dry-run: tailscale'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi

  echo "+ tailscale $*"
  local err
  err="$(mktemp)"
  if tailscale "$@" 2>"$err"; then
    rm -f "$err"
    return 0
  fi

  if grep -qi 'Access denied: serve config denied' "$err"; then
    if sudo -v >/dev/null 2>&1; then
      echo "+ sudo tailscale $*"
      sudo tailscale "$@"
      rm -f "$err"
      return 0
    fi

    cat "$err" >&2
    rm -f "$err"
    cat >&2 <<TAILSCALE

error: this user can read Tailscale state but cannot write Serve config.

Best one-time fix:
  sudo tailscale set --operator=$USER

Alternative:
  run this script from an interactive terminal or with passwordless sudo so it can execute
  sudo tailscale serve ...
TAILSCALE
    exit 1
  fi

  cat "$err" >&2
  rm -f "$err"
  exit 1
}

configure_ufw() {
  # Provider firewalls are useful but invisible to the app and easy to drift.
  # UFW gives this host a local default-deny boundary: tailnet traffic is allowed
  # on tailscale0, and UDP 41641 remains open for direct Tailscale connectivity.
  [[ "$CONFIGURE_UFW" -eq 1 ]] || return 0

  if ! command -v ufw >/dev/null 2>&1; then
    echo "warning: ufw is not installed; skipping host firewall configuration" >&2
    return 0
  fi

  run_sudo /usr/sbin/ufw allow in on "$TAILSCALE_INTERFACE"
  run_sudo /usr/sbin/ufw allow "$TAILSCALE_UDP_PORT/udp"
  run_sudo /usr/sbin/ufw default deny incoming
  run_sudo /usr/sbin/ufw default allow outgoing
  run_sudo /usr/sbin/ufw --force enable
}

run_sudo() {
  # Use command-specific sudo calls instead of `sudo -v` so narrow sudoers rules
  # can grant only the UFW commands this script needs.
  if [[ "$APPLY" -ne 1 ]]; then
    printf 'dry-run: sudo'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi

  echo "+ sudo $*"
  if sudo -n "$@"; then
    return 0
  fi

  cat >&2 <<SUDO
error: sudo could not run the command non-interactively:
  sudo $*

Run the script from an interactive shell so sudo can prompt, run it as root, or
add this exact command to a narrow sudoers rule.
SUDO
  exit 1
}

restart_services() {
  # Restart both services after config/build changes so OpenClaw receives the
  # stricter origin policy and Mission Control serves the rebuilt public bundle.
  [[ "$RESTART_SERVICES" -eq 1 ]] || return 0
  run systemctl --user restart openclaw-gateway mission-control
}

build_app() {
  # NEXT_PUBLIC_GATEWAY_URL is embedded into the Next.js production bundle, so a
  # rebuild is required whenever the browser gateway URL changes.
  [[ "$BUILD_APP" -eq 1 ]] || return 0
  run bash -lc "cd '$PROJECT_ROOT' && pnpm build"
}

verify() {
  # Post-apply proof: localhost remains healthy, public app/gateway ports should
  # be loopback-only, and the user-facing URL is printed for the operator.
  [[ "$APPLY" -eq 1 ]] || return 0

  echo "==> verifying local Mission Control"
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$MISSION_CONTROL_PORT/login" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  curl -fsS "http://127.0.0.1:$MISSION_CONTROL_PORT/login" >/dev/null

  echo "==> verifying bind addresses"
  ss -tulpen | grep -E "(:$MISSION_CONTROL_PORT|:$OPENCLAW_GATEWAY_PORT|:$TAILSCALE_UDP_PORT)" || true

  echo "==> expected browser URL"
  echo "https://$TAILSCALE_DOMAIN"
}

main() {
  require_file "$MISSION_CONTROL_ENV_PATH"
  require_file "$OPENCLAW_CONFIG_PATH"

  echo "==> target"
  echo "Mission Control: https://$TAILSCALE_DOMAIN -> 127.0.0.1:$MISSION_CONTROL_PORT"
  echo "OpenClaw gateway: wss://$TAILSCALE_DOMAIN/gw -> 127.0.0.1:$OPENCLAW_GATEWAY_PORT"

  if [[ "$APPLY" -ne 1 ]]; then
    echo "==> dry-run only; rerun with --apply to make changes"
  fi

  backup_file "$MISSION_CONTROL_ENV_PATH"
  backup_file "$OPENCLAW_CONFIG_PATH"
  [[ -f "$OPENCLAW_ENV_PATH" ]] && backup_file "$OPENCLAW_ENV_PATH"

  set_env_var "$MISSION_CONTROL_ENV_PATH" PORT "$MISSION_CONTROL_PORT"
  set_env_var "$MISSION_CONTROL_ENV_PATH" HOSTNAME 127.0.0.1
  set_env_var "$MISSION_CONTROL_ENV_PATH" NEXT_PUBLIC_GATEWAY_URL "wss://$TAILSCALE_DOMAIN/gw"
  set_env_var "$MISSION_CONTROL_ENV_PATH" MC_ALLOWED_HOSTS "localhost,127.0.0.1,::1,$TAILSCALE_DOMAIN"
  set_env_var "$MISSION_CONTROL_ENV_PATH" MC_ENABLE_HSTS 1
  set_env_var "$MISSION_CONTROL_ENV_PATH" MC_COOKIE_SECURE 1
  set_env_var "$MISSION_CONTROL_ENV_PATH" OPENCLAW_GATEWAY_HOST 127.0.0.1
  set_env_var "$MISSION_CONTROL_ENV_PATH" OPENCLAW_GATEWAY_PORT "$OPENCLAW_GATEWAY_PORT"

  update_openclaw_config

  run chmod 600 "$MISSION_CONTROL_ENV_PATH" "$OPENCLAW_CONFIG_PATH"
  [[ -f "$OPENCLAW_ENV_PATH" ]] && run chmod 600 "$OPENCLAW_ENV_PATH"

  configure_tailscale_serve
  configure_ufw
  build_app
  restart_services
  verify
}

main "$@"
