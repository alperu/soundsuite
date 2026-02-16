/**
 * Centralized logger for Sound Suite system.
 * 
 * Provides structured logging with timestamps, stack traces, and log levels.
 * All errors encountered by any component should be logged through this utility.
 * 
 * Requirements: 19.1
 */

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
  metadata?: Record<string, any>;
}

/**
 * Centralized logger with timestamp and stack trace support.
 * 
 * This logger provides structured logging for all components in the Sound Suite system.
 * Each log entry includes:
 * - Timestamp (ISO 8601 format)
 * - Log level (DEBUG, INFO, WARN, ERROR)
 * - Component name (for traceability)
 * - Message
 * - Error details (message, stack trace, error code)
 * - Optional metadata
 */
export class Logger {
  private component: string;
  private minLevel: LogLevel;

  constructor(component: string, minLevel: LogLevel = LogLevel.INFO) {
    this.component = component;
    this.minLevel = minLevel;
  }

  /**
   * Log a debug message
   */
  debug(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.DEBUG, message, undefined, metadata);
  }

  /**
   * Log an info message
   */
  info(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.INFO, message, undefined, metadata);
  }

  /**
   * Log a warning message
   */
  warn(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.WARN, message, undefined, metadata);
  }

  /**
   * Log an error with full stack trace
   * 
   * Requirement 19.1: Log error with timestamp and stack trace
   */
  error(message: string, error?: Error | unknown, metadata?: Record<string, any>): void {
    this.log(LogLevel.ERROR, message, error, metadata);
  }

  /**
   * Internal logging method
   */
  private log(
    level: LogLevel,
    message: string,
    error?: Error | unknown,
    metadata?: Record<string, any>
  ): void {
    // Check if this log level should be output
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      metadata,
    };

    // Add error details if provided
    if (error) {
      if (error instanceof Error) {
        entry.error = {
          message: error.message,
          stack: error.stack,
          code: (error as any).code,
        };
      } else {
        entry.error = {
          message: String(error),
        };
      }
    }

    // Capture GPU-related logs for admin UI
    captureGpuLog(entry);

    // Format and output the log entry
    this.output(entry);
  }

  /**
   * Check if a log level should be output based on minimum level
   */
  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    const currentIndex = levels.indexOf(level);
    const minIndex = levels.indexOf(this.minLevel);
    return currentIndex >= minIndex;
  }

  /**
   * Output the log entry to console
   * 
   * In production, this could be extended to write to files, send to logging services, etc.
   */
  private output(entry: LogEntry): void {
    const prefix = `[${entry.timestamp}] [${entry.level}] [${entry.component}]`;
    const message = `${prefix} ${entry.message}`;

    // Choose console method based on log level
    switch (entry.level) {
      case LogLevel.DEBUG:
        console.debug(message, entry.metadata || '');
        break;
      case LogLevel.INFO:
        console.info(message, entry.metadata || '');
        break;
      case LogLevel.WARN:
        console.warn(message, entry.metadata || '');
        if (entry.error) {
          console.warn('  Error:', entry.error.message);
          if (entry.error.stack) {
            console.warn('  Stack:', entry.error.stack);
          }
        }
        break;
      case LogLevel.ERROR:
        console.error(message, entry.metadata || '');
        if (entry.error) {
          console.error('  Error:', entry.error.message);
          if (entry.error.stack) {
            console.error('  Stack:', entry.error.stack);
          }
          if (entry.error.code) {
            console.error('  Code:', entry.error.code);
          }
        }
        break;
    }
  }

  /**
   * Create a child logger with additional context
   */
  child(subComponent: string): Logger {
    return new Logger(`${this.component}:${subComponent}`, this.minLevel);
  }
}

/**
 * Create a logger instance for a component
 */
export function createLogger(component: string, minLevel?: LogLevel): Logger {
  return new Logger(component, minLevel);
}

/** Default logger instance */
export const logger = createLogger('App');

// ─── GPU Communication Log Ring Buffer ────────────────────────────────────────
// Captures recent logs from WsRelay, CommandQueue, FleetRouter, StatusCache
// for display in the admin GPU fleet page.

const GPU_LOG_COMPONENTS = new Set(['WsRelay', 'CommandQueue', 'FleetRouter', 'StatusCache']);
const GPU_LOG_MAX = 200;

export interface GpuLogEntry {
  ts: number;
  level: string;
  component: string;
  message: string;
  meta?: Record<string, any>;
}

// Use globalThis so logs captured in worker-init context are visible in API route context
const gLog = globalThis as any;
if (!gLog.__ss_gpu_log_buffer__) gLog.__ss_gpu_log_buffer__ = [] as GpuLogEntry[];
const gpuLogBuffer: GpuLogEntry[] = gLog.__ss_gpu_log_buffer__;

/** Called internally by Logger.output() to capture GPU-related logs */
export function captureGpuLog(entry: LogEntry): void {
  if (!GPU_LOG_COMPONENTS.has(entry.component)) return;
  gpuLogBuffer.push({
    ts: Date.now(),
    level: entry.level,
    component: entry.component,
    message: entry.message,
    meta: entry.metadata,
  });
  if (gpuLogBuffer.length > GPU_LOG_MAX) {
    gpuLogBuffer.splice(0, gpuLogBuffer.length - GPU_LOG_MAX);
  }
}

/** Get recent GPU communication logs (newest first) */
export function getGpuLogs(limit = 100): GpuLogEntry[] {
  return gpuLogBuffer.slice(-limit).reverse();
}
