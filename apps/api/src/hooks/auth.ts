import type { FastifyRequest, FastifyReply } from 'fastify';
import { getEnv } from '@rtops/shared';

/**
 * Fastify hook that enforces operator authentication.
 * Accepts Bearer token in Authorization header OR ?token= query param
 * (SSE clients cannot set headers via EventSource).
 */
export async function operatorAuthHook(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const env = getEnv();

  let token: string | undefined;

  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  // Fallback to query param for EventSource connections
  if (!token) {
    const query = req.query as Record<string, string>;
    token = query['token'];
  }

  if (!token) {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing authentication token. Use Authorization: Bearer <token> or ?token=',
      },
    });
  }

  // Constant-time comparison to prevent timing attacks
  const expected = Buffer.from(env.OPERATOR_TOKEN);
  const provided = Buffer.from(token);
  if (expected.length !== provided.length || !require('crypto').timingSafeEqual(expected, provided)) {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid authentication token.',
      },
    });
  }
}
