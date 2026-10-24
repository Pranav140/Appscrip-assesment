import { z } from 'zod';

// ── Shared environment schema ─────────────────────────────────────────────
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  HIGH_WATERMARK: z.coerce.number().int().positive().default(5000),
  HARD_WATERMARK: z.coerce.number().int().positive().default(10000),
  REPLAY_THRESHOLD_SECONDS: z.coerce.number().int().positive().default(120),
  MAX_FUTURE_SECONDS: z.coerce.number().int().positive().default(86400),
  MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  WORKER_LEASE_SECONDS: z.coerce.number().int().positive().default(30),
  STALE_AFTER_SECONDS: z.coerce.number().int().positive().default(30),
  OFFLINE_AFTER_SECONDS: z.coerce.number().int().positive().default(90),
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  STARTUP_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(180),
  MAX_NOTIFY_ATTEMPTS: z.coerce.number().int().positive().default(8),
  NOTIFY_WEBHOOK_URL: z.string().url().optional(),
  CIRCUIT_BREAKER_K: z.coerce.number().int().positive().default(5),
  CIRCUIT_BREAKER_COOL_OFF_SECONDS: z.coerce.number().int().positive().default(60),
  RULE_CACHE_TTL_MS: z.coerce.number().int().positive().default(5000),
  TRACE_ALL_EVALUATIONS: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  OPERATOR_TOKEN: z.string().min(1).default('dev-operator-token-change-in-prod'),
  ADMIN_TOKEN: z.string().min(1).default('dev-admin-token-change-in-prod'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  WEBHOOK_SINK_PORT: z.coerce.number().int().positive().default(4000),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

/**
 * Parse and validate environment variables. Throws on missing/invalid values.
 * Call once at startup. Result is cached.
 */
export function getEnv(): Env {
  if (_env) return _env;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`
    );
  }
  _env = result.data;
  return _env;
}

/** Reset cached env (for testing) */
export function resetEnv(): void {
  _env = null;
}
