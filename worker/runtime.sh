#!/usr/bin/env bash
# Sourced by build.sh and run.sh; changes apply only to the child process.
WORKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_DIR="$(cd "$WORKER_DIR/.." && pwd)/.tools"
if [[ -z "${JAVA_HOME:-}" ]]; then
  for candidate in "$TOOLS_DIR"/jdk*/Contents/Home "$TOOLS_DIR"/jdk*; do
    if [[ -x "$candidate/bin/java" ]]; then
      export JAVA_HOME="$candidate"
      break
    fi
  done
fi
if [[ -n "${JAVA_HOME:-}" ]]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi
# Native Snappy must extract its native library somewhere writable.
mkdir -p "$WORKER_DIR/.runtime"
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Djava.io.tmpdir=$WORKER_DIR/.runtime -Dorg.xerial.snappy.tempdir=$WORKER_DIR/.runtime"
