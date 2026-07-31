#!/usr/bin/env bash
#
# Custom Unit Mint — one-command installer and operations CLI.
#
# Install (on a Linux server, as root or a docker-capable user):
#
#   curl -fsSL https://raw.githubusercontent.com/zeugmaster/custom-unit-mint/main/install.sh | bash
#
# The installer resolves the latest release, downloads that release's
# docker-compose.yml / Caddyfile / this script into the install directory
# (default /opt/custom-unit-mint), generates a .env with a strong admin
# password, pulls the published image, and starts the stack. With a domain it
# also enables the bundled Caddy for automatic HTTPS. Afterwards the same
# file, installed as `mintctl`, manages the deployment:
#
#   mintctl status | logs | update | backup | restore | start | stop |
#          uninstall [--purge] | version
#
# Install flags (all optional; --yes makes the run non-interactive):
#   --yes                 answer every prompt with its default
#   --domain <d>          serve the mint at https://<d> via bundled Caddy
#   --console-domain <d>  console hostname (default console.<domain>)
#   --email <e>           ACME account email for certificate notices
#   --dir <path>          install directory (default /opt/custom-unit-mint)
#   --version <vX.Y.Z>    pin a release instead of resolving the latest
#   --ui-port <n>         host port for the operator console (default 9090)
#   --mint-port <n>       host port for the mint API (default 8089)
#   --bind <addr>         host bind address override
#   --ref <git-ref>       (testing) fetch artifacts from this ref, not the tag
#   --artifacts-dir <p>   (testing) copy artifacts from a local checkout
#   --no-pull             (testing) use a locally built image, skip the pull
#
# This script is bash (not POSIX sh) on purpose: pipefail, read -s, and
# arrays make it materially safer. On Alpine: apk add bash curl, then
# download and run the script directly.

set -euo pipefail

REPO="zeugmaster/custom-unit-mint"
RAW_BASE="https://raw.githubusercontent.com/${REPO}"
DEFAULT_LINUX_DIR="/opt/custom-unit-mint"
BIN_LINK="/usr/local/bin/mintctl"

# Populated by parse/setup:
INSTALL_DIR=""
ASSUME_YES=0
OPT_DOMAIN=""
OPT_CONSOLE_DOMAIN=""
OPT_EMAIL=""
OPT_VERSION=""
OPT_UI_PORT="9090"
OPT_MINT_PORT="8089"
OPT_BIND=""
ARTIFACT_REF=""
ARTIFACTS_DIR=""
NO_PULL=0
PLATFORM="$(uname -s)"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

say() { printf '%s\n' "$*"; }
note() { printf '  · %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

have_tty() { [ -r /dev/tty ] && [ -w /dev/tty ]; }

# Prompts must read /dev/tty: when the script itself streams in over stdin
# (curl | bash), reading stdin would consume the script text.
ask() { # ask "question" "default" -> REPLY_VALUE
    local question=$1 default=${2-}
    REPLY_VALUE=$default
    if [ "$ASSUME_YES" = 1 ] || ! have_tty; then
        return 0
    fi
    if [ -n "$default" ]; then
        printf '%s [%s]: ' "$question" "$default" >/dev/tty
    else
        printf '%s: ' "$question" >/dev/tty
    fi
    IFS= read -r REPLY_VALUE </dev/tty || REPLY_VALUE=$default
    [ -n "$REPLY_VALUE" ] || REPLY_VALUE=$default
}

confirm() { # confirm "question" -> 0/1; --yes forces yes, no tty means NO
    local question=$1 answer
    if [ "$ASSUME_YES" = 1 ]; then
        return 0
    fi
    # Without a terminal nothing can be confirmed — refuse rather than
    # defaulting destructive actions to yes; automation passes --yes.
    have_tty || return 1
    printf '%s [y/N]: ' "$question" >/dev/tty
    IFS= read -r answer </dev/tty || answer=""
    case $answer in
        y | Y | yes | YES | Yes) return 0 ;;
        *) return 1 ;;
    esac
}

