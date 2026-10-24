import { getEnv } from '@rtops/shared';
import { migrate } from '@rtops/db';
import { buildApp } from './app.js';

async function main() {
  // Validate environment on startup
  const env = getEnv();

  // Run migrations on startup (idempotent)
  await migrate();

  const app = await buildApp();

  await app.listen({
    port: env.API_PORT,
    host: env.API_HOST,
  });

  const address = app.server.address();
  const port = typeof address === 'string' ? address : (address?.port ?? env.API_PORT);
  app.log.info({ port }, 'API server listening');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down gracefully...');
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Failed to start API server:', err);
  process.exit(1);
});
