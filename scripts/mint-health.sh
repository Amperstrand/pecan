#!/bin/sh
# Container healthcheck for the mint service. The supervisor records its
# state in /run/mint-state. "waiting" (no unit yet — a fresh install idles
# until the operator adds the first unit from the console) and "restarting"
# (config change / crash backoff) are healthy by design; for "running" the
# cdk-mintd process must actually be alive.
set -eu

state=$(cat /run/mint-state 2>/dev/null || echo unknown)
case "${state}" in
    waiting | restarting)
        exit 0
        ;;
    running)
        pid=$(cat /run/mint-pid 2>/dev/null || echo "")
        [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null
        ;;
    *)
        exit 1
        ;;
esac
