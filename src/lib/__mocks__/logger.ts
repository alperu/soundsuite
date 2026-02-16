// Mock logger for tests

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

export class Logger {
  constructor(public component: string, public minLevel: LogLevel = LogLevel.INFO) {}

  debug = jest.fn();
  info = jest.fn();
  warn = jest.fn();
  error = jest.fn();
  child = jest.fn((subComponent: string) => new Logger(`${this.component}:${subComponent}`, this.minLevel));
}

export function createLogger(component: string, minLevel?: LogLevel): Logger {
  return new Logger(component, minLevel);
}
