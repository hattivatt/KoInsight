#!/bin/bash

set -e

BUMP_TYPE=${1:-patch}
if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major|prerelease)$ ]]; then
  echo "Invalid version bump type: $BUMP_TYPE"
  echo "Valid types: patch, minor, major, prerelease"
  exit 1
fi

# === Config ===
PACKAGE_DIRS=("apps/server" "apps/web" "packages/common")

# === Bump version using npm ===
VERSION=$(npm version "$BUMP_TYPE" --no-git-tag-version)

# === Apply version to each package.json ===
for DIR in "${PACKAGE_DIRS[@]}"; do
  jq --arg v "$VERSION" '.version = $v' "$DIR/package.json" > "$DIR/package.tmp.json" && mv "$DIR/package.tmp.json" "$DIR/package.json"
done

# === Commit version bump ===
git add .
git commit -m "chore: release $VERSION"

# === Tag and push ===
# Pushing the tag is what triggers the release: there is no registry job in
# this fork anymore, CI (.github/workflows/ci.yaml) still runs the test suite.
git tag "$VERSION"
git push origin master
git push origin "$VERSION"

# === Actions link (derived from origin, GitHub only) ===
ORIGIN=$(git remote get-url origin 2>/dev/null || true)
ACTIONS_URL=""
case "$ORIGIN" in
  git@github.com:*) ACTIONS_URL="https://github.com/${ORIGIN#git@github.com:}" ;;
  ssh://git@github.com/*) ACTIONS_URL="https://github.com/${ORIGIN#ssh://git@github.com/}" ;;
  https://github.com/*|http://github.com/*) ACTIONS_URL="$ORIGIN" ;;
esac
if [[ -n "$ACTIONS_URL" ]]; then
  ACTIONS_URL="${ACTIONS_URL%.git}/actions"
fi

echo "✅ Tag $VERSION pushed"
if [[ -n "$ACTIONS_URL" ]]; then
  echo "🔎 Check CI runs: $ACTIONS_URL"
else
  echo "🔎 Check CI runs in your repository's Actions tab."
fi
