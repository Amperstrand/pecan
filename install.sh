#!/usr/bin/env bash
#
# Pecan — installer bootstrap.
#
#   curl -fsSL https://raw.githubusercontent.com/zeugmaster/pecan/main/install.sh | bash
#
# This script is a thin bootstrap: it downloads the release's `mintctl`
# binary for this platform, verifies its checksum, and hands over to it.
# mintctl runs the guided installer and afterwards manages the deployment
# (status / logs / update / backup / restore / start / stop / uninstall).
# All install flags are passed through — see `mintctl install --help` or the
# README. `--version vX.Y.Z` pins a release for both the binary and the stack.
#
# Compatibility shim: releases up to the bash-only installer fetched this
# file as their `mintctl`. When invoked that way (a .env sits next to this
# script), it upgrades itself to the pinned release's binary in place and
# re-executes with the original arguments.
#
# Testing overrides:
#   MINTCTL_LOCAL_BIN=/path/to/mintctl   use a local binary, skip the download

set -euo pipefail

REPO="zeugmaster/pecan"

say() { printf '%s\n' "$*"; }
die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

fetch() { # url dest
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --max-time 120 "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -T 120 -O "$2" "$1"
    else
        die "curl or wget is required"
    fi
}

fetch_stdout() { # url
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --max-time 15 "$1"
    else
        wget -q -T 15 -O - "$1"
    fi
}

sha256_of() { # file
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d ' ' -f 1
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d ' ' -f 1
    else
        die "sha256sum or shasum is required to verify the download"
    fi
}

asset_name() {
    local os arch
    case "$(uname -s)" in
        Linux) os=linux ;;
        Darwin) os=darwin ;;
        *) die "unsupported platform $(uname -s) — see the manual compose setup in docs/operations.md" ;;
    esac
    case "$(uname -m)" in
        x86_64 | amd64) arch=amd64 ;;
        aarch64 | arm64) arch=arm64 ;;
        *) die "unsupported architecture $(uname -m); binaries are published for amd64 and arm64" ;;
    esac
    printf 'mintctl-%s-%s' "$os" "$arch"
}

resolve_latest_version() {
    local tag
    tag=$(fetch_stdout "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null |
        sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1) || true
    if [ -z "$tag" ] && command -v curl >/dev/null 2>&1; then
        # API rate-limited or blocked: the /releases/latest redirect carries
        # the tag in its final URL.
        tag=$(curl -fsSL --max-time 15 -o /dev/null -w '%{url_effective}' \
            "https://github.com/${REPO}/releases/latest" 2>/dev/null |
            sed -n 's#.*/releases/tag/##p') || true
    fi
    printf '%s' "$tag"
}

# Peek at the args for a --version pin without consuming anything.
version_from_args() {
    while [ $# -gt 0 ]; do
        if [ "$1" = "--version" ] && [ $# -ge 2 ]; then
            printf '%s' "$2"
            return 0
        fi
        shift
    done
    printf ''
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

# Download the release's mintctl binary into $1, verified against SHA256SUMS.
download_binary() { # dest version
    local dest=$1 version=$2 asset sums expected actual
    asset=$(asset_name)
    local base="https://github.com/${REPO}/releases/download/${version}"
    say "Downloading mintctl ${version} (${asset}) ..." >&2
    sums=$(fetch_stdout "${base}/SHA256SUMS") ||
        die "could not download SHA256SUMS for ${version}"
    expected=$(printf '%s\n' "$sums" | awk -v a="$asset" '$2 == a || $2 == "*" a { print $1 }' | head -n 1)
    [ -n "$expected" ] || die "${asset} is not listed in the ${version} SHA256SUMS"
    fetch "${base}/${asset}" "$dest" ||
        die "could not download ${asset} for ${version}"
    actual=$(sha256_of "$dest")
    [ "$actual" = "$expected" ] ||
        die "checksum mismatch for ${asset}: expected ${expected}, got ${actual}"
    chmod 0755 "$dest"
}

main() {
    # When this script streams in over stdin, children must not read it.
    if [ ! -t 0 ]; then
        exec </dev/null
    fi

    local script_path script_dir version=""
    script_path=$(resolve_script_path)
    script_dir=$(cd "$(dirname "$script_path")" 2>/dev/null && pwd -P) || script_dir=""

    # Shim mode: an old install's `mintctl update` replaced its bash mintctl
    # with this bootstrap. Upgrade in place to that install's pinned binary,
    # then re-exec with the original arguments.
    if [ -n "$script_dir" ] && [ -f "$script_dir/.env" ] && [ -f "$script_path" ]; then
        version=$(sed -n 's/^VERSION=//p' "$script_dir/.env" | tail -n 1)
        [ -n "$version" ] || version=$(resolve_latest_version)
        [ -n "$version" ] || die "could not resolve a release for the mintctl binary"
        local staged="$script_dir/.mintctl.download.$$"
        if [ -n "${MINTCTL_LOCAL_BIN:-}" ]; then
            cp "$MINTCTL_LOCAL_BIN" "$staged" && chmod 0755 "$staged"
        else
            download_binary "$staged" "$version"
        fi
        mv "$staged" "$script_path"
        exec "$script_path" "$@"
    fi

    # Fresh install: fetch the binary to a temp dir and hand over; mintctl
    # itself copies the pinned binary into the install directory.
    local pinned
    pinned=$(version_from_args "$@")
    version=$pinned
    if [ -z "$version" ]; then
        say "Resolving the latest release ..." >&2
        version=$(resolve_latest_version)
        [ -n "$version" ] || die "could not resolve the latest release from GitHub. Pass --version vX.Y.Z."
    fi
    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap 'rm -rf "$tmp_dir"' EXIT
    if [ -n "${MINTCTL_LOCAL_BIN:-}" ]; then
        cp "$MINTCTL_LOCAL_BIN" "$tmp_dir/mintctl" && chmod 0755 "$tmp_dir/mintctl"
    else
        download_binary "$tmp_dir/mintctl" "$version"
    fi
    # The stack pin travels as --version unless the caller already passed one.
    local -a cmd=("$tmp_dir/mintctl" install)
    if [ -z "$pinned" ]; then
        cmd+=(--version "$version")
    fi
    # Reattach the terminal for the guided installer; automation uses --yes.
    if [ -r /dev/tty ]; then
        "${cmd[@]}" "$@" </dev/tty
    else
        "${cmd[@]}" "$@"
    fi
}

main "$@"
