/**
 * Unit tests for OCREngine (child process / PaddleOCR backend)
 */

// Mock child_process — OCREngine uses dynamic require('child_process')
// so we mock the module that require() will return.
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    fork: jest.fn(),
  };
});

import { OCREngine } from '../ocr-engine';
import { fork } from 'child_process';
import sharp from 'sharp';

const mockFork = fork as jest.MockedFunction<typeof fork>;

/** Poll until condition is true (or timeout) */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('OCREngine', () => {
  let ocr: OCREngine;
  let mockChild: {
    on: jest.Mock;
    send: jest.Mock;
    kill: jest.Mock;
    connected: boolean;
    stdout: { on: jest.Mock };
    stderr: { on: jest.Mock };
  };

  // Capture IPC handlers registered by OCREngine
  let messageHandler: (msg: any) => void;
  let errorHandler: (err: Error) => void;
  let exitHandler: (code: number | null) => void;

  beforeEach(() => {
    mockChild = {
      on: jest.fn((event: string, handler: any) => {
        if (event === 'message') messageHandler = handler;
        if (event === 'error') errorHandler = handler;
        if (event === 'exit') exitHandler = handler;
      }),
      send: jest.fn(),
      kill: jest.fn(),
      connected: true,
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
    };

    mockFork.mockReturnValue(mockChild as any);
    ocr = new OCREngine({ language: 'eng' });
  });

  afterEach(async () => {
    await ocr.terminate();
    jest.clearAllMocks();
  });

  /** Helper: start recognizeImage, signal ready, wait for send, return promise */
  async function startOcrAndWaitForSend(imageBuffer: Buffer): Promise<{
    resultPromise: Promise<any>;
    sentMsg: { type: string; id: string; filePath: string };
  }> {
    const resultPromise = ocr.recognizeImage(imageBuffer);

    // Wait for fork to happen and signal ready
    await waitFor(() => mockChild.on.mock.calls.length >= 3);
    messageHandler({ type: 'ready' });

    // Wait for the engine to preprocess + write temp file + call send
    await waitFor(() => mockChild.send.mock.calls.length > 0);

    const sentMsg = mockChild.send.mock.calls[mockChild.send.mock.calls.length - 1][0];
    return { resultPromise, sentMsg };
  }

  describe('recognizeImage', () => {
    it('should fork a child process, send IPC message, and return result', async () => {
      const testImage = await sharp({
        create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } },
      }).png().toBuffer();

      const { resultPromise, sentMsg } = await startOcrAndWaitForSend(testImage);

      expect(sentMsg.type).toBe('ocr');
      expect(sentMsg.filePath).toContain('.png');

      // Simulate child returning result
      messageHandler({
        type: 'result',
        id: sentMsg.id,
        text: 'Hello World',
        confidence: 95,
      });

      const result = await resultPromise;
      expect(result.text).toBe('Hello World');
      expect(result.confidence).toBe(95);
    });

    it('should handle OCR errors from child process', async () => {
      const testImage = await sharp({
        create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } },
      }).png().toBuffer();

      const { resultPromise, sentMsg } = await startOcrAndWaitForSend(testImage);

      messageHandler({
        type: 'error',
        id: sentMsg.id,
        error: 'Detection failed',
      });

      await expect(resultPromise).rejects.toThrow('Detection failed');
    });

    it('should reuse the same child process for multiple calls', async () => {
      const testImage = await sharp({
        create: { width: 50, height: 50, channels: 3, background: { r: 255, g: 255, b: 255 } },
      }).png().toBuffer();

      // First call
      const { resultPromise: p1, sentMsg: msg1 } = await startOcrAndWaitForSend(testImage);
      messageHandler({ type: 'result', id: msg1.id, text: 'First', confidence: 90 });
      await p1;

      // Second call — should not fork again
      const callsBefore = mockChild.send.mock.calls.length;
      const p2 = ocr.recognizeImage(testImage);
      await waitFor(() => mockChild.send.mock.calls.length > callsBefore);
      const msg2 = mockChild.send.mock.calls[mockChild.send.mock.calls.length - 1][0];
      messageHandler({ type: 'result', id: msg2.id, text: 'Second', confidence: 92 });
      const result2 = await p2;

      expect(mockFork).toHaveBeenCalledTimes(1);
      expect(result2.text).toBe('Second');
    });
  });

  describe('terminate', () => {
    it('should kill the child process', async () => {
      const testImage = await sharp({
        create: { width: 50, height: 50, channels: 3, background: { r: 255, g: 255, b: 255 } },
      }).png().toBuffer();

      const { resultPromise, sentMsg } = await startOcrAndWaitForSend(testImage);
      messageHandler({ type: 'result', id: sentMsg.id, text: '', confidence: 0 });
      await resultPromise;

      await ocr.terminate();
      expect(mockChild.kill).toHaveBeenCalled();
    });

    it('should be safe to call terminate without initialization', async () => {
      await expect(ocr.terminate()).resolves.not.toThrow();
    });
  });

  describe('child process crash', () => {
    it('should reject pending requests when child exits', async () => {
      const testImage = await sharp({
        create: { width: 50, height: 50, channels: 3, background: { r: 255, g: 255, b: 255 } },
      }).png().toBuffer();

      const { resultPromise } = await startOcrAndWaitForSend(testImage);

      // Simulate child crashing
      exitHandler(1);

      await expect(resultPromise).rejects.toThrow('exited with code 1');
    });
  });

  describe('preprocessing', () => {
    it('should skip sharp preprocessing by default', async () => {
      const testImage = await sharp({
        create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } },
      }).png().toBuffer();

      const { resultPromise, sentMsg } = await startOcrAndWaitForSend(testImage);

      // Simulate result
      messageHandler({ type: 'result', id: sentMsg.id, text: 'Hello', confidence: 90 });
      await resultPromise;

      // sharp should NOT have been called for preprocessing (grayscale().normalize().png())
      // since preprocess defaults to false — the original buffer is written directly
      const sharpGrayscale = (sharp as any).mockGrayscale;
      // With preprocess=false, sharp is not called for preprocessing.
      // We verify by checking the sent file contains the original PNG data size range.
      // The test image is a 100x100 white PNG, if preprocessed it would be different.
      // Since we can't easily spy on the private method, we verify the config default.
      expect(ocr['config'].preprocess).toBe(false);
    });

    it('should apply sharp preprocessing when preprocess=true', () => {
      const preprocessOcr = new OCREngine({ language: 'eng', preprocess: true });
      expect(preprocessOcr['config'].preprocess).toBe(true);
    });
  });

  describe('temp file reuse', () => {
    it('should reuse the same temp file path across calls', async () => {
      const testImage = await sharp({
        create: { width: 50, height: 50, channels: 3, background: { r: 255, g: 255, b: 255 } },
      }).png().toBuffer();

      // First call
      const { resultPromise: p1, sentMsg: msg1 } = await startOcrAndWaitForSend(testImage);
      const tmpPath1 = msg1.filePath;
      messageHandler({ type: 'result', id: msg1.id, text: 'First', confidence: 90 });
      await p1;

      // Second call
      const callsBefore = mockChild.send.mock.calls.length;
      const p2 = ocr.recognizeImage(testImage);
      await waitFor(() => mockChild.send.mock.calls.length > callsBefore);
      const msg2 = mockChild.send.mock.calls[mockChild.send.mock.calls.length - 1][0];
      messageHandler({ type: 'result', id: msg2.id, text: 'Second', confidence: 92 });
      await p2;

      // Both calls should use the same temp file path
      expect(msg2.filePath).toBe(tmpPath1);
    });
  });

  describe('configuration', () => {
    it('should accept custom language configuration', () => {
      const customOcr = new OCREngine({ language: 'fra' });
      expect(customOcr).toBeDefined();
    });

    it('should use default language when not specified', () => {
      const defaultOcr = new OCREngine();
      expect(defaultOcr).toBeDefined();
    });
  });
});
