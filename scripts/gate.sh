#!/usr/bin/env bash
# The one "done" check. It tests a commit, not a working folder: the commit is checked out into a fresh
# temporary worktree, dependencies are installed from the lock files, the interface is built, and every
# suite runs, including the browser tests in all three engines that release validation uses.
#
#   scripts/gate.sh            # tests HEAD
#   scripts/gate.sh <commit>   # tests another commit or branch
#
# Untracked and uncommitted files are not in the worktree, so a change that only works because of a file
# that was never committed fails here.
#
# Settings (environment):
#   GATE_PYTHON    Python with requirements-lock.txt installed. Default: .venv/bin/python in this checkout.
#   GATE_BROWSERS  Browser projects to run. Default: "chromium firefox webkit". Leave the default before a push.
#   GATE_KEEP=1    Keep the temporary worktree afterwards (it is always kept when a step fails).
set -uo pipefail

root=$(git rev-parse --show-toplevel)
rev=${1:-HEAD}
sha=$(git -C "$root" rev-parse --verify "$rev^{commit}") || { echo "gate: unknown commit: $rev" >&2; exit 2; }
python=${GATE_PYTHON:-$root/.venv/bin/python}
browsers=${GATE_BROWSERS:-chromium firefox webkit}

[ -x "$python" ] || { echo "gate: no Python at $python. Create .venv (see AGENTS.md) or set GATE_PYTHON." >&2; exit 2; }
command -v node >/dev/null || { echo "gate: node is not on PATH (Node 22 or newer)." >&2; exit 2; }

work=$(mktemp -d "${TMPDIR:-/tmp}/little-archive-gate.XXXXXX")
tree=$work/tree
logs=$work/logs
mkdir -p "$logs"
git -C "$root" worktree add --quiet --detach "$tree" "$sha" || { echo "gate: could not create the worktree." >&2; exit 2; }

failed=0
cleanup() {
  if [ "$failed" -eq 0 ] && [ "${GATE_KEEP:-0}" != 1 ]; then
    git -C "$root" worktree remove --force "$tree" >/dev/null 2>&1
    rm -rf "$work"
  else
    echo "gate: worktree and logs kept at $work (remove with: git worktree remove --force \"$tree\")"
  fi
}
trap cleanup EXIT

# The browser harness and the phone app's tests start Python by name, so the chosen one goes first on PATH.
export PATH="$(dirname "$python"):$PATH"
cd "$tree" || exit 2

echo "gate: commit $sha"
echo "gate: node $(node --version), $("$python" --version 2>&1), browsers: $browsers"

step() {
  local name=$1; shift
  local log="$logs/$(echo "$name" | tr ' /' '--').log"
  if [ "$failed" -ne 0 ]; then echo "SKIP  $name"; return; fi
  if "$@" >"$log" 2>&1; then
    echo "PASS  $name  $(grep -aE '^(Ran [0-9]+ tests|# pass [0-9]+| +Tests +[0-9]+ passed.*| +[0-9]+ passed.*)' "$log" | tail -1 | sed 's/^ *//')"
  else
    failed=1
    echo "FAIL  $name  (log: $log)"
    tail -25 "$log"
  fi
}

step "install root"        npm ci
step "install ui"          npm --prefix ui ci
step "install mobile"      npm --prefix mobile ci
step "build ui"            npm --prefix ui run build
step "ui unit tests"       npm --prefix ui test
step "python tests"        "$python" -m unittest discover -s tests
step "web tests"           npm run test:web
step "mobile tests"        npm run test:mobile
step "extension tests"     npm run test:extension
step "e2e harness tests"   npm run test:e2e:infra
step "release check"       "$python" scripts/release_check.py
for browser in $browsers; do
  step "browser $browser"  npm run test:e2e -- --project="$browser"
done

if [ "$failed" -eq 0 ]; then echo "gate: PASS for $sha"; else echo "gate: FAIL for $sha"; fi
exit "$failed"
