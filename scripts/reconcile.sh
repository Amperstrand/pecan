#!/bin/sh
# Reconciliation: compare the mint's ecash ledger (cdk sqlite) against the
# teller's cash movements (pecan tickets.json) and report drift.
#
# The one-way mint has two dangerous inconsistencies this catches early:
#   * ticket PAID but melt quote not settled  → cash out, ecash still alive
#     (double-spend against the mint)
#   * melt quote settled but ticket not PAID  → ecash burned, no payout
#     (user loss)
# plus housekeeping signals: paid-but-unclaimed deposits, stale pending
# tickets past quote expiry.
#
# Usage: scripts/reconcile.sh          (against prod, like e2e.sh)
#        scripts/reconcile.sh -v       (also print per-quote rows)
# The python core lives in reconcile-core.py (single source of truth,
# shared with the hourly server daemon /opt/pecan-tools/reconcile-server.sh).
set -eu
SERVER=root@46.224.104.12
MINT_DB=/opt/giftcard-mint/data/cdk-mintd.sqlite
TICKETS=/opt/pecan-data/tickets.json
VERBOSE=${1:-}

ssh "$SERVER" "python3 - '$MINT_DB' '$TICKETS' '$VERBOSE'" \
  < "$(dirname "$0")/reconcile-core.py"
