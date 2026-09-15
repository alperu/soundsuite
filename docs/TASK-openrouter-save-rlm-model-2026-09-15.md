# `/admin/openrouter` — saving submits an empty `rlmSandboxModel`

Task, 2026-09-15. Reported as "I can't save the page changing it."

## What I observed, live

Driving the page in a browser and intercepting `fetch`:

- **The save itself succeeds.** `POST /api/openrouter/settings` returns
  `200 {"success":true,"pushedToSidecars":5}`, both with no changes and after
  changing a routing-mode dropdown.
- **Routing-mode changes persist.** Setting Text embedding to `local-only`,
  saving, and reloading showed `local-only`. (Restored to `cloud-only`
  afterwards.)
- **But the request body carried `"rlmSandboxModel":""`** while the RLM select
  on screen showed `~deepseek/deepseek-pro-latest`.

So the form posts an empty string for a field the UI is displaying a value for.

## Why that matters

`src/app/api/openrouter/settings/route.ts:124`:

```ts
rlmSandboxModel: typeof body.rlmSandboxModel === 'string' ? body.rlmSandboxModel : undefined,
```

An empty string **is** a string, so `""` passes the guard and is written
through `config.rlmSandboxModel` → `rlm.sandboxModel`. Only `undefined` is
treated as "leave alone". So any save from this page can clear a configured RLM
sandbox model as a side effect of changing something unrelated — which is
exactly the shape of "I can't save the page changing it".

## Where to look

`src/components/admin-openrouter.tsx:184`:

```ts
const [rlmSandboxModel, setRlmSandboxModel] = useState(initialConfig.rlmSandboxModel || '');
```

If `initialConfig` does not carry the field at first render — absent from the
server payload, or a race with the catalogue fetch that populates the options —
the state initialises to `''` and stays there until the user touches that
control. Line 218 then posts that `''`.

Note the select's own option list (lines ~373-384) *does* preserve an
out-of-catalogue stored value by unshifting it, which is why the control
displays the right model. That safeguard covers the rendering and not the
submitted state, so the display and the payload disagree.

Also unexplained: the leading `~` in `~deepseek/deepseek-pro-latest`. It does
not appear anywhere in this component or in `src/lib/openrouter/*`, so it came
from the stored value. Worth establishing whether it is a deliberate sentinel
or corruption — if a model id with a `~` is ever sent upstream it will not
resolve.

## What to fix

1. **Never submit a field the user did not set.** Omit `rlmSandboxModel` when
   it is empty and was not edited, so the API's `undefined` path leaves the
   stored value alone. Treat `''` as "no change", or add an explicit "none"
   choice if clearing should be possible — but make clearing deliberate rather
   than a side effect.
2. **Initialise from the server, not from a possibly-absent field.** If
   `initialConfig.rlmSandboxModel` can be missing at first render, fetch it
   before the form becomes submittable, or track "touched" per field.
3. **Say when a save changed something the user did not touch.** The response
   already reports `pushedToSidecars`; it should also name fields whose stored
   value changed, so a silent clobber is visible.
4. **Establish what the `~` is**, and validate model ids against the catalogue
   before they reach the sidecars.

## Verification

- Change only a routing mode, save, reload: the RLM model is unchanged.
- Change the RLM model, save, reload: the new value is there.
- With no RLM model stored, saving does not invent one.
- A malformed id is rejected at save rather than pushed to the fleet.