resolve_script_path() {
    local src=$0 target
    while [ -L "$src" ]; do
        target=$(readlink "$src")
        case $target in
            /*) src=$target ;;
            *) src="$(dirname "$src")/$target" ;;
        esac
    done
    printf '%s' "$src"
}

env_get() { # key file
    sed -n "s/^${1}=//p" "$2" | tail -n 1
}

env_set() { # key value file
    local key=$1 value=$2 file=$3 tmp
    tmp="${file}.tmp.$$"
    {
        grep -v "^${key}=" "$file" || true
        printf '%s=%s\n' "$key" "$value"
    } >"$tmp"
    mv "$tmp" "$file"
}

generate_password() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-24
    else
        head -c 512 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-24
    fi
}

detect_public_ip() {
    curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true
}

resolve_latest_version() {
    local tag
    tag=$(curl -fsSL --max-time 15 "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null |
        sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1) || true
    if [ -z "$tag" ]; then
        # API rate-limited or blocked: the /releases/latest redirect carries
        # the tag in its final URL.
        tag=$(curl -fsSL --max-time 15 -o /dev/null -w '%{url_effective}' \
            "https://github.com/${REPO}/releases/latest" 2>/dev/null |
            sed -n 's#.*/releases/tag/##p') || true
    fi
    printf '%s' "$tag"
}

fetch_artifact() { # repo-relative-path destination
    local rel=$1 dest=$2
    if [ -n "$ARTIFACTS_DIR" ]; then
        cp "$ARTIFACTS_DIR/$rel" "$dest"
        return 0
    fi
    curl -fsSL --max-time 60 "${RAW_BASE}/${ARTIFACT_REF}/${rel}" -o "$dest" ||
        die "could not download ${rel} from ${RAW_BASE}/${ARTIFACT_REF}"
}

compose() {
    docker compose -f "$INSTALL_DIR/docker-compose.yml" --project-directory "$INSTALL_DIR" "$@"
}

project_name() {
    basename "$INSTALL_DIR" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g'
}

wait_healthy() { # ui_port [seconds]
    local port=$1 budget=${2:-120} waited=0
    while [ "$waited" -lt "$budget" ]; do
        if curl -fsS --max-time 3 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
        waited=$((waited + 2))
    done
    return 1
}

# Prepend the ACME email global block unless a global block already exists.
apply_acme_email() { # email
    local email=$1 caddyfile="$INSTALL_DIR/Caddyfile"
    [ -n "$email" ] || return 0
    [ -f "$caddyfile" ] || return 0
    if grep -q '^{[[:space:]]*$' "$caddyfile"; then
        return 0
    fi
    {
        printf '{\n\temail %s\n}\n\n' "$email"
        cat "$caddyfile"
    } >"$caddyfile.tmp"
    mv "$caddyfile.tmp" "$caddyfile"
}

ensure_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        if [ "$PLATFORM" = "Darwin" ]; then
            die "Docker is not installed. Install Docker Desktop from https://docs.docker.com/desktop/ and re-run."
        fi
        say "Docker is not installed."
        if confirm "Install Docker now via https://get.docker.com?"; then
            # Safe to pipe: main() already detached our stdin from the
            # streamed script when running via curl | bash.
            curl -fsSL https://get.docker.com | sh
        else
            die "Docker is required. Install it and re-run."
        fi
    fi
    if ! docker info >/dev/null 2>&1; then
        if [ "$(id -u)" -ne 0 ] && [ "$PLATFORM" != "Darwin" ]; then
            die "cannot talk to the Docker daemon. Re-run as root (curl ... | sudo bash) or add this user to the docker group."
        fi
        die "the Docker daemon is not responding. Is it running?"
    fi
    docker compose version >/dev/null 2>&1 ||
        die "Docker Compose v2 is required (the 'docker compose' plugin). Install docker-compose-plugin and re-run."
}

require_install_dir() {
    # Subcommands run out of the directory this script lives in; the piped
    # installer copy has no such directory.
    local script_path
    script_path=$(resolve_script_path)
    if [ -n "${MINTCTL_DIR:-}" ]; then
        INSTALL_DIR=$MINTCTL_DIR
    elif [ -f "$script_path" ]; then
        INSTALL_DIR=$(cd "$(dirname "$script_path")" && pwd -P)
    fi
    [ -n "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/.env" ] ||
        die "no installation found next to this script. Set MINTCTL_DIR=/path/to/install or run the installer first."
}

# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------

parse_install_args() {
    while [ $# -gt 0 ]; do
        case $1 in
            install) ;;
            --yes | -y) ASSUME_YES=1 ;;
            --domain)
                [ $# -ge 2 ] || die "--domain requires a value"
                OPT_DOMAIN=$2
                shift
                ;;
            --console-domain)
                [ $# -ge 2 ] || die "--console-domain requires a value"
                OPT_CONSOLE_DOMAIN=$2
                shift
                ;;
            --email)
                [ $# -ge 2 ] || die "--email requires a value"
                OPT_EMAIL=$2
                shift
                ;;
            --dir)
                [ $# -ge 2 ] || die "--dir requires a value"
                INSTALL_DIR=$2
                shift
                ;;
            --version)
                [ $# -ge 2 ] || die "--version requires a value"
                OPT_VERSION=$2
                shift
                ;;
            --ui-port)
                [ $# -ge 2 ] || die "--ui-port requires a value"
                OPT_UI_PORT=$2
                shift
                ;;
            --mint-port)
                [ $# -ge 2 ] || die "--mint-port requires a value"
                OPT_MINT_PORT=$2
                shift
                ;;
            --bind)
                [ $# -ge 2 ] || die "--bind requires a value"
                OPT_BIND=$2
                shift
                ;;
            --ref)
                [ $# -ge 2 ] || die "--ref requires a value"
                ARTIFACT_REF=$2
                shift
                ;;
            --artifacts-dir)
                [ $# -ge 2 ] || die "--artifacts-dir requires a value"
                ARTIFACTS_DIR=$2
                shift
                ;;
            --no-pull) NO_PULL=1 ;;
            *) die "unknown install option: $1 (see the header of this script)" ;;
        esac
        shift
    done
}

