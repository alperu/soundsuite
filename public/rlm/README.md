# Vendored `rlms` — the Recursive Language Models library

This directory is a **pinned backup** of [alexzhang13/rlm](https://github.com/alexzhang13/rlm),
the reference implementation from *Recursive Language Models* (Zhang, Kraska,
Khattab — [arXiv 2512.24601](https://arxiv.org/abs/2512.24601)). It exists so the
`ss-rlm-sandbox` image can be built when GitHub is unreachable, the upstream repo
is renamed or taken down, or PyPI is unavailable.

Like `public/sideCar/builds/`, this is **served from disk at request time** — a
sidecar host builds the sandbox image by fetching it from a master:

```
http://<master>:3000/rlm/rlms-latest.tar.gz
http://<master>:3000/rlm/manifest.json
```

Unlike `public/sideCar/builds/`, it is **tracked in git** (that directory is
gitignored at `.gitignore:51`). A backup that is not committed is not a backup.
At 92 KB that is a trivial cost.

## Why not `pip install rlms`

Nothing stops you — the package *is* on PyPI as **`rlms`** (the distribution is
`rlms`; the importable module is `rlm` — a mismatch that is easy to trip over and
cost us one wrong conclusion already). Vendoring buys three things:

1. **Availability.** The sandbox image must build on an air-gapped or
   VPN-restricted host that has a route to a master and nothing else.
2. **Pinning with a checksum.** The manifest records both the version and the
   upstream commit (`854e688f`), and the Dockerfile verifies the sha256 after
   fetching — the same discipline `install.sh` applies to the sidecar tarball.
3. **Survivability.** It is a 0.1.x beta from a single maintainer.

## What was trimmed

13 MB checkout → 92 KB tarball. Kept: `pyproject.toml`, `README.md`, `LICENSE`,
`MANIFEST.IN`, `rlm/`. Dropped: `media/` (2.7 MB), `docs/` (2.6 MB),
`training/` (1.4 MB), `visualizer/` (536 KB), `tests/`, `examples/`. None are
imported by the `rlm` module; `pip install .` succeeds without them.

## Refreshing it

```bash
./scripts/vendorRlm.sh                 # re-fetch HEAD, re-trim, rewrite manifest
./scripts/vendorRlm.sh <commit-sha>    # pin a specific commit
```

The script refuses to overwrite unless the new checkout actually differs, and
always records the commit it took.

## Licence

MIT, Copyright (c) 2026 Alex Zhang. `LICENSE` is inside the tarball and must stay
there — it travels with the code into the image.
