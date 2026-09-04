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

function postReq(body: unknown) {
  return new NextRequest('http://localhost:3000/api/mcp/execute', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mockRegistry.refreshDependencies.mockReset().mockResolvedValue(undefined)
  mockRegistry.execute.mockReset()
  mockRegistry.listTools.mockReset()
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
    await POST(postReq({ tool: 'query_case_knowledge', params: { query: 'test' }, provider: 'openai', model: 'gpt-4' }))

    expect(mockRegistry.execute).toHaveBeenCalledWith(
      'query_case_knowledge',
      { query: 'test' },
      { aiProvider: 'openai', aiModel: 'gpt-4' },
      'local',
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
