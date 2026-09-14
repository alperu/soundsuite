#!/usr/bin/env bash
# Publish a sidecar release to the public mirror: github.com/Project-SandStar/SideCar
#
#   ./scripts/publishSidecarGithub.sh            # version from sideCar/package.json at HEAD
#   ./scripts/publishSidecarGithub.sh 2.3.84     # explicit version
#
# What it does, in order (each step is idempotent, so re-running is safe):
#   1. `git subtree split --prefix=sideCar` — the mirror's history IS this split,
#      so the new split commits fast-forward onto the mirror's main. Refuses to
#      push if they would not (never force-pushes).
#   2. Pushes the split to the `sandstar` remote's main.
#   3. Pushes a tag `v<version>` pointing at the split commit.
#   4. Creates a GitHub Release `v<version>` with the tarball + manifest that
#      buildSidecar.sh wrote to public/sideCar/builds/ as assets.
#
# Preconditions (checked, with a message saying which one failed):
#   - sideCar/ has no uncommitted changes — the split is taken from HEAD, so an
#     uncommitted version bump would publish a tag whose tree says the old version.
#   - sideCar/package.json at HEAD carries <version>, and the tarball + manifest
#     for <version> exist (i.e. buildSidecar.sh ran and its bump was committed).
#   - `gh` is logged in with push access to the mirror.
#
# Run it AFTER committing the release (build → commit → this). buildSidecar.sh
# prints the reminder.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

REMOTE="${SIDECAR_MIRROR_REMOTE:-sandstar}"
GH_REPO="${SIDECAR_MIRROR_REPO:-Project-SandStar/SideCar}"
BUILDS_DIR="$REPO_ROOT/public/sideCar/builds"
PREFIX="sideCar"

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not found (brew install gh)" >&2; exit 1
fi
if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "error: git remote '$REMOTE' is not configured. Add it with:" >&2
  echo "  git remote add $REMOTE git@github.com:$GH_REPO.git" >&2
  exit 1
fi

# --- Version ---
HEAD_VERSION=$(git show HEAD:$PREFIX/package.json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")
VERSION="${1:-$HEAD_VERSION}"
TAG="v$VERSION"
TARBALL="$BUILDS_DIR/sidecar-v${VERSION}.tar.gz"
MANIFEST="$BUILDS_DIR/manifest.json"

if [ "$VERSION" != "$HEAD_VERSION" ]; then
  echo "error: HEAD has sideCar/package.json version $HEAD_VERSION, asked to publish $VERSION." >&2
  echo "       Commit the version bump first so the tag's tree matches the release." >&2
  exit 1
fi
if [ -n "$(git status --porcelain -- "$PREFIX")" ]; then
  echo "error: $PREFIX/ has uncommitted changes. Commit the release first — the mirror is split from HEAD." >&2
  git status --short -- "$PREFIX" >&2
  exit 1
fi
if [ ! -f "$TARBALL" ]; then
  echo "error: $TARBALL not found. Run ./scripts/buildSidecar.sh first." >&2; exit 1
fi
MANIFEST_VERSION=$(node -p "require('$MANIFEST').version")
if [ "$MANIFEST_VERSION" != "$VERSION" ]; then
  echo "error: $MANIFEST is for $MANIFEST_VERSION, not $VERSION. Rebuild, or publish $MANIFEST_VERSION." >&2
  exit 1
fi
CHECKSUM=$(node -p "require('$MANIFEST').sha256")
SIZE=$(node -p "require('$MANIFEST').size")

echo "=== Publishing SideCar $TAG to $GH_REPO ==="

# --- 1. Split ---
echo "Splitting $PREFIX/ history (this can take a moment)..."
git fetch -q "$REMOTE" main
SPLIT=$(git subtree split --prefix="$PREFIX" -q)
echo "  split commit: $(git rev-parse --short "$SPLIT")  mirror main: $(git rev-parse --short "$REMOTE/main")"
if ! git merge-base --is-ancestor "$REMOTE/main" "$SPLIT"; then
  echo "error: the split does not fast-forward the mirror's main." >&2
  echo "       Someone committed directly to $GH_REPO. Merge that into $PREFIX/ here first; this script never force-pushes." >&2
  exit 1
fi

# --- 2. Push main ---
if [ "$(git rev-parse "$REMOTE/main")" = "$SPLIT" ]; then
  echo "  mirror main already at split — nothing to push"
else
  echo "  pushing $(git rev-list --count "$REMOTE/main..$SPLIT") commit(s) to $REMOTE/main"
  git push -q "$REMOTE" "$SPLIT:refs/heads/main"
fi

# --- 3. Tag ---
if git ls-remote --exit-code --tags "$REMOTE" "refs/tags/$TAG" >/dev/null 2>&1; then
  EXISTING=$(git ls-remote --tags "$REMOTE" "refs/tags/$TAG" | cut -f1)
  if [ "$EXISTING" != "$SPLIT" ]; then
    echo "error: tag $TAG already exists on the mirror at ${EXISTING:0:8}, but this split is $(git rev-parse --short "$SPLIT")." >&2
    echo "       A published tag is never moved. Bump the version and release again." >&2
    exit 1
  fi
  echo "  tag $TAG already on mirror"
else
  git push -q "$REMOTE" "$SPLIT:refs/tags/$TAG"
  echo "  tagged $TAG"
fi

# --- 4. GitHub Release ---
if gh release view "$TAG" --repo "$GH_REPO" >/dev/null 2>&1; then
  echo "  release $TAG already exists — uploading any missing assets"
  gh release upload "$TAG" --repo "$GH_REPO" --clobber "$TARBALL" "$MANIFEST"
else
  SUBJECT=$(git log -1 --format=%s "$SPLIT")
  NOTES_FILE=$(mktemp)
  # Quoted heredoc delimiter: the body is literal, so backticks and apostrophes
  # are safe (macOS bash 3.2 chokes on them inside $(...)). Placeholders are
  # substituted afterwards.
  cat > "$NOTES_FILE" <<'NOTES'
@SUBJECT@

| | |
|---|---|
| Tarball | `sidecar-v@VERSION@.tar.gz` |
| SHA-256 | `@CHECKSUM@` |
| Size | @SIZE@ bytes |

Install (Docker mode, recommended; replace the master URL with yours):

```bash
curl -fsSL http://<master>:3000/sideCar/scripts/install.sh -o install.sh \
  && chmod +x install.sh && ./install.sh --docker http://<master>:3000
```

Running sidecars pick this version up automatically from their master's manifest.
NOTES
  sed -i '' \
    -e "s|@SUBJECT@|$(printf '%s' "$SUBJECT" | sed 's/[&|]/\\&/g')|" \
    -e "s|@VERSION@|$VERSION|g" \
    -e "s|@CHECKSUM@|$CHECKSUM|" \
    -e "s|@SIZE@|$SIZE|" \
    "$NOTES_FILE"
  gh release create "$TAG" --repo "$GH_REPO" \
    --title "SideCar $TAG" \
    --notes-file "$NOTES_FILE" \
    --target "$SPLIT" \
    "$TARBALL" "$MANIFEST"
  rm -f "$NOTES_FILE"
  echo "  created release $TAG"
fi

echo ""
echo "=== Published ==="
echo "  https://github.com/$GH_REPO/releases/tag/$TAG"
