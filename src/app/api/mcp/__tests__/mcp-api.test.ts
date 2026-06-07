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
    )
  })

  it('passes undefined context when no provider/model override', async () => {
    mockRegistry.execute.mockResolvedValueOnce({ success: true, data: {} })
    const { POST } = await import('../execute/route')
    await POST(postReq({ tool: 'query_case_knowledge', params: { query: 'test' } }))

    expect(mockRegistry.execute).toHaveBeenCalledWith('query_case_knowledge', { query: 'test' }, undefined)
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

describe('GET /api/mcp/tools', () => {
  it('lists available tools from the registry', async () => {
    mockRegistry.listTools.mockReturnValueOnce([
      { name: 'query_case_knowledge', description: 'Semantic search' },
      { name: 'scan_for_pattern', description: 'Pattern search' },
    ])
    const { GET } = await import('../tools/route')
    const res = await GET()
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.tools).toHaveLength(2)
    expect(data.tools[0].name).toBe('query_case_knowledge')
    expect(data.tools[1].name).toBe('scan_for_pattern')
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