cmd_install() {
    parse_install_args "$@"

    case "$(uname -m)" in
        x86_64 | amd64 | aarch64 | arm64) ;;
        *) die "unsupported architecture $(uname -m); images are published for amd64 and arm64" ;;
    esac
    if [ "$PLATFORM" = "Darwin" ]; then
        warn "macOS detected — fine for development and testing, not for production."
        [ -n "$INSTALL_DIR" ] || INSTALL_DIR="$HOME/custom-unit-mint"
    else
        [ "$PLATFORM" = "Linux" ] || die "unsupported platform: $PLATFORM"
        [ -n "$INSTALL_DIR" ] || INSTALL_DIR=$DEFAULT_LINUX_DIR
    fi

    ensure_docker

    if [ -f "$INSTALL_DIR/.env" ]; then
        die "an installation already exists in $INSTALL_DIR — use '$INSTALL_DIR/mintctl status' or '$INSTALL_DIR/mintctl update'. (For a second instance, re-run with --dir and different ports.)"
    fi
    mkdir -p "$INSTALL_DIR" 2>/dev/null ||
        die "cannot create $INSTALL_DIR — re-run as root (curl ... | sudo bash) or pass --dir somewhere writable"

    # --- resolve the version and fetch that version's artifacts -----------
    local version=$OPT_VERSION
    if [ -z "$version" ]; then
        say "Resolving the latest release ..."
        version=$(resolve_latest_version)
        [ -n "$version" ] || die "could not resolve the latest release from GitHub. Pass --version vX.Y.Z explicitly."
    fi
    [ -n "$ARTIFACT_REF" ] || ARTIFACT_REF=$version

    say "Installing Custom Unit Mint ${version} into ${INSTALL_DIR}"
    fetch_artifact docker-compose.yml "$INSTALL_DIR/docker-compose.yml"
    grep -q '^services:' "$INSTALL_DIR/docker-compose.yml" || die "downloaded docker-compose.yml looks wrong; aborting"
    fetch_artifact Caddyfile "$INSTALL_DIR/Caddyfile"
    fetch_artifact .env.example "$INSTALL_DIR/.env.example"
    fetch_artifact install.sh "$INSTALL_DIR/mintctl"
    grep -q 'custom-unit-mint' "$INSTALL_DIR/mintctl" || die "downloaded mintctl looks wrong; aborting"
    chmod 0755 "$INSTALL_DIR/mintctl"

    # --- domain / mode -----------------------------------------------------
    local domain=$OPT_DOMAIN console_domain=$OPT_CONSOLE_DOMAIN public_ip
    public_ip=$(detect_public_ip)
    if [ -z "$domain" ] && [ "$ASSUME_YES" = 0 ]; then
        say ""
        say "With a domain, HTTPS is set up automatically (recommended for real use:"
        say "wallets refuse plain-HTTP mints). Without one, the stack serves plain"
        say "HTTP on ports ${OPT_UI_PORT}/${OPT_MINT_PORT} for LAN or testing."
        ask "Domain for the mint (empty = plain-HTTP mode)" ""
        domain=$REPLY_VALUE
    fi
    if [ -n "$domain" ]; then
        [ -n "$console_domain" ] || console_domain="console.${domain}"
        say ""
        say "DNS records required (both pointing at this server):"
        say "    A/AAAA  ${domain}          → ${public_ip:-<server IP>}"
        say "    A/AAAA  ${console_domain}  → ${public_ip:-<server IP>}"
        say "Ports 80 and 443 must be reachable from the internet."
        if ! confirm "Are the DNS records in place?"; then
            die "set up the DNS records first, then re-run the installer"
        fi
        if [ -z "$OPT_EMAIL" ] && [ "$ASSUME_YES" = 0 ]; then
            ask "ACME email for certificate notices (optional)" ""
            OPT_EMAIL=$REPLY_VALUE
        fi
    fi

    # --- write .env ---------------------------------------------------------
    local admin_password bind mint_public_url compose_profiles
    admin_password=$(generate_password)
    [ -n "$admin_password" ] || die "could not generate an admin password"
    if [ -n "$domain" ]; then
        bind=${OPT_BIND:-127.0.0.1}
        mint_public_url="https://${domain}"
        compose_profiles="tls"
    else
        bind=${OPT_BIND:-0.0.0.0}
        mint_public_url="http://${public_ip:-localhost}:${OPT_MINT_PORT}"
        compose_profiles=""
    fi

    (
        umask 077
        cat >"$INSTALL_DIR/.env" <<EOF
# Generated by the Custom Unit Mint installer $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Every key is documented in .env.example.
VERSION=${version}
COMPOSE_PROJECT_NAME=$(project_name)
UI_PORT=${OPT_UI_PORT}
MINT_PORT=${OPT_MINT_PORT}
BIND_ADDR=${bind}
COMPOSE_PROFILES=${compose_profiles}
DOMAIN=${domain}
CONSOLE_DOMAIN=${console_domain}
MINT_PUBLIC_URL=${mint_public_url}
# First boot only; inert once users.json exists. Kept as a recovery path in
# case the printed password is lost before the operator changes it.
INITIAL_ADMIN_PASSWORD=${admin_password}
ACME_EMAIL=${OPT_EMAIL}
EOF
    )
    apply_acme_email "$OPT_EMAIL"

    # --- launch -------------------------------------------------------------
    say ""
    if [ "$NO_PULL" = 1 ]; then
        say "Skipping the image pull (--no-pull); using the local ${version} image."
    else
        say "Pulling the image (${version}) ..."
        if ! compose pull --quiet; then
            die "image pull failed. If this is a brand-new setup, check that the GHCR package ghcr.io/${REPO} exists and is public."
        fi
    fi
    compose up -d --remove-orphans

    say "Waiting for the operator console to come up ..."
    if ! wait_healthy "$OPT_UI_PORT" 120; then
        compose ps || true
        die "the console did not become healthy within 2 minutes — check '$INSTALL_DIR/mintctl logs processor'"
    fi

    # Best-effort convenience symlink.
    if ln -sf "$INSTALL_DIR/mintctl" "$BIN_LINK" 2>/dev/null; then
        note "installed the management CLI as ${BIN_LINK}"
    fi

    # --- summary ------------------------------------------------------------
    local console_url mint_url
    if [ -n "$domain" ]; then
        console_url="https://${console_domain}"
        mint_url="https://${domain}"
    else
        console_url="http://${public_ip:-<server>}:${OPT_UI_PORT}"
        mint_url="$mint_public_url"
    fi
    say ""
    say "============================================================"
    say " Custom Unit Mint ${version} is running"
    say "============================================================"
    say ""
    say "  Operator console:  ${console_url}"
    say "  Mint API:          ${mint_url}"
    say ""
    say "  Sign in:           admin / ${admin_password}"
    say "                     (also stored in ${INSTALL_DIR}/.env)"
    say ""
    say "  First steps in the console:"
    say "    1. Units tab  — add the first unit; this starts the mint."
    say "    2. Mint tab   — reveal and back up the 24-word recovery phrase."
    say "    3. Access tab — change the password, add teller accounts."
    say ""
    if [ -n "$domain" ]; then
        say "  Certificates are provisioned automatically; the first HTTPS"
        say "  request can take a minute. Firewall: allow 80 and 443."
    else
        say "  Plain-HTTP mode: fine on a trusted LAN, not for the public"
        say "  internet. Firewall: allow ${OPT_UI_PORT} and ${OPT_MINT_PORT}."
    fi
    say ""
    say "  Manage with: mintctl status | logs | update | backup | restore |"
    say "               start | stop | uninstall"
    say "============================================================"
}

