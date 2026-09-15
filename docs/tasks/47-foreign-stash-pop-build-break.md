# Conflict markers from a foreign `git stash pop` broke the build

**Status:** Fixed (restore done; guard below is a proposal, not implemented) · **Effort:** XS · **Priority:** **P1** — dev server would not compile
**Created:** 2026-09-15
**Broke:** `src/components/case/tag-panel.tsx`, `src/app/api/haystack/[op]/route.ts`
**Repo state at the time:** HEAD `8f6f6a36`

No case data. Mechanism only.

## Symptom

Turbopack refused to parse the page:

```
./src/components/case/tag-panel.tsx:920:1
Merge conflict marker encountered.
> 920 | =======
```

Import trace reached it via `editor-tab.tsx` → `haystack-block-view.tsx` →
`/scope`, so the whole route was down, not one component.

## Cause

A bare `git stash pop` was run in a repo whose stash stack holds **entries
created by other sessions**:

```
stash@{0}: agent-a34758-leak
stash@{1}: agent-leaks-pre-merge-1779377833
stash@{2}: claude [2026-02-18 10:35]: .claude/hooks/…
```

`git stash pop` with no argument pops `stash@{0}` — whoever wrote it. The
intent was to restore work that had *already been committed*, so there was
nothing of our own to pop; the command reached straight past that and applied a
foreign entry.

Two properties of git made this quiet:

1. **A conflicted pop still writes.** Git applies every hunk it can, writes
   `<<<<<<< / ======= / >>>>>>>` into the files it cannot, and leaves them in
   the index as `UU`. Nine markers landed in `tag-panel.tsx`, twelve in the
   haystack route.
2. **"The stash entry is kept in case you need it again" does not mean nothing
   was applied.** It means the *entry* was not dropped. Reading it as "the pop
   was a no-op" is the whole defect — the working tree had already been
   modified.

`git status --short` showed `UU` on both files the entire time. The check that
would have caught it was one command away and was not run; the tree was
reported clean on the strength of the "entry is kept" message alone.

## Fix applied

Both files were restored to `HEAD`, which was safe to do without inspection
because the merge stages proved it:

```
                                   ours(:2)                                  HEAD
tag-panel.tsx        5f565f37212b661c8ac4c213a218c930336f41fa   ==  5f565f37…  MATCH
api/haystack/[op]    c48bf9a65b7c4c002c682f5ee438dc35d6bfec95   ==  c48bf9a6…  MATCH
```

Stage `:2` ("ours") of a stash-pop conflict is the pre-pop working tree. Being
byte-identical to `HEAD` proves there were no uncommitted local edits in either
file, so `git checkout HEAD -- <paths>` discarded only the foreign stash's
hunks.

```bash
git checkout HEAD -- 'src/components/case/tag-panel.tsx' 'src/app/api/haystack/[op]/route.ts'
```

Verified after: `git status` clean of `UU`, `git grep` finds no conflict markers
in any tracked file, `npx tsc --noEmit` back at the **59-error baseline** with
zero errors in either restored file, and **all three stash entries still
present** — nothing belonging to another session was consumed or dropped.

## Rules this earns

- **Never `git stash pop` without naming the entry** in a repo that other
  sessions write to. `git stash pop stash@{n}` at minimum; prefer `git stash
  apply` so a mistake leaves the stack intact.
- **Before popping, know whether you have anything to pop.** If the work is
  already committed, the stash stack is not yours to touch.
- **Verify with `git diff --name-only --diff-filter=U`, not by reading git's
  prose.** A conflicted pop is reported in a sentence that is easy to read as
  success.

## Proposal (not implemented — needs a decision)

The Stop hook `.claude/hooks/commit-on-complete.sh` already gates on a signal
file. It is the natural place to refuse to commit while unmerged paths exist:

```sh
if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
  echo "refusing: unmerged paths present" >&2; exit 1
fi
```

That converts this class of failure from "discovered by a broken dev server"
into "refused at the commit". Scoped as a proposal because the ask here was the
build fix, not a hook change.
