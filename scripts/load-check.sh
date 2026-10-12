#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

case "${1:-}" in
  --normal)
    sh scripts/validate.sh
    ;;
  --loaded)
    # Load is supplied by the host. This script never starts a load generator.
    for run in 1 2 3; do
      load="$(node -e 'process.stdout.write(String(require("node:os").loadavg()[1]))')"
      node -e 'const n=Number(process.argv[1]); if (n < 25 || n > 45) { console.error(`Five-minute load ${n} must be between 25 and 45`); process.exit(1) }' "$load"
      printf 'Loaded validation %s/3 (five-minute load %s)\n' "$run" "$load"
      CONCORD_TEST_TIMEOUT_SCALE=3 sh scripts/validate.sh
    done
    ;;
  *)
    echo 'Usage: sh scripts/load-check.sh --normal|--loaded' >&2
    exit 2
    ;;
esac
