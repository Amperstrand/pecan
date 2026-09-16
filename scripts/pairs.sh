#!/bin/sh
# scripts/pairs.sh — the canonical pair manifest for the multi-currency
# deployment. One source of truth for the per-pair facts every script
# needs; before this, the eur/usd/nok list was hand-enumerated in six
# scripts and every missed sibling was a silent gap (NOK went live
# without backup, api-smoke, or reconcile coverage; image tags drifted
# across composes).
#
# POSIX sh — sourced by bash (e2e.sh, rails-audit.sh, mint-backup.sh),
# /bin/sh scripts (api-smoke.sh, deploy.sh), and on the server
# (reconcile-server.sh via /opt/pecan-tools/pairs.sh, rsynced by
# deploy.sh). No arrays, no bashisms.
#
# Usage:
#   . "$(dirname "$0")/pairs.sh"
#   for u in $PAIRS; do
#     pair_field "$u" mint_dir
#   done
#
# Adding a pair: mintd (own mnemonic, config init) + a pecan compose +
# entries here + web/src/lib/coco/currency.ts CURRENCIES. Everything
# else (deploy, smoke, backup, reconcile, audit, e2e credentials)
# picks it up from this table.

PAIRS="eur usd nok"

pair_field() { # pair_field <unit> <field> — echoes the value
  case "$1" in
    eur)
      case "$2" in
        compose)         echo deploy/docker-compose.prod.yml ;;
        compose_remote)  echo /opt/pecan/docker-compose.prod.yml ;;
        compose_flags)   echo "-f docker-compose.prod.yml" ;;
        server_dir)      echo /opt/pecan ;;
        pw_file)         echo /opt/pecan-config/initial-admin-password.txt ;;
        pw_env)          echo PECAN_ADMIN_PASSWORD ;;
        pecan_container) echo pecan-pecan-1 ;;
        mint_dir)        echo /opt/giftcard-mint ;;
        mint_cfg)        echo mint.toml ;;
        mint_container)  echo giftcard-mint-mintd-1 ;;
      esac ;;
    usd)
      case "$2" in
        compose)         echo deploy/docker-compose.usd.yml ;;
        compose_remote)  echo /opt/pecan-usd/docker-compose.yml ;;
        compose_flags)   echo "" ;;
        server_dir)      echo /opt/pecan-usd ;;
        pw_file)         echo /opt/pecan-usd-config/initial-admin-password.txt ;;
        pw_env)          echo PECAN_USD_ADMIN_PASSWORD ;;
        pecan_container) echo pecan-usd-pecan-1 ;;
        mint_dir)        echo /opt/giftcard-mint-usd ;;
        mint_cfg)        echo data/mint.toml ;;
        mint_container)  echo giftcard-mint-usd-mintd-1 ;;
      esac ;;
    nok)
      case "$2" in
        compose)         echo deploy/docker-compose.nok.yml ;;
        compose_remote)  echo /opt/pecan-nok/docker-compose.yml ;;
        compose_flags)   echo "" ;;
        server_dir)      echo /opt/pecan-nok ;;
        pw_file)         echo /opt/pecan-nok-config/initial-admin-password.txt ;;
        pw_env)          echo PECAN_NOK_ADMIN_PASSWORD ;;
        pecan_container) echo pecan-nok-pecan-1 ;;
        mint_dir)        echo /opt/giftcard-mint-nok ;;
        mint_cfg)        echo mint.toml ;;
        mint_container)  echo giftcard-mint-nok-mintd-1 ;;
      esac ;;
    *)
      echo "pairs.sh: unknown unit '$1'" >&2 ;;
  esac
}