# ---------------------------------------------------------------------------
# subcommands
# ---------------------------------------------------------------------------

cmd_status() {
    require_install_dir
    local ui_port version latest
    ui_port=$(env_get UI_PORT "$INSTALL_DIR/.env")
    version=$(env_get VERSION "$INSTALL_DIR/.env")
    compose ps
    say ""
    if curl -fsS --max-time 3 "http://127.0.0.1:${ui_port:-9090}/healthz" 2>/dev/null; then
        say ""
    else
        say "console: not responding on 127.0.0.1:${ui_port:-9090}"
    fi
    local mint_state
    mint_state=$(compose exec -T mint cat /run/mint-state 2>/dev/null || true)
    say "mint supervisor: ${mint_state:-unknown}"
    say "installed version: ${version:-unknown}"
    latest=$(resolve_latest_version)
    if [ -n "$latest" ] && [ "$latest" != "$version" ]; then
        say "latest release:    ${latest}  → run 'mintctl update'"
    elif [ -n "$latest" ]; then
        say "latest release:    ${latest} (up to date)"
    fi
}

cmd_logs() {
    require_install_dir
    compose logs -f --tail=200 "$@"
}

cmd_update() {
    require_install_dir
    local target=""
    while [ $# -gt 0 ]; do
        case $1 in
            --version)
                [ $# -ge 2 ] || die "--version requires a value"
                target=$2
                shift
                ;;
            --yes | -y) ASSUME_YES=1 ;;
            --ref)
                [ $# -ge 2 ] || die "--ref requires a value"
                ARTIFACT_REF=$2
                shift
                ;;
            --artifacts-dir)
                [ $# -ge 2 ] || die "--artifacts-dir requires a value"
                ARTIFACTS_DIR=$2
                shift
                ;;
            --no-pull) NO_PULL=1 ;;
            *) die "unknown update option: $1" ;;
        esac
        shift
    done
    local current
    current=$(env_get VERSION "$INSTALL_DIR/.env")
    if [ -z "$target" ]; then
        target=$(resolve_latest_version)
        [ -n "$target" ] || die "could not resolve the latest release; pass --version vX.Y.Z"
    fi
    if [ "$target" = "$current" ]; then
        say "already on ${current}"
        return 0
    fi
    say "Updating ${current:-?} → ${target}"

    # Artifacts and image always move together: fetch the target tag's
    # compose file, Caddyfile, and mintctl before switching the version.
    [ -n "$ARTIFACT_REF" ] || ARTIFACT_REF=$target
    local staging
    staging=$(mktemp -d)
    fetch_artifact docker-compose.yml "$staging/docker-compose.yml"
    grep -q '^services:' "$staging/docker-compose.yml" || die "downloaded docker-compose.yml looks wrong; aborting"
    fetch_artifact Caddyfile "$staging/Caddyfile"
    fetch_artifact .env.example "$staging/.env.example"
    fetch_artifact install.sh "$staging/mintctl"
    grep -q 'custom-unit-mint' "$staging/mintctl" || die "downloaded mintctl looks wrong; aborting"
    mv "$staging/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
    mv "$staging/Caddyfile" "$INSTALL_DIR/Caddyfile"
    mv "$staging/.env.example" "$INSTALL_DIR/.env.example"
    mv "$staging/mintctl" "$INSTALL_DIR/mintctl"
    chmod 0755 "$INSTALL_DIR/mintctl"
    rmdir "$staging" 2>/dev/null || true
    apply_acme_email "$(env_get ACME_EMAIL "$INSTALL_DIR/.env")"

    env_set VERSION "$target" "$INSTALL_DIR/.env"
    if [ "$NO_PULL" = 0 ]; then
        compose pull --quiet
    fi
    compose up -d --remove-orphans

    local ui_port
    ui_port=$(env_get UI_PORT "$INSTALL_DIR/.env")
    if ! wait_healthy "${ui_port:-9090}" 120; then
        die "the console did not come back after the update — check 'mintctl logs processor'"
    fi
    local running
    running=$(curl -fsS --max-time 3 "http://127.0.0.1:${ui_port:-9090}/healthz" 2>/dev/null |
        sed -n 's/.*"version":[[:space:]]*"\([^"]*\)".*/\1/p') || true
    if [ -n "$running" ] && [ "$running" != "$target" ]; then
        warn "console reports version ${running}, expected ${target}"
    fi
    docker image prune -f >/dev/null 2>&1 || true
    say "updated to ${target}"
}

