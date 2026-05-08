#!/usr/bin/env bash
# Keep local `main` aligned with `origin/main`.
#
# CLAUDE.md forbids direct commits to main — every change merges via PR — so
# any divergence between local and origin is by definition stale state we want
# to discard. Run by the SessionStart hook in `.claude/settings.json`; safe to
# run manually too.
#
# Behavior:
#   - on main, clean tree           : git reset --hard origin/main
#   - on main, dirty tree           : log + skip (don't clobber the user's work)
#   - off main, local main exists   : git update-ref (no working-tree touch)
#   - off main, no local main yet   : create local main tracking origin/main
#   - no origin / fetch fails / no  : log + skip (offline-friendly)
#     origin/main
#
# All "skip" paths exit 0 — a session-start hook must never block the session.

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "resync-main: not inside a git repo, skipping" >&2
  exit 0
}
cd "$repo_root"

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "resync-main: no 'origin' remote, skipping" >&2
  exit 0
fi

if ! git fetch --quiet origin main 2>/dev/null; then
  echo "resync-main: 'git fetch origin main' failed, skipping" >&2
  exit 0
fi

origin_sha=$(git rev-parse --verify --quiet refs/remotes/origin/main) || {
  echo "resync-main: origin/main not found after fetch, skipping" >&2
  exit 0
}

local_sha=$(git rev-parse --verify --quiet refs/heads/main || true)
if [[ "$local_sha" == "$origin_sha" ]]; then
  exit 0
fi

current=$(git symbolic-ref --quiet --short HEAD || echo "")

if [[ "$current" == "main" ]]; then
  if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    echo "resync-main: on main with uncommitted changes; refusing to reset. Switch off main first." >&2
    exit 0
  fi
  git reset --hard "$origin_sha"
  echo "resync-main: reset main ${local_sha:-<none>} -> $origin_sha" >&2
  exit 0
fi

if [[ -z "$local_sha" ]]; then
  git update-ref refs/heads/main "$origin_sha"
  git config branch.main.remote origin
  git config branch.main.merge refs/heads/main
  echo "resync-main: created local main at $origin_sha" >&2
else
  git update-ref refs/heads/main "$origin_sha" "$local_sha"
  echo "resync-main: moved main $local_sha -> $origin_sha" >&2
fi
