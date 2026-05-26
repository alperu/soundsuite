/**
 * @jest-environment node
 */

// Mock dependencies BEFORE importing the route.
jest.mock('@/lib/ai/ai-provider', () => ({
  completeAI: jest.fn(),
}));

jest.mock('@/lib/db/config', () => ({
  getConfig: jest.fn(),
}));

import { POST } from '../route';
import { completeAI } from '@/lib/ai/ai-provider';
import { getConfig } from '@/lib/db/config';

const mockCompleteAI = completeAI as jest.MockedFunction<typeof completeAI>;
const mockGetConfig = getConfig as jest.MockedFunction<typeof getConfig>;

function makeReq(body: unknown): import('next/server').NextRequest {
  return {
    json: async () => body,
  } as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
  mockCompleteAI.mockReset();
  mockGetConfig.mockReset();
  mockGetConfig.mockResolvedValue({
    ollamaCompletionModel: 'qwen2.5:7b',
  } as any);
});

describe('POST /api/search/axon-generate', () => {
  it('returns ok with axon on happy path', async () => {
    mockCompleteAI.mockResolvedValueOnce({
      content: 'motion and motionType=="disqualification"',
      model: 'qwen2.5:7b',
      provider: 'ollama',
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const res = await POST(makeReq({ english: 'motions to disqualify' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.axon).toBe('motion and motionType=="disqualification"');
    expect(mockCompleteAI).toHaveBeenCalledTimes(1);
  });

  it('strips markdown fences from model output', async () => {
    mockCompleteAI.mockResolvedValueOnce({
      content: '```axon\nmotion and motionType=="disqualification"\n```',
      model: 'qwen2.5:7b',
      provider: 'ollama',
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const res = await POST(makeReq({ english: 'motions to disqualify' }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.axon).toBe('motion and motionType=="disqualification"');
  });

  it('retries once when first output fails to parse, fails second time', async () => {
    // Both attempts return unparseable garbage.
    mockCompleteAI
      .mockResolvedValueOnce({
        content: 'this is not == valid (',
        model: 'qwen2.5:7b',
        provider: 'ollama',
        usage: { inputTokens: 0, outputTokens: 0 },
      })
      .mockResolvedValueOnce({
        content: 'still garbage (((',
        model: 'qwen2.5:7b',
        provider: 'ollama',
        usage: { inputTokens: 0, outputTokens: 0 },
      });

    const res = await POST(makeReq({ english: 'something weird' }));
    const body = await res.json();

    expect(mockCompleteAI).toHaveBeenCalledTimes(2);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Could not generate/i);
  });

  it('returns 400 for empty english', async () => {
    const res = await POST(makeReq({ english: '   ' }));
    expect(res.status).toBe(400);
    expect(mockCompleteAI).not.toHaveBeenCalled();
  });

  it('returns 400 for missing english', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it('returns 503 when no model is configured', async () => {
    mockGetConfig.mockResolvedValueOnce({ ollamaCompletionModel: '' } as any);
    const res = await POST(makeReq({ english: 'anything' }));
    expect(res.status).toBe(503);
    expect(mockCompleteAI).not.toHaveBeenCalled();
  });
});
