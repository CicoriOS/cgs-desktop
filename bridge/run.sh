#!/bin/sh
# Runs the patched omp headless (--mode rpc-ui) in the cgscli-build container and serves the built web client (dist/) over the dev bridge.
# Usage: bun run build && bridge/run.sh [cgs args...]      then open http://127.0.0.1:${PORT:-8787}
# Env: CGS_BIN (default /tmp/omp-build/packages/coding-agent/dist/cgs), CGS_BASE_URL, STATE=<docker volume keeping ~/.cgs, e.g. a logged-in one>,
#      CGSCLI=<cgscli checkout> (default ../cgscli; provides the extension and seed-config), PORT, HOST.
# The container uses the host network; HOST defaults to loopback. Anyone who reaches the port controls the agent.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CGS_BIN=${CGS_BIN:-/tmp/omp-build/packages/coding-agent/dist/cgs}
CGSCLI=${CGSCLI:-$(cd "$ROOT/../cgscli" && pwd)}
HOME_MOUNT=${STATE:+-v $STATE:/home/t}
[ -z "$HOME_MOUNT" ] && HOME_MOUNT="--tmpfs /home/t:exec,mode=1777"
# shellcheck disable=SC2086
exec docker run --rm --network host \
  -v "$CGS_BIN":/usr/local/bin/cgs:ro -v "$CGSCLI":/cgscli:ro -v "$ROOT":/app:ro \
  $HOME_MOUNT -e HOME=/home/t \
  -e PI_CONFIG_DIR=.cgs -e PI_NATIVES_DIR=/home/t/.cgs/natives -e PI_RPC_TITLE=1 -e PI_RPC_EMIT_TITLE=1 \
  ${CGS_BASE_URL:+-e CGS_BASE_URL="$CGS_BASE_URL"} ${PORT:+-e PORT="$PORT"} ${HOST:+-e HOST="$HOST"} ${DEVICE_NAME:+-e DEVICE_NAME="$DEVICE_NAME"} \
  -w /tmp --entrypoint sh cgscli-build -c '
    mkdir -p /home/t/.cgs/agent
    PI_CODING_AGENT_DIR=/home/t/.cgs/agent bun /cgscli/scripts/seed-config.ts /cgscli/plugin/omp-extension/index.ts
    AGENT_DIR=/home/t/.cgs/agent exec bun /app/bridge/server.ts -- cgs --mode rpc-ui "$@"' sh "$@"
