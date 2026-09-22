#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/runtime.sh"
MAVEN=mvn
if [[ -x "$TOOLS_DIR/apache-maven-3.9.9/bin/mvn" ]]; then
  MAVEN="$TOOLS_DIR/apache-maven-3.9.9/bin/mvn"
fi
exec "$MAVEN" -B -q -f "$WORKER_DIR/pom.xml" "-Dmaven.repo.local=$TOOLS_DIR/m2" package "$@"
