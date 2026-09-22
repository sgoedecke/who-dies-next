#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/runtime.sh"
if [[ ! -f "$WORKER_DIR/target/replay-worker.jar" ]]; then
  echo "Worker not built. Run $WORKER_DIR/build.sh first." >&2
  exit 1
fi
exec java -Xmx2g -Dorg.slf4j.simpleLogger.defaultLogLevel=warn -jar "$WORKER_DIR/target/replay-worker.jar" "$@"
