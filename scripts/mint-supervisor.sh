#!/bin/sh
set -eu

config_path=/var/lib/custom-unit-mint/config/mint.toml
work_dir=/var/lib/cdk-mintd
mint_pid=

stop_mint() {
    if [ -n "${mint_pid}" ] && kill -0 "${mint_pid}" 2>/dev/null; then
        kill "${mint_pid}"
        wait "${mint_pid}" || true
    fi
}

trap 'stop_mint; exit 0' INT TERM

while true; do
    while [ ! -s "${config_path}" ]; do
        echo "waiting for browser setup"
        sleep 2
    done

    config_hash=$(sha256sum "${config_path}" | cut -d ' ' -f 1)
    cdk-mintd --config "${config_path}" --work-dir "${work_dir}" &
    mint_pid=$!

    while kill -0 "${mint_pid}" 2>/dev/null; do
        sleep 2
        next_hash=$(sha256sum "${config_path}" | cut -d ' ' -f 1)
        if [ "${next_hash}" != "${config_hash}" ]; then
            echo "managed mint configuration changed; restarting mint"
            stop_mint
            break
        fi
    done

    wait "${mint_pid}" 2>/dev/null || true
    mint_pid=
done
