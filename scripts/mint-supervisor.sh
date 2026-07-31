#!/bin/sh
set -eu

config_path=/var/lib/custom-unit-mint/config/mint.toml
work_dir=/var/lib/cdk-mintd
state_file=/run/mint-state
pid_file=/run/mint-pid
mint_pid=

# Machine-readable state for the container healthcheck (mint-health):
# waiting | running | restarting. Waiting on the first unit and restarting
# after a config change are legitimate states, not failures.
set_state() {
    printf '%s\n' "$1" > "${state_file}"
}

stop_mint() {
    if [ -n "${mint_pid}" ] && kill -0 "${mint_pid}" 2>/dev/null; then
        kill "${mint_pid}"
        wait "${mint_pid}" || true
    fi
}

trap 'stop_mint; exit 0' INT TERM

# cdk-mintd refuses to start without at least one payment backend, and a
# fresh install legitimately has zero units (no [[ln]] entries) until the
# operator adds the first one from the console. Wait instead of crash-looping.
config_ready() {
    [ -s "${config_path}" ] && grep -q '^\[\[ln\]\]' "${config_path}"
}

while true; do
    set_state waiting
    while ! config_ready; do
        echo "waiting for the first unit (mint starts once one is added in the console)"
        sleep 2
    done

    config_hash=$(sha256sum "${config_path}" | cut -d ' ' -f 1)
    cdk-mintd --config "${config_path}" --work-dir "${work_dir}" &
    mint_pid=$!
    printf '%s\n' "${mint_pid}" > "${pid_file}"
    set_state running

    while kill -0 "${mint_pid}" 2>/dev/null; do
        sleep 2
        next_hash=$(sha256sum "${config_path}" | cut -d ' ' -f 1)
        if [ "${next_hash}" != "${config_hash}" ]; then
            echo "managed mint configuration changed; restarting mint"
            set_state restarting
            stop_mint
            break
        fi
    done

    if ! wait "${mint_pid}" 2>/dev/null; then
        echo "mint exited unexpectedly; retrying in 2s"
        set_state restarting
        sleep 2
    fi
    mint_pid=
done
