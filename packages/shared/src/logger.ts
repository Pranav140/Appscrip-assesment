import pino from 'pino';
import { getEnv } from './config.js';

export interface LoggerOptions {
  /** Service name, included in every log line */
  service: string;
  /** Override log level (defaults to env LOG_LEVEL) */
  level?: string;
}

/**
 * Create a structured pino logger with service name and common fields.
 * In test environments, logs are suppressed by default.
 */
export function createLogger(opts: LoggerOptions): pino.Logger {
  const env = getEnv();
  const level = opts.level ?? env.LOG_LEVEL;

  return pino({
    level,
    base: { service: opts.service, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    ...(env.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
        }
      : {}),
  });
}

export type Logger = pino.Logger;
