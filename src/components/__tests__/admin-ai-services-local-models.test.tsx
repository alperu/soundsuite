/**
 * @jest-environment jsdom
 *
 * The "MCP local research models" section of Admin → AI Services: it must offer
 * only the models on the completion host that can actually do constrained JSON
 * generation, default to Auto, show what the server currently resolves to, and
 * persist the picked tag under `ollamaDecomposeModel` / `ollamaOutlineModel`
 * without disturbing the primary provider.
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminAIServices from '../admin-ai-services';

const CONFIG = {
  embeddingProvider: 'ollama',
  embeddingModel: 'nomic-embed-text',
  aiPrimaryProvider: 'ollama',
  aiPrimaryModel: 'local-9b',
  ollamaCompletionHost: 'http://localhost:11434',
  ollamaCompletionModel: 'local-9b',
};

/**
 * A realistic mixed host: one big instruct model, one small instruct model, an
 * embedding model, and two OCR/vision builds. The `families` values mirror what
 * Ollama reports — multimodal builds carry a projector family alongside the
 * text one, and neither vision tag's *name* gives it away.
 */
const MODELS = [
  { id: 'local-9b', label: 'local-9b', family: 'qwen35', families: ['qwen35'] },
  { id: 'tiny-instruct:1b', label: 'tiny-instruct:1b', family: 'qwen3', families: ['qwen3'] },
  { id: 'local-embed:0.6b', label: 'local-embed:0.6b', family: 'qwen3', families: ['qwen3'] },
  { id: 'vendor/cpm-multi:latest', label: 'vendor/cpm-multi:latest', family: 'qwen2', families: ['qwen2', 'clip'] },
  { id: 'vendor/paddle-doc:0.9b', label: 'vendor/paddle-doc:0.9b', family: 'paddleocr', families: ['paddleocr'] },
];

const ELIGIBLE = ['', 'local-9b', 'tiny-instruct:1b'];

let posted: Array<Record<string, unknown>>;

const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  posted = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url.startsWith('/api/config')) {
      posted.push(JSON.parse(String(init.body)));
      return jsonOk({ ok: true });
    }
    if (url.startsWith('/api/config?resolve=localModels')) {
      return jsonOk({ decompose: 'tiny-instruct:1b', outline: 'local-9b' });
    }
    if (url.startsWith('/api/config')) return jsonOk(CONFIG);
    if (url.startsWith('/api/ollama/models')) return jsonOk({ models: MODELS });
    return jsonOk({});
  }) as unknown as typeof fetch;
});

const outlineSelect = () => screen.getByLabelText('Outline') as HTMLSelectElement;
const decomposeSelect = () => screen.getByLabelText('Decompose') as HTMLSelectElement;
const pick = (select: HTMLSelectElement, value: string) => fireEvent.change(select, { target: { value } });
const optionsOf = (select: HTMLSelectElement) => Array.from(select.querySelectorAll('option')).map(o => o.value);

/** Re-render with a patched plain `GET /api/config` body. */
const renderWithConfig = (extra: Record<string, unknown>) => {
  const base = global.fetch as jest.Mock;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/config') && !init?.method && !url.includes('resolve=')) {
      return jsonOk({ ...CONFIG, ...extra });
    }
    return base(input, init);
  }) as unknown as typeof fetch;
  return render(<AdminAIServices />);
};

