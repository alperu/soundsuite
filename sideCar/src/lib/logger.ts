type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m',  // green
  warn: '\x1b[33m',  // yellow
  error: '\x1b[31m', // red
};

const RESET = '\x1b[0m';

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return '';
  return '  ' + JSON.stringify(meta);
}

export interface Logger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

export function createLogger(category: string): Logger {
  const makeLog = (level: LogLevel) => (message: string, meta?: Record<string, unknown>) => {
    if (!shouldLog(level)) return;
    const ts = new Date().toISOString();
    const color = LEVEL_COLORS[level];
    const tag = level.toUpperCase().padEnd(5);
    console.log(`${color}[${ts}] [${tag}] [${category}]${RESET} ${message}${formatMeta(meta)}`);
  };

  return {
    debug: makeLog('debug'),
    info: makeLog('info'),
    warn: makeLog('warn'),
    error: makeLog('error'),
  };
}
