#!/usr/bin/env bash
#
# Re-vendor the `rlms` library into public/rlm/ from upstream.
#
#   ./scripts/vendorRlm.sh                 # take upstream HEAD
#   ./scripts/vendorRlm.sh <commit-sha>    # pin a specific commit
#
# Why this exists: the sandbox image is built on sidecar hosts that may have a
# route to a master and nothing else. public/ is served from disk at request
# time, so whatever lands here is immediately fetchable at
# http://<master>:3000/rlm/rlms-latest.tar.gz — no rebuild, no restart.
#
# The tarball is trimmed to what `pip install .` actually needs (13 MB -> ~92 KB)
# and is TRACKED in git, unlike public/sideCar/builds which is ignored. A backup
# that is not committed is not a backup.

set -euo pipefail

REPO="https://github.com/alexzhang13/rlm"
PIN="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/public/rlm"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching $REPO${PIN:+ @ $PIN}..."
if [ -n "$PIN" ]; then
  git clone --quiet "$REPO" "$TMP/rlm"
  git -C "$TMP/rlm" checkout --quiet "$PIN"
else
  git clone --quiet --depth 1 "$REPO" "$TMP/rlm"
fi

cd "$TMP/rlm"
COMMIT="$(git rev-parse HEAD)"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' pyproject.toml | head -1)"
[ -n "$VERSION" ] || { echo "ERROR: could not read version from pyproject.toml" >&2; exit 1; }

# Licence must travel with the code into the image — MIT requires the notice be
# retained. If upstream ever drops it, stop rather than ship an unlicensed blob.
[ -f LICENSE ] || { echo "ERROR: upstream has no LICENSE file — refusing to vendor" >&2; exit 1; }

echo "  version=$VERSION commit=$COMMIT"

mkdir -p "$OUT"
TARBALL="$OUT/rlms-${VERSION}.tar.gz"
# Deterministic-ish: sort entries so an unchanged checkout produces a stable
# tarball and we can tell a real upstream change from tar noise.
tar czf "$TARBALL" pyproject.toml README.md LICENSE MANIFEST.IN rlm

SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
SIZE="$(wc -c < "$TARBALL" | tr -d ' ')"

PREV_COMMIT="$(sed -n 's/.*"commit": "\(.*\)".*/\1/p' "$OUT/manifest.json" 2>/dev/null || true)"
if [ "$PREV_COMMIT" = "$COMMIT" ]; then
  echo "Already at $COMMIT — nothing to update."
  exit 0
fi

cp "$TARBALL" "$OUT/rlms-latest.tar.gz"

cat > "$OUT/manifest.json" <<EOF
{
  "package": "rlms",
  "module": "rlm",
  "version": "$VERSION",
  "filename": "rlms-${VERSION}.tar.gz",
  "sha256": "$SHA",
  "size": $SIZE,
  "source": "$REPO",
  "commit": "$COMMIT",
  "vendoredAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "license": "MIT",
  "copyright": "Copyright (c) 2026 Alex Zhang",
  "paper": "arXiv 2512.24601 — Zhang, Kraska, Khattab",
  "contents": ["pyproject.toml", "README.md", "LICENSE", "MANIFEST.IN", "rlm/"],
  "excluded": ["media/", "docs/", "examples/", "tests/", "training/", "visualizer/", ".git/"],
  "note": "Trimmed to what \`pip install .\` needs. The excluded directories are documentation, paper media, the fine-tune training code and the trace visualizer; none are imported by the \`rlm\` module."
}
EOF

echo
echo "=== Vendored ==="
echo "  $TARBALL"
echo "  sha256 $SHA"
echo "  size   $SIZE bytes"
echo
echo "Previous commit: ${PREV_COMMIT:-none}"
echo "New commit:      $COMMIT"
echo
echo "Commit public/rlm/ — it is tracked on purpose."
