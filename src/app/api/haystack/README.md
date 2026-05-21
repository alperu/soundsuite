# Haystack HTTP API

Peer to the existing MCP server. Implements the read-side core of Haystack 4
(`about`, `ops`, `libs`, `defs`, `filetypes`, `nav`, `read`, `close`).

- Wire format: Hayson JSON (`application/vnd.haystack+json;version=4`). Zinc is rejected with `415`.
- Auth: bearer token via `Authorization: BEARER authToken=<token>`. Token comes from `HAYSTACK_API_KEY` (or falls back to `MCP_API_KEY`).
- Error convention: Haystack returns HTTP 200 with a grid whose `meta.err` marker signals the failure. Clients must check the marker, not the HTTP status.

## Examples

```bash
export KEY="$HAYSTACK_API_KEY"

# Server identity
curl -H "Authorization: BEARER authToken=$KEY" \
     -H "Accept: application/vnd.haystack+json;version=4" \
     'http://localhost:3000/api/haystack/about'

# List of supported ops
curl -H "Authorization: BEARER authToken=$KEY" \
     'http://localhost:3000/api/haystack/ops'

# Loaded XETO libs (via Agent 2's namespace singleton)
curl -H "Authorization: BEARER authToken=$KEY" \
     'http://localhost:3000/api/haystack/libs'

# Read with a filter (URL-encoded)
curl -H "Authorization: BEARER authToken=$KEY" \
     'http://localhost:3000/api/haystack/read?filter=motion%20and%20signed'

# Read by ref
curl -H "Authorization: BEARER authToken=$KEY" \
     "http://localhost:3000/api/haystack/read?filter=motion%20and%20caseRef%3D%3D%40case-1234"

# Hierarchical nav
curl -H "Authorization: BEARER authToken=$KEY" \
     'http://localhost:3000/api/haystack/nav'
curl -H "Authorization: BEARER authToken=$KEY" \
     "http://localhost:3000/api/haystack/nav?navId=%40case-1234"
```

## What's deferred (v2)

- `commit` — XETO-validated writes via the `cc.courtlens.legal` namespace
- `watchSub` / `watchPoll` / `watchUnsub` — for now use `/api/progress` SSE
- SCRAM authentication — bearer is enough until an off-the-shelf Haystack client connects
- Zinc wire format

## Implementation notes

- `src/lib/legal/kysely.ts` — sibling `better-sqlite3` handle to the same DB Prisma uses
- `src/lib/legal/haystack-filter-sql.ts` — `HFilter.parse()` → Kysely `Expression<boolean>` visitor that emits `json_extract(tags, '$.x')` paths matching Agent 1's VIRTUAL columns
- `src/lib/legal/repo.ts` — `findCase` / `findMotion` / … + `navHierarchy` + `writeTagged`
- `src/lib/legal/hayson.ts` — encoder (`encodeGrid`, `errGrid`, `okGrid`, `singletonGrid`)
