#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -z "${NPM_CONFIG_CACHE:-}" ]; then
  NPM_CONFIG_CACHE="${TMPDIR:-/tmp}/concord-npm-cache"
  export NPM_CONFIG_CACHE
fi
if [ -z "${XDG_CONFIG_HOME:-}" ]; then
  XDG_CONFIG_HOME="${TMPDIR:-/tmp}"
  export XDG_CONFIG_HOME
fi
if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund
fi
npm run typecheck
npm test
