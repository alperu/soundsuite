# Task 55 — Profile CRUD: edit, rename, delete from the sidebar

**Date:** 2026-09-19 · **Status:** shipped · **Parent:** [`54-profiles.md`](./54-profiles.md)

No case names, docket numbers, party names or file names appear in this document.

## The ask

> Add profile CRUD operations; add an edit button next to the dropdown. We should be able to
> delete a profile too.

## What shipped

**Sidebar** (`src/components/profile-switcher.tsx`): a pencil button beside the profile dropdown
opens an inline panel for the active profile, with a selector to edit any other one.

| Field / action | Any profile | Only when NOT active |
|---|---|---|
| Display name | ✓ | |
| Description | ✓ | |
| Folder name (identity, `data/<name>/`) | | ✓ rename |
| Delete | | ✓ and never the last profile |

Delete asks once, inline (no browser dialog), and **moves** the folder to
`data/.trash/<name>-<timestamp>` rather than removing it. A profile is gigabytes of litigation
data; the trash is the undo. Nothing empties it automatically.

**API** (`src/app/api/profiles/[name]/route.ts`):

```
GET    /api/profiles/<name>      manifest, active flag, cases, paths
PATCH  /api/profiles/<name>      { displayName?, description?, newName? }
DELETE /api/profiles/<name>      → { name, trashedTo }
```

`409` when the operation targets the active profile (rename/delete), a name that already exists,
or the last profile; `400` on an invalid name or empty display name; `404` unknown profile.

**Rules** live once, in `src/lib/profiles/manage.ts` (`updateProfile`, `deleteProfile`), so the
API and any future MCP tool agree. Rename and delete refuse the ACTIVE profile because every open
handle in the process (Prisma, Kysely, Redis prefix, LanceDB) is keyed by the name — switch away
first, then rename or delete.

## Why not over MCP

Creating, renaming and deleting data sets is an operator action at the keyboard. MCP gets
`profile_list` and `profile_use` (task 54) and nothing that removes data.

## Verified live

Create → edit display name and description → rename folder → refuse rename of the active
profile → delete → folder present under `data/.trash/` → listing updated. Tests:
`src/lib/profiles/__tests__/manage.test.ts`.

## One thing to know

The active profile can change under you from the dashboard (the dropdown switches the whole
server). A rename or delete that was refused a minute ago may succeed now, and vice versa. The
panel reloads the listing after every action, and every refusal names the reason.
