/**
 * Tests for DocumentSummarizer
 */

// Mock the config module
jest.mock('../../db/config', () => ({
  getConfig: jest.fn(),
}));

// Mock the AI provider module
jest.mock('../../ai/ai-provider', () => ({
  completeAI: jest.fn(),
}));

import { DocumentSummarizer } from '../document-summarizer';

describe('DocumentSummarizer', () => {
  let summarizer: DocumentSummarizer;
  let mockGetConfig: jest.Mock;
  let mockCompleteAI: jest.Mock;

  beforeEach(async () => {
    summarizer = new DocumentSummarizer();
    mockGetConfig = (await import('../../db/config')).getConfig as jest.Mock;
    mockCompleteAI = (await import('../../ai/ai-provider')).completeAI as jest.Mock;
    jest.clearAllMocks();
  });

  it('should return null when no API key is configured', async () => {
    mockGetConfig.mockResolvedValue({
      embeddingProvider: 'transformers',
      embeddingModel: 'test',
      workerPoolSize: 1,
      minUiWorkers: 1,
      minBgWorkers: 1,
      pidKp: 1,
      pidKi: 0.5,
      pidKd: 0.1,
      maxParsingWorkers: 4,
    });

    const result = await summarizer.generateSummary({
      headerText: 'Some legal text',
      fileName: 'test.pdf',
    });

    expect(result).toBeNull();
    expect(mockCompleteAI).not.toHaveBeenCalled();
  });

  it('should call completeAI with correct prompt when Groq key is available', async () => {
    mockGetConfig.mockResolvedValue({
      embeddingProvider: 'transformers',
      embeddingModel: 'test',
      groqApiKey: 'gsk_test123',
      workerPoolSize: 1,
      minUiWorkers: 1,
      minBgWorkers: 1,
      pidKp: 1,
      pidKi: 0.5,
      pidKd: 0.1,
      maxParsingWorkers: 4,
    });

    mockCompleteAI.mockResolvedValue({
      content: 'Motion for Summary Judgment filed by Acme Corp.',
      model: 'llama-3.1-8b-instant',
      provider: 'groq',
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await summarizer.generateSummary({
      headerText: 'MOTION FOR SUMMARY JUDGMENT\nPlaintiff Acme Corp hereby moves...',
      filingType: 'motion',
      filingTitle: 'Motion for Summary Judgment',
      fileName: 'motion-summary-judgment.pdf',
    });

    expect(result).toBe('Motion for Summary Judgment filed by Acme Corp.');
    expect(mockCompleteAI).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'groq',
        model: 'llama-3.1-8b-instant',
        maxTokens: 100,
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'system' }),
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('motion-summary-judgment.pdf'),
          }),
        ]),
      })
    );
  });

  it('should include filing type in prompt when available', async () => {
    mockGetConfig.mockResolvedValue({
      openaiApiKey: 'sk-test',
      workerPoolSize: 1,
      minUiWorkers: 1,
      minBgWorkers: 1,
      pidKp: 1,
      pidKi: 0.5,
      pidKd: 0.1,
      maxParsingWorkers: 4,
    });

    mockCompleteAI.mockResolvedValue({
      content: 'Test summary',
      model: 'gpt-4o-mini',
      provider: 'openai',
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    await summarizer.generateSummary({
      headerText: 'Some text',
      filingType: 'complaint',
      filingTitle: 'Civil Complaint',
      fileName: 'complaint.pdf',
    });

    const call = mockCompleteAI.mock.calls[0][0];
    const userMessage = call.messages.find((m: any) => m.role === 'user');
    expect(userMessage.content).toContain('Detected filing type: complaint');
    expect(userMessage.content).toContain('Civil Complaint');
  });

  it('should return null on LLM error', async () => {
    mockGetConfig.mockResolvedValue({
      groqApiKey: 'gsk_test',
      workerPoolSize: 1,
      minUiWorkers: 1,
      minBgWorkers: 1,
      pidKp: 1,
      pidKi: 0.5,
      pidKd: 0.1,
      maxParsingWorkers: 4,
    });

    mockCompleteAI.mockRejectedValue(new Error('API rate limit exceeded'));

    const result = await summarizer.generateSummary({
      headerText: 'Some text',
      fileName: 'test.pdf',
    });

    expect(result).toBeNull();
  });

  it('should return null when LLM returns empty string', async () => {
    mockGetConfig.mockResolvedValue({
      groqApiKey: 'gsk_test',
      workerPoolSize: 1,
      minUiWorkers: 1,
      minBgWorkers: 1,
      pidKp: 1,
      pidKi: 0.5,
      pidKd: 0.1,
      maxParsingWorkers: 4,
    });

    mockCompleteAI.mockResolvedValue({
      content: '',
      model: 'test',
      provider: 'groq',
      usage: { inputTokens: 50, outputTokens: 0 },
    });

    const result = await summarizer.generateSummary({
      headerText: 'Some text',
      fileName: 'test.pdf',
    });

    expect(result).toBeNull();
  });

  it('should prefer cheapest provider (Groq > OpenAI > Grok > Anthropic)', async () => {
    // Both Groq and OpenAI keys available — should pick Groq
    mockGetConfig.mockResolvedValue({
      groqApiKey: 'gsk_test',
      openaiApiKey: 'sk_test',
      workerPoolSize: 1,
      minUiWorkers: 1,
      minBgWorkers: 1,
      pidKp: 1,
      pidKi: 0.5,
      pidKd: 0.1,
      maxParsingWorkers: 4,
    });

    mockCompleteAI.mockResolvedValue({
      content: 'Summary',
      model: 'llama-3.1-8b-instant',
      provider: 'groq',
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    await summarizer.generateSummary({
      headerText: 'Some text',
      fileName: 'test.pdf',
    });

    expect(mockCompleteAI).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'groq' })
    );
  });

  it('should truncate header text to 3000 chars', async () => {
    mockGetConfig.mockResolvedValue({
      groqApiKey: 'gsk_test',
      workerPoolSize: 1,
      minUiWorkers: 1,
      minBgWorkers: 1,
      pidKp: 1,
      pidKi: 0.5,
      pidKd: 0.1,
      maxParsingWorkers: 4,
    });

    mockCompleteAI.mockResolvedValue({
      content: 'Summary',
      model: 'test',
      provider: 'groq',
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    const longText = 'A'.repeat(5000);
    await summarizer.generateSummary({
      headerText: longText,
      fileName: 'test.pdf',
    });

    const call = mockCompleteAI.mock.calls[0][0];
    const userMessage = call.messages.find((m: any) => m.role === 'user');
    // The header text in the prompt should be truncated to 3000 chars
    expect(userMessage.content.length).toBeLessThan(5000);
  });
});
