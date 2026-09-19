---
paths:
  - "marketing/**"
---

# Marketing website (Statamic) — deploy rules

The marketing site at `marketing/website/` is a separate Statamic CMS project with its own git
repo. The entire `marketing/` tree is gitignored from the root repo, so it never shows in
`git status` here. Production is `soundsuite.ai`.

**Local dev:** `cd marketing/website/src && composer dev` runs Statamic on
`http://localhost:8000`. Stache is the content cache — refresh after editing files:
`php artisan statamic:stache:refresh`.

## Deploy scripts

Both are rsync-based over SSH (helpers `rsync_files` / `rsync_one` / `rsync_tree` in
`scripts/private/_common.sh`). SSH credentials live in `scripts/private/.passw` (`HOST`,
`USERNAME`, `REMOTE_PATH`, `PORT`, `SSH_KEY_PATH`, `SSH_KEY_PASSPHRASE`, `PASSWORD`).

- **`scripts/private/deploy.sh`** — full-site deploy. Builds vite, runs
  `composer install --no-dev`, rsyncs `src/` with `--exclude-from` (no `--delete`, so `.env`,
  `storage/`, `public/exhibits/` are preserved), then cache flush + `statamic:static:clear`.
  Interactive `y/N` unless `--yes`.
- **`scripts/update-remote.sh`** — composer-only deploy. Rsyncs `composer.json` +
  `composer.lock`, runs `composer install --no-dev --no-scripts` on the server, then
  `package:discover`, cache flush, and an OPcache reset via a token-gated endpoint. Use for
  routine dependency bumps paired with `update-local.sh` / `update-statamic.sh` /
  `update-mcp-plugin.sh`.

⚠️ **`marketing/website/scripts/private/` is gitignored**, so `deploy.sh` and `upload.sh` — and
every landmine fix in them — exist only on whichever machine last edited them. The fixes for
landmines #5, #6 and #7 live in those two files. If that directory is lost, those bugs return
silently and the next deploy reverts production passwords and MCP tokens again. Recommended:
track `deploy.sh` and `upload.sh` in git and keep only `.passw` ignored. Until then, re-verify
before trusting a deploy from an unfamiliar checkout:

```bash
cd marketing/website/scripts/private && ./deploy.sh --dry-run --skip-build > /tmp/dry.txt
grep -cE '^users/|storage/statamic-mcp|storage/statamic/updater' /tmp/dry.txt   # must be 0
grep -n 'package:discover\|statamic:addons:discover' deploy.sh                  # must be present
```

## Deploy landmines — DO NOT re-introduce

1. **Never add `php artisan vendor:publish --tag=statamic --force` to any deploy or update
   script.** The `statamic` tag is a superset that includes `statamic-config`, which overwrites
   every `config/statamic/*.php` with the vendor default. On 2026-04-14 this took the site
   down: `users.php` reverted from `'repository' => 'file'` to `'eloquent'`, which 500'd the
   CP because Eloquent queried a users table this file-repo site doesn't have. If CP/frontend/
   addon **assets** need re-publishing after a major upgrade, publish only the asset groups
   manually (`--tag=statamic-cp`, `--tag=statamic-frontend`, `--tag=statamic-mcp`,
   `--tag=seo-pro`) and never `--force` configs. Routine deploys should not publish at all.
2. **Remote composer detection must validate executability, not just presence.**
   `composer.phar` lives at `~/public_html/composer.phar` and is NOT in `$PATH`. A naive
   `[ -x "$candidate" ]` with a bare name resolves via cwd, but bash command exec won't search
   cwd — `COMPOSER="composer.phar"; "$COMPOSER" install` fails with "command not found". Use
   `command -v`'s resolved path, or require a `/` in the candidate before accepting `[ -x ]`.
   This caused the 2026-04-14 outage (stage 1 silently skipped `composer install`; stage 2 ran
   `--force` publish against a lockfile mismatch).
3. **`composer install | tail -N` under plain `set -e` masks failures.** Pipelines report the
   last command's status (0 from `tail`). Use `set -eo pipefail` in any remote stage script
   that pipes composer/artisan through `tail`.
4. **Static cache:** every deploy must end with `php artisan statamic:static:clear` or content
   changes won't appear until files age out. ⚠️ As of 2026-09-18 production reports
   `Static caching is not enabled` — the server `.env` no longer sets
   `STATAMIC_STATIC_CACHING_STRATEGY=full`. The clear is harmless while disabled (non-zero
   exit swallowed by `|| true`), but if you re-enable caching, confirm the clear actually runs.
   Unresolved: restore the env var or drop the claim.
