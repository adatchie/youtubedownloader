#!/bin/sh
set -eu

# Deployment images are built on Windows hosts; normalize CRLF before exec.
if grep -q $'\r' "$0"; then
    tr -d '\r' < "$0" > /tmp/start.sh
    chmod +x /tmp/start.sh
    exec sh /tmp/start.sh "$@"
fi

node /opt/bgutil-provider/build/main.js --port 4416 &
provider_pid=$!

uvicorn server:app --host 0.0.0.0 --port "${PORT:-10000}" &
server_pid=$!

cleanup() {
    kill "$server_pid" "$provider_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    wait "$provider_pid" 2>/dev/null || true
}

trap cleanup INT TERM EXIT
wait "$server_pid"
