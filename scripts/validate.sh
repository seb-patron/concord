#!/bin/sh
# Repo gate. Phase 0 (design): required docs exist and are non-empty.
# Replaced by the real build/test gate once code lands.
set -eu
cd "$(dirname "$0")/.."
test -s LICENSE
for f in docs/ARCHITECTURE.md docs/DEMO.md docs/specs/README.md; do
  if [ -e "$f" ]; then test -s "$f" || { echo "empty: $f"; exit 1; }; fi
done
if [ -f package.json ]; then npm test --silent; fi
echo "validate: ok"
