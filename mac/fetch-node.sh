#!/bin/bash
#
# Public source-build helper.
#
# Official SpecterSync releases vendor and verify their runtime through the
# private release pipeline. Public local builds use the Node.js binary already
# installed on the contributor's machine, avoiding network binary downloads.

set -euo pipefail
cd "$(dirname "$0")"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node is required for local macOS builds. Install Node.js 20+ first." >&2
  exit 1
fi

NODE_VERSION="$("$NODE_BIN" --version)"
MAJOR="${NODE_VERSION#v}"
MAJOR="${MAJOR%%.*}"
if [ "$MAJOR" -lt 20 ]; then
  echo "ERROR: Node.js 20+ is required, found ${NODE_VERSION} at ${NODE_BIN}" >&2
  exit 1
fi

mkdir -p vendor
cp "$NODE_BIN" vendor/node
chmod +x vendor/node

echo "Using local Node ${NODE_VERSION} from ${NODE_BIN} -> vendor/node"