cmd_backup() {
    require_install_dir
    local out=${1:-}
    if [ -z "$out" ]; then
        out="custom-unit-mint-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
    fi
    case $out in
        /*) ;;
        *) out="$(pwd)/$out" ;;
    esac
    local project out_dir out_name
    project=$(env_get COMPOSE_PROJECT_NAME "$INSTALL_DIR/.env")
    [ -n "$project" ] || project=$(project_name)
    out_dir=$(dirname "$out")
    out_name=$(basename "$out")

    say "Stopping services for a consistent snapshot (the mint database is sqlite in WAL mode) ..."
    compose stop
    docker run --rm \
        -v "${project}_config-data:/backup/config:ro" \
        -v "${project}_mint-data:/backup/mint:ro" \
        -v "${project}_processor-data:/backup/processor:ro" \
        -v "$INSTALL_DIR:/backup/install:ro" \
        -v "$out_dir:/out" \
        debian:bookworm-slim \
        tar czf "/out/${out_name}" -C /backup config mint processor install/.env
    compose start
    say ""
    say "Backup written to ${out}"
    say "IT CONTAINS THE MINT'S RECOVERY SEED AND THE ADMIN PASSWORD."
    say "Store it encrypted, off this server."
}

cmd_restore() {
    require_install_dir
    local archive=""
    while [ $# -gt 0 ]; do
        case $1 in
            --yes | -y) ASSUME_YES=1 ;;
            -*) die "unknown restore option: $1" ;;
            *) archive=$1 ;;
        esac
        shift
    done
    [ -n "$archive" ] || die "usage: mintctl restore [--yes] <backup.tar.gz>"
    [ -f "$archive" ] || die "no such file: $archive"
    case $archive in
        /*) ;;
        *) archive="$(pwd)/$archive" ;;
    esac
    local project archive_dir archive_name
    project=$(env_get COMPOSE_PROJECT_NAME "$INSTALL_DIR/.env")
    [ -n "$project" ] || project=$(project_name)
    archive_dir=$(dirname "$archive")
    archive_name=$(basename "$archive")

    say "Restoring replaces ALL current state (config, mint database, tickets)"
    say "of project '${project}' with the archive contents. (.env is not touched.)"
    if ! confirm "Continue?"; then
        die "restore cancelled"
    fi
    compose down --remove-orphans
    local vol
    for vol in config-data mint-data processor-data; do
        docker volume create "${project}_${vol}" >/dev/null
    done
    docker run --rm \
        -v "${project}_config-data:/restore/config" \
        -v "${project}_mint-data:/restore/mint" \
        -v "${project}_processor-data:/restore/processor" \
        -v "$archive_dir:/in:ro" \
        debian:bookworm-slim \
        sh -c "find /restore/config /restore/mint /restore/processor -mindepth 1 -delete \
            && tar xzf /in/${archive_name} -C /restore config mint processor"
    compose up -d --remove-orphans
    say "restore complete — check 'mintctl status'"
}

cmd_start() {
    require_install_dir
    compose up -d --remove-orphans
}

cmd_stop() {
    require_install_dir
    compose stop
}

cmd_uninstall() {
    require_install_dir
    local purge=0
    while [ $# -gt 0 ]; do
        case $1 in
            --purge) purge=1 ;;
            --yes | -y) ASSUME_YES=1 ;;
            *) die "unknown uninstall option: $1" ;;
        esac
        shift
    done
    local project
    project=$(env_get COMPOSE_PROJECT_NAME "$INSTALL_DIR/.env")
    [ -n "$project" ] || project=$(project_name)

    if [ "$purge" = 1 ]; then
        say "PURGE deletes the containers, ALL VOLUMES (including the mint's"
        say "signing keys and database), and ${INSTALL_DIR}. This cannot be undone."
        if [ "$ASSUME_YES" = 1 ]; then
            warn "--yes given; skipping the typed confirmation"
        elif have_tty; then
            local answer
            printf "Type the project name (%s) to confirm: " "$project" >/dev/tty
            IFS= read -r answer </dev/tty || answer=""
            [ "$answer" = "$project" ] || die "confirmation did not match; nothing was deleted"
        else
            die "purge needs an interactive terminal (or --yes for automation)"
        fi
        compose down -v --remove-orphans
        if [ -L "$BIN_LINK" ] && [ "$(readlink "$BIN_LINK")" = "$INSTALL_DIR/mintctl" ]; then
            rm -f "$BIN_LINK" 2>/dev/null || true
        fi
        rm -rf "$INSTALL_DIR"
        say "purged project ${project} and ${INSTALL_DIR}"
    else
        compose down --remove-orphans
        if [ -L "$BIN_LINK" ] && [ "$(readlink "$BIN_LINK")" = "$INSTALL_DIR/mintctl" ]; then
            rm -f "$BIN_LINK" 2>/dev/null || true
        fi
        say "containers removed; volumes and ${INSTALL_DIR} kept."
        say "Re-run '${INSTALL_DIR}/mintctl start' to bring it back, or"
        say "'mintctl uninstall --purge' to delete everything."
    fi
}

cmd_version() {
    require_install_dir
    local version latest
    version=$(env_get VERSION "$INSTALL_DIR/.env")
    say "installed: ${version:-unknown}"
    compose images 2>/dev/null || true
    latest=$(resolve_latest_version)
    [ -z "$latest" ] || say "latest release: ${latest}"
}

usage() {
    local script_path
    script_path=$(resolve_script_path)
    if [ -f "$script_path" ]; then
        # Print the comment header (everything up to the first non-# line).
        awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$script_path"
    else
        say "Custom Unit Mint installer — see https://github.com/${REPO}#readme"
    fi
}

# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------

main() {
    # When the script streams in over stdin, children must not read it.
    if [ ! -t 0 ]; then
        exec </dev/null
    fi

    local cmd=${1:-install}
    case $cmd in
        help | -h | --help) usage ;;
        install | --*) cmd_install "$@" ;;
        status)
            shift
            cmd_status "$@"
            ;;
        logs)
            shift
            cmd_logs "$@"
            ;;
        update)
            shift
            cmd_update "$@"
            ;;
        backup)
            shift
            cmd_backup "$@"
            ;;
        restore)
            shift
            cmd_restore "$@"
            ;;
        start)
            shift
            cmd_start "$@"
            ;;
        stop)
            shift
            cmd_stop "$@"
            ;;
        uninstall)
            shift
            cmd_uninstall "$@"
            ;;
        version)
            shift
            cmd_version "$@"
            ;;
        *) die "unknown command: $cmd (try 'mintctl help')" ;;
    esac
}

main "$@"
