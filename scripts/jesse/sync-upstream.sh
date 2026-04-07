#!/usr/bin/env bash
# Jesse fork: rebase our patches onto the next upstream release tag.
#
# Model: fork main = <upstream release tag> + <our patches>.
# We never merge upstream/main directly — only move forward to tagged releases.
# The tag we're currently rebased on is tracked in .jesse-upstream-base.
#
# Usage:   bash scripts/jesse/sync-upstream.sh [target-tag]
# Example: bash scripts/jesse/sync-upstream.sh                # auto-picks latest non-beta tag
#          bash scripts/jesse/sync-upstream.sh v2026.4.7      # explicit target
#
# On conflict, the rebase halts — resolve manually, `git rebase --continue`,
# then re-run this script to finish the build + pack steps.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [[ ! -f .jesse-upstream-base ]]; then
  echo "error: .jesse-upstream-base missing — cannot determine current base tag" >&2
  exit 1
fi

if [[ -n $(git status --porcelain) ]]; then
  echo "error: working tree not clean. commit or stash first." >&2
  exit 1
fi

git fetch upstream --tags --prune

CURRENT=$(cat .jesse-upstream-base)
TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  TARGET=$(git tag -l 'v2026.*' --sort=-v:refname | grep -v -- '-beta' | head -1)
fi

if [[ -z "$TARGET" ]]; then
  echo "error: no release tag found" >&2
  exit 1
fi

if [[ "$CURRENT" == "$TARGET" ]]; then
  echo "already at $TARGET — nothing to do"
  exit 0
fi

echo "rebasing patches: $CURRENT → $TARGET"
echo "  patches being replayed:"
git log --oneline "$CURRENT"..HEAD

read -r -p "proceed with rebase? [y/N] " reply
[[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "aborted"; exit 1; }

git rebase --onto "$TARGET" "$CURRENT" main

echo "$TARGET" > .jesse-upstream-base
git add .jesse-upstream-base

# Amend the top patch commit to include the updated base marker,
# so history stays as a single clean patch commit on top of the tag.
git commit --amend --no-edit --no-verify

echo
echo "rebase done. building..."
pnpm install --frozen-lockfile
pnpm build

echo
echo "✅ rebased and built on $TARGET"
echo
echo "next steps:"
echo "  1. review:       git log $TARGET..HEAD"
echo "  2. push:         git push --force-with-lease origin main"
echo "  3. ship to EC2:  bash scripts/jesse/pack-and-ship.sh"
