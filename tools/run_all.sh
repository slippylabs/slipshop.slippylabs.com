#!/usr/bin/env bash
# Every node oracle, in dependency order. Must be green before a commit.
#
# The browser suites (playable*.py) are NOT run from here: they need the
# Playwright venv and a local server, and they must run one at a time.
# Oracles that drive headless Chromium directly (blend) are fine here --
# they are synchronous and short.
#
# Never run this at the same time as controls.sh: that script mutates the
# working tree and restores it between mutations, so a concurrent run reads
# half-mutated files and reports failures that are not real.
set -uo pipefail
cd "$(dirname "$0")/.."

TESTS="util color blend tiles doc composite effects history convolve adjust resample paint"
fail=0
for t in $TESTS; do
  printf '%-10s ' "$t"
  if out=$(node "tools/$t.mjs" 2>&1 | grep -v "WARNING:"); then
    echo "$out" | tail -1
  else
    echo "FAILED"
    echo "$out" | sed 's/^/    /' | tail -40
    fail=1
  fi
done
exit $fail
