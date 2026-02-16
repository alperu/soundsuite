/**
 * Tests for the centralized logger
 */

import { Logger, LogLevel, createLogger } from '../logger';

describe('Logger', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleInfoSpy: jest.SpyInstance;
  let consoleDebugSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation();
    consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });

  describe('createLogger', () => {
    it('should create a logger instance', () => {
      const logger = createLogger('TestComponent');
      expect(logger).toBeInstanceOf(Logger);
    });

    it('should create a logger with custom log level', () => {
      const logger = createLogger('TestComponent', LogLevel.DEBUG);
      expect(logger).toBeInstanceOf(Logger);
    });
  });

  describe('log levels', () => {
    it('should log debug messages', () => {
      const logger = createLogger('TestComponent', LogLevel.DEBUG);
      logger.debug('Debug message', { key: 'value' });
      
      expect(consoleDebugSpy).toHaveBeenCalled();
      const call = consoleDebugSpy.mock.calls[0][0];
      expect(call).toContain('[DEBUG]');
      expect(call).toContain('[TestComponent]');
      expect(call).toContain('Debug message');
    });

    it('should log info messages', () => {
      const logger = createLogger('TestComponent');
      logger.info('Info message', { key: 'value' });
      
      expect(consoleInfoSpy).toHaveBeenCalled();
      const call = consoleInfoSpy.mock.calls[0][0];
      expect(call).toContain('[INFO]');
      expect(call).toContain('[TestComponent]');
      expect(call).toContain('Info message');
    });

    it('should log warning messages', () => {
      const logger = createLogger('TestComponent');
      logger.warn('Warning message', { key: 'value' });
      
      expect(consoleWarnSpy).toHaveBeenCalled();
      const call = consoleWarnSpy.mock.calls[0][0];
      expect(call).toContain('[WARN]');
      expect(call).toContain('[TestComponent]');
      expect(call).toContain('Warning message');
    });

    it('should log error messages with stack trace', () => {
      const logger = createLogger('TestComponent');
      const error = new Error('Test error');
      logger.error('Error occurred', error, { key: 'value' });
      
      expect(consoleErrorSpy).toHaveBeenCalled();
      const calls = consoleErrorSpy.mock.calls;
      
      // First call is the main message
      expect(calls[0][0]).toContain('[ERROR]');
      expect(calls[0][0]).toContain('[TestComponent]');
      expect(calls[0][0]).toContain('Error occurred');
      
      // Second call is the error message
      expect(calls[1][0]).toContain('Error:');
      expect(calls[1][1]).toContain('Test error');
      
      // Third call is the stack trace
      expect(calls[2][0]).toContain('Stack:');
    });
  });

  describe('log level filtering', () => {
    it('should not log debug messages when min level is INFO', () => {
      const logger = createLogger('TestComponent', LogLevel.INFO);
      logger.debug('Debug message');
      
      expect(consoleDebugSpy).not.toHaveBeenCalled();
    });

    it('should log info messages when min level is INFO', () => {
      const logger = createLogger('TestComponent', LogLevel.INFO);
      logger.info('Info message');
      
      expect(consoleInfoSpy).toHaveBeenCalled();
    });

    it('should log error messages when min level is ERROR', () => {
      const logger = createLogger('TestComponent', LogLevel.ERROR);
      logger.error('Error message');
      
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should not log info messages when min level is ERROR', () => {
      const logger = createLogger('TestComponent', LogLevel.ERROR);
      logger.info('Info message');
      
      expect(consoleInfoSpy).not.toHaveBeenCalled();
    });
  });

  describe('child logger', () => {
    it('should create a child logger with combined component name', () => {
      const logger = createLogger('ParentComponent');
      const childLogger = logger.child('ChildComponent');
      
      childLogger.info('Child message');
      
      expect(consoleInfoSpy).toHaveBeenCalled();
      const call = consoleInfoSpy.mock.calls[0][0];
      expect(call).toContain('[ParentComponent:ChildComponent]');
    });
  });

  describe('error handling', () => {
    it('should handle non-Error objects', () => {
      const logger = createLogger('TestComponent');
      logger.error('Error occurred', 'string error');
      
      expect(consoleErrorSpy).toHaveBeenCalled();
      const calls = consoleErrorSpy.mock.calls;
      expect(calls[1][1]).toContain('string error');
    });

    it('should include error code if present', () => {
      const logger = createLogger('TestComponent');
      const error: any = new Error('Test error');
      error.code = 'TEST_CODE';
      logger.error('Error occurred', error);
      
      expect(consoleErrorSpy).toHaveBeenCalled();
      const calls = consoleErrorSpy.mock.calls;
      expect(calls[3][0]).toContain('Code:');
      expect(calls[3][1]).toBe('TEST_CODE');
    });
  });

  describe('timestamp', () => {
    it('should include ISO timestamp in log messages', () => {
      const logger = createLogger('TestComponent');
      logger.info('Test message');
      
      expect(consoleInfoSpy).toHaveBeenCalled();
      const call = consoleInfoSpy.mock.calls[0][0];
      
      // Check for ISO timestamp format (YYYY-MM-DDTHH:mm:ss.sssZ)
      expect(call).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    });
  });
});
