import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${ts} [${level}] ${stack ?? message}${metaStr}`;
});

function createLogger(logDir: string, logLevel: string, logToFile: boolean): winston.Logger {
  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: combine(
        colorize({ all: true }),
        timestamp({ format: 'HH:mm:ss.SSS' }),
        errors({ stack: true }),
        logFormat,
      ),
    }),
  ];

  if (logToFile) {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    transports.push(
      new (winston.transports as any).DailyRotateFile({
        dirname: logDir,
        filename: 'arb-bot-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxFiles: '14d',
        maxSize: '50m',
        format: combine(timestamp(), errors({ stack: true }), logFormat),
        level: 'debug',
      }),
      new (winston.transports as any).DailyRotateFile({
        dirname: logDir,
        filename: 'trades-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxFiles: '90d',
        maxSize: '20m',
        format: combine(timestamp(), logFormat),
        level: 'info',
      }),
    );
  }

  return winston.createLogger({
    level: logLevel,
    format: combine(errors({ stack: true }), timestamp()),
    transports,
  });
}

// Lazy-initialized singleton
let _logger: winston.Logger | null = null;

export function initLogger(logDir: string, logLevel: string, logToFile: boolean): void {
  _logger = createLogger(path.resolve(logDir), logLevel, logToFile);
}

export function getLogger(): winston.Logger {
  if (!_logger) {
    _logger = createLogger('./logs', 'info', false);
  }
  return _logger;
}

export const logger = new Proxy({} as winston.Logger, {
  get(_target, prop: string) {
    return (getLogger() as any)[prop];
  },
});