describe('Admin → AI Services: MCP local research models', () => {
  it('renders both pickers with Auto selected and the host model list', async () => {
    render(<AdminAIServices />);
    await screen.findByText('MCP local research models');

    for (const select of [decomposeSelect(), outlineSelect()]) {
      expect(select).toHaveValue('');
      expect(optionsOf(select)).toEqual(ELIGIBLE);
      expect(select.querySelector('option')).toHaveTextContent('Auto (resolve from host)');
    }
  });

  it('offers no OCR/vision or embedding model in either picker', async () => {
    render(<AdminAIServices />);
    await screen.findByText('MCP local research models');

    for (const select of [decomposeSelect(), outlineSelect()]) {
      const values = optionsOf(select);
      expect(values).not.toContain('vendor/cpm-multi:latest');
      expect(values).not.toContain('vendor/paddle-doc:0.9b');
      expect(values).not.toContain('local-embed:0.6b');
    }
    // ...and says so, rather than leaving the operator wondering.
    expect(await screen.findByText(/3 OCR\/vision models on this host/)).toBeInTheDocument();
  });

  it('still offers a model it cannot classify (fails open)', async () => {
    const base = global.fetch as jest.Mock;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/ollama/models')) {
        return jsonOk({ models: [...MODELS, { id: 'vendor/private:3b', label: 'vendor/private:3b' }] });
      }
      return base(input, init);
    }) as unknown as typeof fetch;

    render(<AdminAIServices />);
    await screen.findByText('MCP local research models');
    await waitFor(() => expect(optionsOf(outlineSelect())).toContain('vendor/private:3b'));
  });

  it('shows what the server resolves to today', async () => {
    render(<AdminAIServices />);
    await screen.findByText('MCP local research models');
    await waitFor(() => expect(screen.getAllByText(/Currently resolves to/).length).toBe(2));
  });

  it('persists an outline pick without touching the primary provider/model', async () => {
    render(<AdminAIServices />);
    await screen.findByText('MCP local research models');

    pick(outlineSelect(), 'tiny-instruct:1b');
    await waitFor(() => expect(posted).toHaveLength(1));

    expect(posted[0].ollamaOutlineModel).toBe('tiny-instruct:1b');
    expect(posted[0].ollamaDecomposeModel).toBeUndefined();
    expect(posted[0].aiPrimaryProvider).toBe('ollama');
    expect(posted[0].aiPrimaryModel).toBe('local-9b');
  });

  it('persists a decompose pick under its own key', async () => {
    render(<AdminAIServices />);
    await screen.findByText('MCP local research models');

    pick(decomposeSelect(), 'tiny-instruct:1b');
    await waitFor(() => expect(posted).toHaveLength(1));

    expect(posted[0].ollamaDecomposeModel).toBe('tiny-instruct:1b');
    expect(posted[0].ollamaOutlineModel).toBeUndefined();
  });

  it('going back to Auto persists an empty string', async () => {
    render(<AdminAIServices />);
    await screen.findByText('MCP local research models');

    pick(outlineSelect(), 'tiny-instruct:1b');
    await waitFor(() => expect(posted).toHaveLength(1));
    pick(outlineSelect(), '');
    await waitFor(() => expect(posted).toHaveLength(2));

    expect(posted[1].ollamaOutlineModel).toBe('');
  });

  it('a pin the host no longer reports stays visible', async () => {
    renderWithConfig({ ollamaOutlineModel: 'uninstalled:1b' });
    await screen.findByText('MCP local research models');

    await waitFor(() => expect(outlineSelect()).toHaveValue('uninstalled:1b'));
    expect(screen.getByText('uninstalled:1b (not installed)')).toBeInTheDocument();
  });

  it('a pin that is now filtered out stays visible and says why', async () => {
    renderWithConfig({ ollamaDecomposeModel: 'vendor/cpm-multi:latest' });
    await screen.findByText('MCP local research models');

    // Never silently reverts to Auto — the operator must be able to see and fix it.
    await waitFor(() => expect(decomposeSelect()).toHaveValue('vendor/cpm-multi:latest'));
    expect(screen.getByText('vendor/cpm-multi:latest (not a text model)')).toBeInTheDocument();
    // The other picker is unaffected and offers only eligible models.
    expect(optionsOf(outlineSelect())).toEqual(ELIGIBLE);
  });

  it('offers Auto only, with guidance, when nothing eligible is installed', async () => {
    const base = global.fetch as jest.Mock;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/ollama/models')) {
        return jsonOk({ models: MODELS.filter(m => m.families?.includes('clip') || m.family === 'paddleocr') });
      }
      return base(input, init);
    }) as unknown as typeof fetch;

    render(<AdminAIServices />);
    await screen.findByText('MCP local research models');

    await waitFor(() => expect(optionsOf(outlineSelect())).toEqual(['']));
    expect(screen.getByText(/No text-generation model is installed/)).toBeInTheDocument();
  });
});
