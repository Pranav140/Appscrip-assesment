import Fastify from 'fastify';

interface ReceivedNotification {
  received_at: string;
  idempotency_key: string;
  payload: unknown;
}

const app = Fastify({ logger: true });

let isUp = true;
const receivedMap = new Map<string, ReceivedNotification>();
const deliveryLog: { received_at: string; idempotency_key: string; status: string }[] = [];

// Main webhook receiver
app.post('/webhook', async (req, reply) => {
  if (!isUp) {
    return reply.status(503).send({ error: 'Webhook sink currently toggled DOWN' });
  }

  const idempotencyKey = (req.headers['idempotency-key'] as string) ?? 'missing-key';
  const now = new Date().toISOString();

  if (receivedMap.has(idempotencyKey)) {
    deliveryLog.push({ received_at: now, idempotency_key: idempotencyKey, status: 'duplicate_deduped' });
    req.log.info({ idempotencyKey }, 'Received duplicate webhook with known idempotency key (deduped)');
    return reply.status(200).send({ status: 'duplicate', idempotency_key: idempotencyKey });
  }

  const entry: ReceivedNotification = {
    received_at: now,
    idempotency_key: idempotencyKey,
    payload: req.body,
  };

  receivedMap.set(idempotencyKey, entry);
  deliveryLog.push({ received_at: now, idempotency_key: idempotencyKey, status: 'accepted' });
  req.log.info({ idempotencyKey, body: req.body }, 'Accepted new webhook delivery');

  return reply.status(200).send({ status: 'accepted', idempotency_key: idempotencyKey });
});

// Admin controls to simulate outages and check received notifications
app.post('/admin/down', async (_req, reply) => {
  isUp = false;
  app.log.warn('Webhook sink state changed to: DOWN (503)');
  return reply.send({ isUp, message: 'Webhook sink is now DOWN (simulating external outage)' });
});

app.post('/admin/up', async (_req, reply) => {
  isUp = true;
  app.log.info('Webhook sink state changed to: UP (200)');
  return reply.send({ isUp, message: 'Webhook sink is now UP (service restored)' });
});

app.get('/admin/status', async (_req, reply) => {
  return reply.send({
    isUp,
    total_unique_received: receivedMap.size,
    total_attempts_logged: deliveryLog.length,
  });
});

app.get('/admin/received', async (_req, reply) => {
  return reply.send({
    isUp,
    total_received: receivedMap.size,
    items: Array.from(receivedMap.values()),
    delivery_log: deliveryLog,
  });
});

app.post('/admin/clear', async (_req, reply) => {
  receivedMap.clear();
  deliveryLog.length = 0;
  return reply.send({ status: 'cleared' });
});

const port = parseInt(process.env.PORT ?? '3003', 10);
app.listen({ port, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Webhook sink server listening at ${address}`);
});
