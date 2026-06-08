# CI/CD & Release Automation

How this repository builds, versions, and ships releases. Automated versioning is
driven by [release-please](https://github.com/googleapis/release-please-action) +
[Conventional Commits](https://www.conventionalcommits.org/); the release artifacts
(GHCR image + buildable zip) are built on the version tag.

> Pattern adapted from `axon-mcp-server/docs/cicd/README.md`, reconciled with this
> repo's existing Docker workflows. See also [`../ci-cd.md`](../ci-cd.md) for the
> Docker image / zip details.

---

## TL;DR

- **Versioning + changelog + GitHub Releases** are automated with **release-please**,
  driven by **Conventional Commit** messages/PR titles.
- On every push to `main`, release-please keeps a **"release PR"** open (bumping
  `package.json` + `CHANGELOG.md`). **Merging that PR** tags `vX.Y.Z` and publishes a
  GitHub Release.
- That tag then triggers the artifact builds: **`docker-publish.yml`** pushes the
  image to **GHCR**, and **`release-zip.yml`** attaches a buildable source zip.
- A **fine-grained PAT** in repo secret **`RELEASE_PLEASE_TOKEN`** is used so
  release-please can (1) open PRs and (2) create a tag that **triggers** the artifact
  workflows. (A tag made by the default `GITHUB_TOKEN` does not trigger other workflows.)

---

## Moving parts

| File | Purpose |
| --- | --- |
| `.github/workflows/ci.yml` | Build + test on every PR and push to `main`. |
| `.github/workflows/release.yml` | release-please: version bump + CHANGELOG + tag + GitHub Release. |
| `.github/workflows/docker-publish.yml` | On `vX.Y.Z` tag → build & push the GHCR image (`ghcr.io/<owner>/soundsuite`). Also builds (no push) on PRs to validate the Dockerfile. |
| `.github/workflows/release-zip.yml` | On `vX.Y.Z` tag → attach the buildable source zip to the Release (appends install instructions to release-please's notes). |
| `release-please-config.json` | release-please config (`release-type: node`, pre-1.0 bump rules, changelog path). |
| `.release-please-manifest.json` | Tracks the current released version (`{ ".": "0.1.0" }`). |
| `package.json` | Source of truth for the version release-please bumps. |
| `CHANGELOG.md` | Generated/maintained by release-please. |

### `ci.yml`

Runs on `pull_request` and pushes to `main`:

```
checkout → setup-node 22 (npm cache) → npm ci → npx prisma generate → npm test (informational) → npm run build
```

`prisma generate` runs before the build because route modules import the generated
client. The build sets a throwaway `DATABASE_URL` (`file:/tmp/ci-build.db`) because
several routes open SQLite at import time (mirrors the Dockerfile builder). Tests are
`continue-on-error` for now so one environment-sensitive test doesn't block PRs.

### `release.yml`

One job, `release-please`, that opens/updates the release PR and — when that PR is
merged — creates the tag + GitHub Release. It authenticates with
`RELEASE_PLEASE_TOKEN` (falling back to `GITHUB_TOKEN`). Outputs `release_created`,
`tag_name`, `version`.

The tag it creates is what drives the artifact workflows below.

---

## How a release happens

```
commit (Conventional Commits) ─▶ push/merge to main
        │
        ▼
release-please opens/updates a "release PR"  (bumps package.json + CHANGELOG.md)
        │
        ▼   (you) Squash & merge the release PR
        │
        ▼
release-please creates tag vX.Y.Z + GitHub Release
        │
        ├─▶ docker-publish.yml: buildx → push ghcr.io/<owner>/soundsuite:X.Y.Z (+ X.Y, X, latest)
        └─▶ release-zip.yml:    git archive → soundsuite-X.Y.Z.zip → attach to the Release
```

### Version bumps (Conventional Commits)

release-please reads commit messages (and squash-merge **PR titles**) on `main`:

| Commit / PR-title prefix | Result (pre-1.0, this repo) |
| --- | --- |
| `fix: …` | patch — `0.y.Z` |
| `feat: …` | minor — `0.Y.0` |
| `feat!: …` or `BREAKING CHANGE:` | minor while < 1.0 (`bump-minor-pre-major`) |
| `chore: / docs: / ci: / refactor: …` | no release on their own |

`bump-minor-pre-major` + `bump-patch-for-minor-pre-major` are set in
`release-please-config.json` so breaking changes don't jump to a premature 1.0 while
the project is still `0.x`.

> **Merge method = Squash and merge.** With squash, GitHub uses the **PR title** as the
> commit message on `main`, so keep **PR titles in Conventional Commit format**. Lock it
> in: *Settings → General → Pull Requests* → allow only squash merging, default message
> = "Pull request title".

---

## The token: `RELEASE_PLEASE_TOKEN` (two reasons)

A fine-grained **Personal Access Token** is stored as the repo secret
**`RELEASE_PLEASE_TOKEN`** and passed to the action
(`token: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}`):

1. **PR creation** — many orgs/enterprises force the default `GITHUB_TOKEN` to
   read-only and block "Allow GitHub Actions to create and approve pull requests";
   release-please *opens a PR*, so it needs the PAT there.
2. **Triggering the artifact builds** — GitHub deliberately does **not** trigger
   workflows from a tag/release created by the default `GITHUB_TOKEN` (anti-recursion).
   Creating the tag with a **PAT** means the `vX.Y.Z` tag **does** trigger
   `docker-publish.yml` and `release-zip.yml`.

Create it at https://github.com/settings/personal-access-tokens:
- Resource owner: the repo's owner/org · Repository access: only this repo
- Permissions: **Contents: Read and write**, **Pull requests: Read and write**

Then add it under *Settings → Secrets and variables → Actions* as `RELEASE_PLEASE_TOKEN`.

> Without the PAT, the version/changelog/release still works **only if** the org allows
> `GITHUB_TOKEN` PR creation, and the image/zip would **not** auto-build on the tag —
> you'd push the tag manually or run the workflows via `workflow_dispatch`.

---

## Cutting a release

### Normal flow
1. Land work on `main` via squash-merged PRs with Conventional Commit titles.
2. release-please keeps a **"chore(main): release X.Y.Z"** PR open.
3. **Merge** it → tag + Release + GHCR image + zip asset appear automatically.

### Bootstrapping the first release
This repo's existing history doesn't use strict `feat:`/`fix:` prefixes, so release-please
won't propose a bump on its own. Force the initial release with an empty `Release-As`
commit (current `package.json` is `0.1.0`):

```bash
git commit --allow-empty -m "chore: release 0.1.0" -m "Release-As: 0.1.0"
git push origin main
```

release-please then opens the release PR for `0.1.0`; merging it ships it (and from then
on, normal Conventional-Commit bumps apply).

---

## The artifacts

- **GHCR image** — `ghcr.io/<owner>/soundsuite:X.Y.Z` (+ `X.Y`, `X`, `latest`), built by
  `docker-publish.yml` (linux/amd64; arm64 is a follow-up). Pull:
  `docker pull ghcr.io/<owner>/soundsuite:X.Y.Z`.
- **Buildable zip** — `soundsuite-X.Y.Z.zip`, the Docker build context for people who want
  to build their own image (`unzip … && docker build -t soundsuite .` or `docker compose up`).
  Built by `release-zip.yml`. Details: [`../ci-cd.md`](../ci-cd.md).

### Building artifacts manually (no PAT needed)

Both artifact workflows also accept a **`workflow_dispatch`** with a `tag` input, so you can
(re)build for an existing tag from the **Actions** tab — useful if a release was tagged with
the default `GITHUB_TOKEN` (which doesn't trigger tag workflows), or to re-run a failed build:

- *Actions → **Docker Publish** → Run workflow* → `tag = vX.Y.Z` → builds & pushes the image.
- *Actions → **Release Zip** → Run workflow* → `tag = vX.Y.Z` → rebuilds & attaches the zip.

The tag must already exist. (PRs still build the Docker image without pushing, to validate it.)

---

## Verifying a release (no `gh` needed)

```bash
REPO=<owner>/soundsuite
curl -sS "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -E '"tag_name"|"name"|"browser_download_url"|"size"'
curl -sS "https://api.github.com/repos/$REPO/tags" | grep '"name"'
curl -sS "https://api.github.com/repos/$REPO/actions/runs?per_page=5" \
  | grep -E '"name"|"display_title"|"conclusion"'
```

Or watch the **Actions** tab (Release / Build and Push Image / Release Zip runs) and the
**Releases** tab. Image visibility/tags: the repo's **Packages** page.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| No release PR after pushing to `main` | Only `chore:`/`docs:` commits, or PAT missing under an org that blocks `GITHUB_TOKEN` PRs | Push a `feat:`/`fix:` (or a `Release-As:` commit); ensure `RELEASE_PLEASE_TOKEN` is set |
| Release PR errors on creation | Org/enterprise blocks `GITHUB_TOKEN` PR creation | Set `RELEASE_PLEASE_TOKEN` (PAT or GitHub App token) |
| Release created but **no image / no zip** | Tag was created by `GITHUB_TOKEN` (doesn't trigger tag workflows) | Use the PAT so the tag triggers them, or re-run docker-publish/release-zip manually |
| Wrong version proposed | PR titles not Conventional | Fix the PR title; release-please updates the open PR |
| Release notes look wrong / duplicated | `release-zip.yml` appends install instructions below release-please's notes | Expected; the changelog lives in `CHANGELOG.md` and the GitHub Release |
| Image missing a tag (`X.Y`, `latest`) | `docker-publish.yml` metadata config | Check the Build and Push Image run |

---

## Appendix: data safety

Releases ship **code only** — `.gitignore` excludes the database, LanceDB vectors,
`public/exhibits/`, and `marketing/`, and `release-zip.yml` strips `sideCar/`. The
Docker image creates a **blank** database on first run (see `docker/entrypoint.sh`);
no real case data is ever in the repo, the image, or the zip.
