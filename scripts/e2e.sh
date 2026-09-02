#!/bin/sh
# Run the Playwright e2e suite against prod with the generated admin password.
# The processor persists the random first-boot password to
# /opt/pecan-config/initial-admin-password.txt (0600); older builds logged it
# once to stdout. If neither exists, credentials must be reset (wipe
# /opt/pecan-config/users.json and redeploy, or use the console).
#
# Tiers:
#   scripts/e2e.sh                full suite (~10-15m, burns ~57k sat of
#                                 payer liquidity via the onchain tests)
#   scripts/e2e.sh --smoke        @smoke-tagged critical path only (~1-2m,
#                                 zero sat: teller deposit+withdraw, one
#                                 client-side form-contract check, both pairs)
#   scripts/e2e.sh -g "<regex>"   targeted subset (chain-aware: tests boot on
#                                 the wallet page but funding comes from
#                                 earlier tests in the same serial chain)
# Other args pass through to playwright. PECAN_E2E_ONCHAIN_CONF=<n> pins the
# expected onchain confirmation policy (see the onchain deposit test).
# Usage: scripts/e2e.sh [--smoke] [--no-preflight] [extra playwright args]
set -eu
cd "$(dirname "$0")/../web"

SMOKE=0
PREFLIGHT=1
PW_ARGS=""
for arg in "$@"; do
  case "$arg" in
    --smoke) SMOKE=1 ;;
    --no-preflight) PREFLIGHT=0 ;;
    *) PW_ARGS="$PW_ARGS $arg" ;;
  esac
done

if [ "$PREFLIGHT" -eq 1 ]; then
  # Read-only prod invariants first: a dead deployment must fail here in
  # ~30s instead of inside a browser test minutes later.
  ../scripts/api-smoke.sh >/dev/null || {
    echo "PREFLIGHT: api-smoke failed — run scripts/api-smoke.sh for details" >&2
    exit 1
  }
  echo "preflight: api-smoke ok"
fi

PW=$(ssh root@46.224.104.12 \
  "cat /opt/pecan-config/initial-admin-password.txt 2>/dev/null \
   || docker logs pecan-pecan-1 2>&1 | grep -o 'generated random admin password: [A-Za-z0-9]*' | head -1 | awk '{print \$NF}'")
if [ -z "$PW" ]; then
  echo "no generated admin password found (file or logs) on the server" >&2
  exit 1
fi
export PECAN_ADMIN_PASSWORD="$PW"
USD_PW=$(ssh root@46.224.104.12 \
  "cat /opt/pecan-usd-config/initial-admin-password.txt 2>/dev/null" || true)
if [ -n "$USD_PW" ]; then
  export PECAN_USD_ADMIN_PASSWORD="$USD_PW"
fi

if [ "$SMOKE" -eq 1 ]; then
  # max-failures=1: when iterating on a broken build the first failure is
  # the information; the rest of the tier would only echo it.
  set -- $PW_ARGS --grep @smoke --max-failures=1
else
  # Default lane: everything except the @stress soak tool (~6 min, zero
  # sat, run explicitly with `scripts/e2e.sh -g @stress`).
  set -- $PW_ARGS --grep-invert @stress
fi

# Not exec'd: the trailing verdict line lets agents and soak greps read
# the outcome without scanning Playwright's full output.
status=0
npx playwright test "$@" || status=$?
if [ "$status" -eq 0 ]; then
  echo "E2E VERDICT: PASS"
else
  echo "E2E VERDICT: FAIL (exit $status)"
fi
exit "$status"