5. **Server-owned state must be rsync-excluded, or deploys silently revert it.** "No
   `--delete`" only protects files that exist *solely* on the server; a file present on both
   sides gets **overwritten**. Anything the production CP writes must be excluded in
   `deploy.sh`'s `EXCLUDES` heredoc **and** in `upload.sh`'s `is_unsafe_path()`. Three found on
   2026-09-18, all silently clobbering production for months:
   - **`users/`** — Statamic runs `'repository' => 'file'`, so CP accounts and bcrypt
     `password_hash` live in `users/*.yaml`. A deploy would have reverted the production CP
     password to the local checkout's (local vs remote checksums differed).
   - **`storage/statamic-mcp/`** — MCP API tokens (`tokens/*.yaml` + `tokens/.index`), OAuth
     clients, audit log. Tokens are minted in the production CP, but every deploy pushed a
     local snapshot over them. The server held an April 13 file byte-identical to local
     including mtime. This is why MCP auth kept failing with 401 no matter how often the
     token was regenerated.
   - **`storage/statamic/updater/`** — Statamic's update-check cache; shipping it makes the CP
     Updates screen report this machine's view instead of the server's.

   Diagnostic that settles it in one shot: compare `cksum` + mtime of the same file local vs
   remote. `rsync -a` preserves mtime, so identical mtimes prove the server is holding the
   rsynced local copy rather than its own state.
6. **`deploy.sh` must rebuild BOTH manifests, before any `*:cache` command.**
   `bootstrap/cache/` is rsync-excluded (correctly — server-owned), so after an addon upgrade
   the server keeps the OLD manifests until rebuilt; new `vendor/` files do not touch them.
   Neither rebuilds the other:
   - `php artisan package:discover` → `bootstrap/cache/packages.php` + `services.php`
   - `php artisan statamic:addons:discover` → `bootstrap/cache/addons.php`

   Observed 2026-09-18: a deploy shipped `statamic-mcp v2.10.1` into `vendor/`, but the CP
   Updates screen kept reporting `2.8.0` because `addons.php` was still the Aug 8 build while
   `installed.json` and `composer.lock` were correct. **"Core current but addons stale" is the
   signature.** Use `statamic:addons:discover`, **NOT** `statamic:install` — install also
   publishes vendor assets, which is landmine #1's blast radius.
7. **`update-all.sh` / `update-local.sh` must point at `update-remote.sh`, never
   `private/upload.sh`.** `upload.sh` has no composer handling — it rsyncs files and runs
   view/cache/stache clears. Deploying a composer bump through it leaves remote with a **new
   `composer.lock` and the old `vendor/`** (the 2026-04-14 outage shape) and skips
   `statamic:static:clear`.

## MCP 401 debugging (`AUTH_HEADER_REJECTED` / "Provide a Bearer token")

Work server side and client side separately — in 2026-09 both were broken at once, which made
each fix look ineffective.

- **Client:** `.mcp.json` must carry the scheme — `"Authorization": "Bearer <token>"`. A bare
  token produces *"Provide a Bearer token or Basic Auth credentials"*, the missing-credential
  message, not an invalid-token one. That wording is the tell.
- **Server:** confirm the token exists on *that* host:
  `ls -l --time-style=full-iso storage/statamic-mcp/tokens/`. If the newest file predates the
  token you just created, a deploy reverted the store (landmine #5) or you created it in a
  different site's CP. `soundsuite.ai` and `project-sandstar.org` are separate installs with
  separate token stores.
- The endpoint is `POST /mcp/statamic` (`php artisan route:list --path=mcp` confirms).
  `public/.htaccess` already carries the `HTTP_AUTHORIZATION` rewrite, so header stripping is
  not the usual cause.
- Repeated failures trip a rate limit returning **429 "Too many authentication attempts"**. Let
  it clear before retrying, or a correct token still looks broken.
- `claude mcp add` takes name and URL positionally — no `--url` flag:
  `claude mcp add --transport http --scope project statamic <url> --header "Authorization: Bearer <token>"`.
  Omit `--scope project` and it lands in local scope instead of `.mcp.json`.

**`statamic-mcp` 3.0 (Laravel MCP 1.0):** requires `laravel/mcp ^1.0` and lists only 3 of 11
tools by default, exposing the rest via `search_tools`/`execute_tools`. This site sets
`STATAMIC_MCP_SEARCHABLE_CATALOG=false` in the server `.env` to list all tools directly
(config key `statamic.mcp.catalog.searchable`). `.env` is rsync-excluded, so env changes are
made on the server **and followed by `config:clear && config:cache`**.

## Blog index gotcha

`marketing/website/src/resources/views/blog.antlers.html` must use
`{{ collection:articles sort="date:desc" }}`. Hardcoded `<a href="/blog/...">` tags there mean
new posts never appear. Add a post by dropping
`marketing/website/src/content/collections/articles/YYYY-MM-DD.{slug}.md` matching the `blog`
blueprint (`title`, `subtitle`, `author`, `category`, `reading_time`, `date` as unix timestamp).

## Verifying a deploy

```bash
curl -s --max-time 10 -o /dev/null -w "%{http_code}\n" https://soundsuite.ai/blog
curl -s --max-time 10 https://soundsuite.ai/blog | grep -oE 'href="/blog/[a-z-]+"' | sort -u
```
