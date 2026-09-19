---
paths:
  - "sideCar/**"
  - "public/sideCar/**"
  - "scripts/buildSidecar.sh"
  - "scripts/publishSidecarGithub.sh"
---

# Sidecar build & release

```bash
rm -rf sideCar/.next                          # ALWAYS first — stale cache ships old code
./scripts/buildSidecar.sh [major|minor|patch] # default patch; run from project root
```

The build bumps `sideCar/package.json`, builds, stages a tarball, and publishes
`sidecar-latest.tar.gz` + `manifest.json` (version, sha256) to `public/sideCar/builds/`. Hosts
install by curling `install.sh` from a master, which reads the manifest, verifies the checksum
and extracts to `./sidecar/`. A stale `.next` causes `ENOENT: rename 500.html` and can silently
package old compiled output even when source changed.

## The launcher is copied, never generated

`public/sideCar/scripts/start.sh` is the single source of truth: the same file is what
operators curl standalone and what ships inside the tarball. `buildSidecar.sh` copies it, then
greps the staged copy for the `--docker` arm; a launcher that cannot parse `--docker` fails
the build.

This rule exists because it was violated. The build used to generate `start.sh` from an inline
heredoc. The standalone copy grew `--docker`/`-d` parsing, Mac `SS_HOST_OLLAMA=1` defaulting and
`EXTERNAL_IP` detection; the heredoc got none of it. Every tarball shipped a launcher that took
`--docker` as the master URL → `SOUND_SUITE_MASTER_URL=--docker`, an "Invalid URL" reconnect
loop, and Node mode instead of a container, so Macs ran CPU-only Ollama with no error saying so.

- **Change the launcher in `public/sideCar/scripts/start.sh`, never in the build script.** If
  you are editing launcher text inside `buildSidecar.sh`, stop — that is the defect returning.
- **Every flag must be stripped before the master URL is read.** The URL is the first
  *remaining* positional arg. `install.sh`, `install.bat` and `start.sh` each parse args; all
  three must strip, and must reject an unknown `-*` rather than treat it as a URL.
- **`start.bat` is still heredoc-generated** and deliberately differs from
  `public/sideCar/scripts/start.bat` (Docker-only) — the shipped one keeps the Node fallback
  Windows hosts rely on. Do not unify without checking what the Windows fleet runs.
- **Docs and scripts must agree.** `public/docs/install-sidecar.md` is rendered at `/docs`
  with `{{MASTER_URL}}` substituted and is what operators copy. A flag in the doc must be
  implemented by the script.

## Verify a build before releasing

Check the staged launcher, not the source:

```bash
tar tzf public/sideCar/builds/sidecar-latest.tar.gz | head
mkdir -p /tmp/sctest && tar xzf public/sideCar/builds/sidecar-latest.tar.gz -C /tmp/sctest
grep -n 'FORCE_DOCKER' /tmp/sctest/sidecar/start.sh   # must be present
```

Then exercise the real install path against a running master — the only check that covers
`install.sh`, the manifest, the checksum and the launcher together:

```bash
cd $(mktemp -d) && curl -fsSL http://<master>:3000/sideCar/scripts/install.sh -o install.sh \
  && chmod +x install.sh && ./install.sh --docker http://<master>:3000
```

The header must echo `Server: http://<master>:3000`, **not** `Server: --docker`.

A release is live on a host only once that host reports the new version at `/status.version`.
`public/` is served from disk at request time, so a fixed `install.sh` / `start.sh` is live to
operators immediately; a new *tarball* still needs `buildSidecar.sh`.

## Public mirror + GitHub Releases

`sideCar/` is also published as `github.com/Project-SandStar/SideCar` (remote `sandstar`) via
`git subtree split --prefix=sideCar`:

```bash
./scripts/buildSidecar.sh patch
git commit -am "Release sidecar X.Y.Z …" && git push
./scripts/publishSidecarGithub.sh   # subtree push → sandstar/main, tag vX.Y.Z, GitHub Release
```

The publish script is idempotent and never force-pushes. It refuses if `sideCar/` has
uncommitted changes, if HEAD's `sideCar/package.json` does not carry the version being
published, or if the split would not fast-forward the mirror (merge the mirror's commits into
`sideCar/` here first). A published tag is never moved; bump and release again.
