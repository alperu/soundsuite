// Polyfills for Node.js environment
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Mock Next.js server components
global.Request = class Request {
  constructor(input, init) {
    this.url = input;
    this.method = init?.method || 'GET';
    this.headers = new Map(Object.entries(init?.headers || {}));
    this.body = init?.body;
  }
};

global.Response = class Response {
  constructor(body, init) {
    this.body = body;
    this.status = init?.status || 200;
    this.headers = new Map(Object.entries(init?.headers || {}));
  }
  
  json() {
    return Promise.resolve(JSON.parse(this.body));
  }
};

global.Headers = class Headers extends Map {
  constructor(init) {
    super(Object.entries(init || {}));
  }
};

// Mock fetch for tests
global.fetch = jest.fn();

// No global OCR mock needed — OCREngine uses child_process.fork,
// which is mocked per-test in ocr-engine.test.ts.

// Mock logger to avoid module resolution issues
jest.mock('@/lib/logger', () => {
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  };
  
  return {
    LogLevel: {
      DEBUG: 'DEBUG',
      INFO: 'INFO',
      WARN: 'WARN',
      ERROR: 'ERROR',
    },
    Logger: jest.fn().mockImplementation(() => mockLogger),
    createLogger: jest.fn().mockReturnValue(mockLogger),
  };
});

// Suppress console errors in tests (optional)
// global.console.error = jest.fn();
