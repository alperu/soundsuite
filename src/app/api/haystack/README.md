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

## Vendor ops (`ss*`)

Sound Suite's own ops — the ETL surface from `docs/PLAN-haystack-mcp-agentic-etl.md` — are
registered from the catalogue in `src/lib/haystack/ops/catalogue.ts`. `GET /ops` describes each
row with `params` (name → type, required, description), `doc` and `ssExposure`
(`read` | `write` | `llm`), so a client can build a tool definition from the grid alone; the MCP
bridge (`src/lib/mcp/tools/haystack-ops.ts`) does exactly that.

Parameters go in the query string (GET) or as plain JSON in the body (POST); the body wins. The
reply is a grid whose `meta` is the op's summary (counts are for the whole set) and whose `rows`
are the paged detail. Domain failures are `err` grids with `errTrace` set to the error code
(`INVALID_PARAMS`, `NOT_FOUND`, `WRITE_DISABLED`, `EXECUTION_ERROR`).

```bash
curl -H "Authorization: BEARER authToken=$KEY" 'http://localhost:3000/api/haystack/ssScopeGraph'
curl -H "Authorization: BEARER authToken=$KEY" 'http://localhost:3000/api/haystack/ssWorklist?caseId=@<id>&limit=20'
curl -H "Authorization: BEARER authToken=$KEY" -X POST -H 'content-type: application/json' \
     -d '{"caseId":"<id>","limit":25}' 'http://localhost:3000/api/haystack/ssPromoteDiscovered'   # dryRun defaults to true
```

Every `write` op takes `dryRun` (default `true`). A `dryRun: false` call over this bearer API or
over MCP is refused unless the server runs with `SS_HAYSTACK_WRITE=1`; the same-origin proxy
(`/api/haystack-proxy/[op]`, what the dashboard uses) is exempt. The standard `commit` op is not
bridged to MCP.
