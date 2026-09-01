#!/bin/sh
# Run the Playwright e2e suite against prod with the generated admin password.
# The processor persists the random first-boot password to
# /opt/pecan-config/initial-admin-password.txt (0600); older builds logged it
# once to stdout. If neither exists, credentials must be reset (wipe
# /opt/pecan-config/users.json and redeploy, or use the console).
# Usage: scripts/e2e.sh [extra playwright args]
set -eu
cd "$(dirname "$0")/../web"
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
