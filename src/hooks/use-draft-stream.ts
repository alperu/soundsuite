'use client';

import { useState, useCallback, useRef } from 'react';

interface StreamResult {
  text: string;
  model?: string;
  provider?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

interface UseDraftStreamReturn {
  /** Start streaming from a URL with the given request body. */
  send: (url: string, body: object) => Promise<void>;
  /** Accumulated token text for live display. */
  tokens: string;
  /** Whether a stream is currently active. */
  isStreaming: boolean;
  /** Final result data when stream completes. */
  result: StreamResult | null;
  /** Error message if the stream failed. */
  error: string | null;
  /** Cancel the active stream. */
  abort: () => void;
}

/**
 * React hook for consuming NDJSON streams from draft API endpoints.
 * Handles token accumulation, result extraction, error handling, and abort.
 */
export function useDraftStream(): UseDraftStreamReturn {
  const [tokens, setTokens] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [result, setResult] = useState<StreamResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  const send = useCallback(async (url: string, body: object) => {
    // Abort any existing stream
    if (abortRef.current) {
      abortRef.current.abort();
    }

    // Reset state
    setTokens('');
    setResult(null);
    setError(null);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(errBody.error || `HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const event = JSON.parse(line);

            if (event.type === 'token' && event.text) {
              accumulated += event.text;
              setTokens(accumulated);
            } else if (event.type === 'result' && event.data) {
              setResult(event.data);
            } else if (event.type === 'error') {
              setError(event.error || 'Unknown stream error');
            }
            // progress events are ignored (could be handled by caller if needed)
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === 'token' && event.text) {
            accumulated += event.text;
            setTokens(accumulated);
          } else if (event.type === 'result' && event.data) {
            setResult(event.data);
          } else if (event.type === 'error') {
            setError(event.error || 'Unknown stream error');
          }
        } catch {
          // Skip
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // User cancelled — not an error
        return;
      }
      setError(err.message || 'Stream failed');
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, []);

  return { send, tokens, isStreaming, result, error, abort };
}
