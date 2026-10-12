#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "${1:-}" = "--test-count" ]; then
  XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-${TMPDIR:-/tmp}}"
  export XDG_CONFIG_HOME
  collected="$(./node_modules/.bin/vitest list --json --hideSkippedTests --passWithNoTests)"
  printf '%s' "$collected" | node -e '
    let data = "";
    process.stdin.on("data", chunk => { data += chunk; });
    process.stdin.on("end", () => {
      const tests = JSON.parse(data);
      if (!Array.isArray(tests) || tests.length === 0) {
        console.error("No runnable tests collected");
        process.exitCode = 1;
      } else {
        console.log(`Collected ${tests.length} runnable tests`);
      }
    });
  '
  exit
fi
if [ "${1:-}" = "--self-test-zero-tests" ]; then
  root="$(pwd)"
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/concord-zero-tests.XXXXXX")"
  trap 'rm -rf "$scratch"' EXIT HUP INT TERM
  mkdir -p "$scratch/scripts" "$scratch/tests/node"
  cp package.json vitest.config.ts wrangler.local.jsonc "$scratch/"
  cp scripts/validate.sh "$scratch/scripts/"
  cp tests/helpers.ts "$scratch/tests/"
  ln -s "$root/node_modules" "$scratch/node_modules"
  : > "$scratch/tests/node/empty.test.ts"
  if output="$(cd "$scratch" && sh scripts/validate.sh --test-count 2>&1)"; then
    echo "Empty test file unexpectedly passed the collection guard" >&2
    exit 1
  fi
  case "$output" in
    *"No runnable tests collected"*) echo "Empty test file rejected: No runnable tests collected" ;;
    *) printf '%s\n' "$output" >&2; exit 1 ;;
  esac
  exit
fi
if [ -z "${NPM_CONFIG_CACHE:-}" ]; then
  NPM_CONFIG_CACHE="${TMPDIR:-/tmp}/concord-npm-cache"
  export NPM_CONFIG_CACHE
fi
if [ -z "${XDG_CONFIG_HOME:-}" ]; then
  XDG_CONFIG_HOME="${TMPDIR:-/tmp}"
  export XDG_CONFIG_HOME
fi
if [ -z "${CONCORD_TEST_TIMEOUT_SCALE:-}" ]; then
  # The five-minute load average smooths short spikes during the suite.
  load="$(node -e 'process.stdout.write(String(require("node:os").loadavg()[1]))')"
  CONCORD_TEST_TIMEOUT_SCALE="$(node -e 'const n=Number(process.argv[1]); process.stdout.write(String(n < 8 ? 1 : n < 20 ? 2 : 3))' "$load")"
  export CONCORD_TEST_TIMEOUT_SCALE
fi
printf 'CONCORD_TEST_TIMEOUT_SCALE=%s\n' "$CONCORD_TEST_TIMEOUT_SCALE"
if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund
fi
npm run typecheck
npm test
