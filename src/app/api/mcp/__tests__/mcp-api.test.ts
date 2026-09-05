/**
 * Unit tests for the MCP API routes (execute + tools).
 *
 * The routes execute tools IN-PROCESS via the ToolRegistry
 * (`@/lib/mcp/get-tool-registry`) — they are no longer thin proxies that
 * `fetch` an external MCP server. So we mock the registry and assert the
 * route's request handling: validation, provider/model context pass-through,
 * error-code → HTTP-status mapping, and tool listing.
 *
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

// Stable mock registry; the route calls getToolRegistry() → refreshDependencies()
// → execute()/listTools(). Methods are configured per test.
const mockRegistry = {
  refreshDependencies: jest.fn(async () => {}),
  execute: jest.fn(),
  listTools: jest.fn(),
}
jest.mock('@/lib/mcp/get-tool-registry', () => ({
  getToolRegistry: jest.fn(async () => mockRegistry),
}))

// The execute route reads the `mcp.apiKeys` config row when authenticating;
// keep the suite off the real database.
jest.mock('@/lib/db/prisma', () => ({
  prisma: { config: { findUnique: jest.fn(async () => null) } },
}))

function postReq(body: unknown) {
  return new NextRequest('http://localhost:3000/api/mcp/execute', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  mockRegistry.refreshDependencies.mockReset().mockResolvedValue(undefined)
  mockRegistry.execute.mockReset()
  mockRegistry.listTools.mockReset()
  // Every /api/mcp route now consults execute-auth (R-1), so the auth env has
  // to be neutral for suites that are not testing auth — otherwise the
  // AUTH_MISCONFIGURED case below leaks a 401 into the listing tests.
  delete process.env.MCP_API_KEYS
  delete process.env.MCP_API_KEY
  delete process.env.MCP_AUTH_STRICT_LOOPBACK
  delete process.env.MCP_TRUST_PROXY
  process.env.MCP_AUTH_MODE = 'none'
  const { resetMcpApiKeyCache } = await import('@/lib/mcp/execute-auth')
  resetMcpApiKeyCache()
})

describe('POST /api/mcp/execute', () => {
  it('executes a tool and returns its data', async () => {
    mockRegistry.execute.mockResolvedValueOnce({
      success: true,
      data: { results: [{ text: 'Sample result', document: 'test.pdf', page: 1, score: 0.9 }] },
    })
    const { POST } = await import('../execute/route')
    const res = await POST(postReq({ tool: 'query_case_knowledge', params: { query: 'test' } }))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.results).toHaveLength(1)
    expect(data.results[0].text).toBe('Sample result')
  })

  it('returns 400 for a missing tool name', async () => {
    const { POST } = await import('../execute/route')
    const res = await POST(postReq({ params: { query: 'test' } }))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error.code).toBe('INVALID_REQUEST')
    expect(data.error.message).toContain('tool name')
  })

  it('passes provider/model through as a context override', async () => {
    mockRegistry.execute.mockResolvedValueOnce({ success: true, data: {} })
    const { POST } = await import('../execute/route')
    // `routed`: a cloud provider under `local` is a policy violation (N-6).
    await POST(
      postReq({ tool: 'query_case_knowledge', params: { query: 'test' }, provider: 'openai', model: 'gpt-4', profile: 'routed' }),
    )

    expect(mockRegistry.execute).toHaveBeenCalledWith(
      'query_case_knowledge',
      { query: 'test' },
      { aiProvider: 'openai', aiModel: 'gpt-4' },
      'routed',
    )
  })

  it('passes undefined context when no provider/model override', async () => {
    mockRegistry.execute.mockResolvedValueOnce({ success: true, data: {} })
    const { POST } = await import('../execute/route')
    await POST(postReq({ tool: 'query_case_knowledge', params: { query: 'test' } }))

    expect(mockRegistry.execute).toHaveBeenCalledWith('query_case_knowledge', { query: 'test' }, undefined, 'local')
  })

  it('maps a tool error code to the right HTTP status', async () => {
    mockRegistry.execute.mockResolvedValueOnce({ success: false, errorCode: 'INVALID_REGEX', error: 'Invalid regex pattern' })
    const { POST } = await import('../execute/route')
    const res = await POST(postReq({ tool: 'scan_for_pattern', params: { pattern: '[invalid' } }))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error.code).toBe('INVALID_REGEX')
  })

  it('maps TOOL_NOT_FOUND to 404', async () => {
    mockRegistry.execute.mockResolvedValueOnce({ success: false, errorCode: 'TOOL_NOT_FOUND', error: 'nope' })
    const { POST } = await import('../execute/route')
    const res = await POST(postReq({ tool: 'bogus', params: {} }))
    expect(res.status).toBe(404)
  })

  it('returns 500 EXECUTION_FAILED when execute throws', async () => {
    mockRegistry.execute.mockRejectedValueOnce(new Error('Boom'))
    const { POST } = await import('../execute/route')
    const res = await POST(postReq({ tool: 'query_case_knowledge', params: { query: 'test' } }))
    const data = await res.json()

    expect(res.status).toBe(500)
    expect(data.error.code).toBe('EXECUTION_FAILED')
    expect(data.error.message).toContain('Boom')
  })
})

// --- N-6: the policy choke point must see the raw request fields ----------
describe('POST /api/mcp/execute — LLM policy on raw fields', () => {
  it.each([
    ['provider only', { provider: 'anthropic' }],
    ['provider + model', { provider: 'anthropic', model: 'claude-sonnet-5' }],
  ])('refuses a non-Ollama provider under local (%s) with 403 POLICY_VIOLATION', async (_label, extra) => {
    const { POST } = await import('../execute/route')
    const res = await POST(postReq({ tool: 'query_case_knowledge', params: { query: 'test' }, ...extra }))
    const data = await res.json()

    expect(res.status).toBe(403)
    expect(data.error.code).toBe('POLICY_VIOLATION')
    expect(data.error.message).toContain('routed')
    expect(mockRegistry.execute).not.toHaveBeenCalled()
  })

  it('allows provider: ollama under local', async () => {
    mockRegistry.execute.mockResolvedValueOnce({ success: true, data: {} })
    const { POST } = await import('../execute/route')
    const res = await POST(postReq({ tool: 'query_case_knowledge', params: { query: 'test' }, provider: 'ollama' }))
    expect(res.status).toBe(200)
  })

  it('allows a bare provider under routed', async () => {
    mockRegistry.execute.mockResolvedValueOnce({ success: true, data: {} })
    const { POST } = await import('../execute/route')
    const res = await POST(
      postReq({ tool: 'query_case_knowledge', params: { query: 'test' }, provider: 'anthropic', profile: 'routed' }),
    )
    expect(res.status).toBe(200)
  })
})

// --- N-9 / M-5: authentication ------------------------------------------
// Keys here are synthetic placeholders, never a real key.
describe('POST /api/mcp/execute — authentication', () => {
  const SYNTHETIC_KEY = 'synthetic-key-aaaa'

  function req(url: string, headers: Record<string, string>, body: unknown) {
    return new NextRequest(url, { method: 'POST', headers, body: JSON.stringify(body) })
  }

  const call = { tool: 'query_case_knowledge', params: { query: 'test' } }

  beforeEach(async () => {
    delete process.env.MCP_API_KEYS
    delete process.env.MCP_API_KEY
    delete process.env.MCP_AUTH_STRICT_LOOPBACK
    process.env.MCP_AUTH_MODE = 'none'
    const { resetMcpApiKeyCache } = await import('@/lib/mcp/execute-auth')
    resetMcpApiKeyCache()
  })

  it.each(['local', 'routed'])('allows an unauthenticated loopback call (%s) — dev must keep working', async (profile) => {
    mockRegistry.execute.mockResolvedValueOnce({ success: true, data: {} })
    const { POST } = await import('../execute/route')
    const res = await POST(req('http://localhost:3000/api/mcp/execute', {}, { ...call, profile }))
    expect(res.status).toBe(200)
  })

  it.each(['local', 'routed'])('refuses an unauthenticated remote call (%s) with 401', async (profile) => {
    const { POST } = await import('../execute/route')
    const res = await POST(
      req('http://localhost:3000/api/mcp/execute', { 'x-forwarded-for': '203.0.113.9' }, { ...call, profile }),
    )
    const data = await res.json()
    expect(res.status).toBe(401)
    expect(data.error.code).toBe('AUTH_REQUIRED')
    expect(data.error.message).toContain('MCP_API_KEYS')
    expect(mockRegistry.execute).not.toHaveBeenCalled()
  })

  it('accepts a remote call carrying a configured key as a bearer token', async () => {
    process.env.MCP_API_KEYS = SYNTHETIC_KEY
    mockRegistry.execute.mockResolvedValueOnce({ success: true, data: {} })
    const { POST } = await import('../execute/route')
    const res = await POST(
      req(
        'http://localhost:3000/api/mcp/execute',
        { 'x-forwarded-for': '203.0.113.9', authorization: `Bearer ${SYNTHETIC_KEY}` },
        call,
      ),
    )
    expect(res.status).toBe(200)
  })

  it('refuses a remote call with a wrong key', async () => {
    process.env.MCP_API_KEYS = SYNTHETIC_KEY
    const { POST } = await import('../execute/route')
    const res = await POST(
      req(
        'http://localhost:3000/api/mcp/execute',
        { 'x-forwarded-for': '203.0.113.9', 'x-api-key': 'synthetic-key-wrong' },
        call,
      ),
    )
    const data = await res.json()
    expect(res.status).toBe(401)
    expect(data.error.code).toBe('AUTH_FAILED')
  })

  it('allows a loopback call that carries a real Host header (the dashboard shape)', async () => {
    mockRegistry.execute.mockResolvedValueOnce({ success: true, data: {} })
    const { POST } = await import('../execute/route')
    const res = await POST(req('http://localhost:3000/api/mcp/execute', { host: 'localhost:3000' }, call))
    expect(res.status).toBe(200)
  })

  it('refuses a tunnelled request — cloudflared connects to loopback but sets a public Host', async () => {
    const { POST } = await import('../execute/route')
    const res = await POST(req('http://localhost:3000/api/mcp/execute', { host: 'mcp.example.test' }, call))
    expect(res.status).toBe(401)
    expect(mockRegistry.execute).not.toHaveBeenCalled()
  })

  it('refuses a LAN-IP request (server-info advertises this endpoint on the LAN)', async () => {
    const { POST } = await import('../execute/route')
    const res = await POST(req('http://192.168.1.20:3000/api/mcp/execute', { host: '192.168.1.20:3000' }, call))
    expect(res.status).toBe(401)
  })

  it('fails closed on an unparseable MCP_AUTH_MODE', async () => {
    process.env.MCP_AUTH_MODE = 'api_key'
    const { POST } = await import('../execute/route')
    const res = await POST(req('http://localhost:3000/api/mcp/execute', {}, call))
    const data = await res.json()
    expect(res.status).toBe(401)
    expect(data.error.code).toBe('AUTH_MISCONFIGURED')
    expect(data.error.message).toContain('api_key')
  })

  it('gates loopback too under MCP_AUTH_STRICT_LOOPBACK=1', async () => {
    process.env.MCP_API_KEYS = SYNTHETIC_KEY
    process.env.MCP_AUTH_STRICT_LOOPBACK = '1'
    const { POST } = await import('../execute/route')
    const denied = await POST(req('http://localhost:3000/api/mcp/execute', {}, call))
    expect(denied.status).toBe(401)

    mockRegistry.execute.mockResolvedValueOnce({ success: true, data: {} })
    const allowed = await POST(
      req('http://localhost:3000/api/mcp/execute', { 'x-api-key': SYNTHETIC_KEY }, call),
    )
    expect(allowed.status).toBe(200)
  })
})

function toolsReq(query = '') {
  return new NextRequest(`http://localhost:3000/api/mcp/tools${query}`)
}

describe('GET /api/mcp/tools', () => {
  it('defaults a missing profile to local and stamps the policy', async () => {
    mockRegistry.listTools.mockReturnValueOnce([
      { name: 'query_case_knowledge', description: 'Semantic search' },
      { name: 'scan_for_pattern', description: 'Pattern search' },
    ])
    const { GET } = await import('../tools/route')
    const res = await GET(toolsReq())
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(mockRegistry.listTools).toHaveBeenCalledWith('local')
    expect(data.profile).toBe('local')
    expect(typeof data.policy).toBe('string')
    expect(data.providersAllowed).toEqual(['ollama'])
    expect(data.tools).toHaveLength(2)
    expect(data.tools[0].name).toBe('query_case_knowledge')
    expect(data.tools[1].name).toBe('scan_for_pattern')
  })

  it('treats a bare call (no request object) as local too', async () => {
    mockRegistry.listTools.mockReturnValueOnce([])
    const { GET } = await import('../tools/route')
    const res = await GET()
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(mockRegistry.listTools).toHaveBeenCalledWith('local')
    expect(data.profile).toBe('local')
  })

  it('filters and stamps ?profile=routed', async () => {
    mockRegistry.listTools.mockReturnValueOnce([{ name: 'research_start' }])
    const { GET } = await import('../tools/route')
    const res = await GET(toolsReq('?profile=routed'))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(mockRegistry.listTools).toHaveBeenCalledWith('routed')
    expect(data.profile).toBe('routed')
    expect(data.providersAllowed).toContain('anthropic')
  })

  it('returns every tool, unstamped, for the dashboard-only ?profile=all', async () => {
    mockRegistry.listTools.mockReturnValueOnce([{ name: 'a' }, { name: 'b' }, { name: 'c' }])
    const { GET } = await import('../tools/route')
    const res = await GET(toolsReq('?profile=all'))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(mockRegistry.listTools).toHaveBeenCalledWith()
    expect(data.profile).toBe('all')
    expect(data.policy).toBeUndefined()
    expect(data.providersAllowed).toBeUndefined()
    expect(data.tools).toHaveLength(3)
  })

  it('returns 400 INVALID_PROFILE for an unknown profile', async () => {
    const { GET } = await import('../tools/route')
    const res = await GET(toolsReq('?profile=bogus'))
    const data = await res.json()
    expect(res.status).toBe(400)
    expect(data.error.code).toBe('INVALID_PROFILE')
    expect(data.error.message).toMatch(/bogus/)
    expect(mockRegistry.listTools).not.toHaveBeenCalled()
  })

  it('returns 500 FETCH_FAILED when the registry is unavailable', async () => {
    mockRegistry.refreshDependencies.mockRejectedValueOnce(new Error('registry down'))
    const { GET } = await import('../tools/route')
    const res = await GET()
    const data = await res.json()

    expect(res.status).toBe(500)
    expect(data.error.code).toBe('FETCH_FAILED')
  })
})

// --- R-1: the catalogue and its siblings take the execute gate -----------
describe('GET /api/mcp/* — surface gating (R-1)', () => {
  const SYNTHETIC_KEY = 'synthetic-key-bbbb'

  function get(path: string, headers: Record<string, string> = {}) {
    return new NextRequest(`http://localhost:3000${path}`, { headers })
  }

  it('serves the dashboard shape: ?profile=all, same-origin loopback, no headers', async () => {
    mockRegistry.listTools.mockReturnValueOnce([{ name: 'a' }])
    const { GET } = await import('../tools/route')
    const res = await GET(get('/api/mcp/tools?profile=all', { host: 'localhost:3000' }))
    expect(res.status).toBe(200)
  })

  it('serves the bridge shape: ?profile=local on loopback with a bearer token', async () => {
    mockRegistry.listTools.mockReturnValueOnce([{ name: 'a' }])
    const { GET } = await import('../tools/route')
    const res = await GET(
      get('/api/mcp/tools?profile=local', { authorization: `Bearer ${SYNTHETIC_KEY}` }),
    )
    expect(res.status).toBe(200)
  })

  it('refuses the catalogue from a forged remote origin — the R-1 finding', async () => {
    const { GET } = await import('../tools/route')
    const res = await GET(get('/api/mcp/tools?profile=local', { 'x-forwarded-for': '203.0.113.9' }))
    const data = await res.json()
    expect(res.status).toBe(401)
    expect(data.error.code).toBe('AUTH_REQUIRED')
    expect(mockRegistry.listTools).not.toHaveBeenCalled()
  })

  it('refuses before parsing the profile, so 400 vs 401 cannot enumerate profiles', async () => {
    const { GET } = await import('../tools/route')
    const res = await GET(get('/api/mcp/tools?profile=bogus', { host: 'mcp.example.test' }))
    const data = await res.json()
    expect(res.status).toBe(401)
    expect(data.error.code).toBe('AUTH_REQUIRED')
  })

  it('lets a remote caller through with a configured key', async () => {
    process.env.MCP_API_KEYS = SYNTHETIC_KEY
    const { resetMcpApiKeyCache } = await import('@/lib/mcp/execute-auth')
    resetMcpApiKeyCache()
    mockRegistry.listTools.mockReturnValueOnce([{ name: 'a' }])
    const { GET } = await import('../tools/route')
    const res = await GET(
      get('/api/mcp/tools?profile=local', {
        'x-forwarded-for': '203.0.113.9',
        'x-api-key': SYNTHETIC_KEY,
      }),
    )
    expect(res.status).toBe(200)
  })

  it('gates /api/mcp/claude-tools the same way', async () => {
    const { GET } = await import('../claude-tools/route')
    const res = await GET(get('/api/mcp/claude-tools', { 'x-forwarded-for': '203.0.113.9' }))
    expect(res.status).toBe(401)

    mockRegistry.listTools.mockReturnValueOnce([])
    const ok = await GET(get('/api/mcp/claude-tools', { host: 'localhost:3000' }))
    expect(ok.status).toBe(200)
  })

  it('gates /api/mcp/stats and /api/mcp/execution-history', async () => {
    const stats = await import('../stats/route')
    const history = await import('../execution-history/route')
    expect((await stats.GET(get('/api/mcp/stats', { 'x-forwarded-for': '203.0.113.9' }))).status).toBe(401)
    expect(
      (await history.GET(get('/api/mcp/execution-history', { 'x-forwarded-for': '203.0.113.9' }))).status,
    ).toBe(401)
  })

  it('gates /api/mcp/tool-config, read and write alike', async () => {
    const cfg = await import('../tool-config/route')
    expect((await cfg.GET(get('/api/mcp/tool-config', { host: 'mcp.example.test' }))).status).toBe(401)
    const write = new NextRequest('http://localhost:3000/api/mcp/tool-config', {
      method: 'POST',
      headers: { host: 'mcp.example.test' },
      body: JSON.stringify({ query_case_knowledge: { enabled: true } }),
    })
    expect((await cfg.POST(write)).status).toBe(401)
  })

  it('gates /api/mcp/tool-health', async () => {
    const health = await import('../tool-health/route')
    expect((await health.GET(get('/api/mcp/tool-health', { 'x-forwarded-for': '203.0.113.9' }))).status).toBe(401)
  })

  // Job routes: a routed report spends API credit, so the gate runs before
  // anything is started. POST reads the body first (only to learn `profile`),
  // so these also cover that reordering.
  it('gates the job routes, and refuses before a job can be started', async () => {
    const jobs = await import('../[kind]/route')
    const ctx = { params: Promise.resolve({ kind: 'report' }) }
    const start = new NextRequest('http://localhost:3000/api/mcp/report', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ query: 'synthetic probe', profile: 'routed' }),
    })
    const res = await jobs.POST(start, ctx)
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('AUTH_REQUIRED')

    const list = await jobs.GET(get('/api/mcp/research', { 'x-forwarded-for': '203.0.113.9' }), {
      params: Promise.resolve({ kind: 'research' }),
    })
    expect(list.status).toBe(401)
  })
})

// --- M-5: an untrusted X-Forwarded-For no longer establishes loopback ----
describe('X-Forwarded-For trust (M-5 / v5 §R-2)', () => {
  const call = { tool: 'query_case_knowledge', params: { query: 'synthetic probe' } }

  function post(headers: Record<string, string>) {
    return new NextRequest('http://localhost:3000/api/mcp/execute', {
      method: 'POST',
      headers,
      body: JSON.stringify(call),
    })
  }

  it('allows the single loopback XFF entry Next.js injects from the socket peer', async () => {
    mockRegistry.execute.mockResolvedValueOnce({ success: true, data: {} })
    const { POST } = await import('../execute/route')
    expect((await POST(post({ 'x-forwarded-for': '127.0.0.1' }))).status).toBe(200)
  })

  it('refuses a loopback-first multi-hop chain — new beyond the v5 table', async () => {
    const { POST } = await import('../execute/route')
    const res = await POST(post({ 'x-forwarded-for': '127.0.0.1, 203.0.113.9' }))
    expect(res.status).toBe(401)
    expect(mockRegistry.execute).not.toHaveBeenCalled()
  })

  it('refuses a loopback X-Real-IP and a Forwarded header', async () => {
    const { POST } = await import('../execute/route')
    expect((await POST(post({ 'x-real-ip': '127.0.0.1' }))).status).toBe(401)
    expect((await POST(post({ forwarded: 'for=127.0.0.1' }))).status).toBe(401)
  })

  it('keeps refusing a public XFF and the v5 proxy chain', async () => {
    const { POST } = await import('../execute/route')
    expect((await POST(post({ 'x-forwarded-for': '203.0.113.9' }))).status).toBe(401)
    expect((await POST(post({ 'x-forwarded-for': '203.0.113.9, 127.0.0.1' }))).status).toBe(401)
  })

  it('still allows a header-free loopback request — the dashboard and bridge shape', async () => {
    mockRegistry.execute.mockResolvedValueOnce({ success: true, data: {} })
    const { POST } = await import('../execute/route')
    expect((await POST(post({ host: 'localhost:3000' }))).status).toBe(200)
  })

  it('accepts a declared proxy chain under MCP_TRUST_PROXY=1', async () => {
    process.env.MCP_TRUST_PROXY = '1'
    mockRegistry.execute.mockResolvedValueOnce({ success: true, data: {} })
    const { POST } = await import('../execute/route')
    expect((await POST(post({ 'x-forwarded-for': '127.0.0.1, 10.0.0.5' }))).status).toBe(200)
    // …and a public client behind that trusted proxy is still refused.
    expect((await POST(post({ 'x-forwarded-for': '203.0.113.9, 10.0.0.5' }))).status).toBe(401)
  })

  it('applies the same rules to the catalogue', async () => {
    const { GET } = await import('../tools/route')
    const chained = new NextRequest('http://localhost:3000/api/mcp/tools?profile=local', {
      headers: { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' },
    })
    expect((await GET(chained)).status).toBe(401)

    mockRegistry.listTools.mockReturnValueOnce([])
    const direct = new NextRequest('http://localhost:3000/api/mcp/tools?profile=local', {
      headers: { 'x-forwarded-for': '127.0.0.1' },
    })
    expect((await GET(direct)).status).toBe(200)
  })
})
