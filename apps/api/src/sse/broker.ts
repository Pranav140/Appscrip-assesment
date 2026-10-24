import { EventEmitter } from 'node:events';
import { DEFAULTS, type SSEEventKind } from '@rtops/shared';
import { sseCLientsGauge, sseMessagesSentTotal } from '../metrics.js';

export interface SSEMessage {
  kind: SSEEventKind;
  id?: string;          // event id for Last-Event-ID resume
  data: unknown;
}

interface Client {
  id: string;
  /** Cursor: last activity_log id or ingest_seq sent to this client */
  lastEventId: string;
  /** Bounded buffer — drops 'event' kind when full, never drops incident/device */
  queue: SSEMessage[];
  emit: (msg: SSEMessage) => void;
  isSlow: boolean;
}

class SSEBroker extends EventEmitter {
  private clients = new Map<string, Client>();

  addClient(id: string, lastEventId: string, emitFn: (msg: SSEMessage) => void): void {
    this.clients.set(id, {
      id,
      lastEventId,
      queue: [],
      emit: emitFn,
      isSlow: false,
    });
    sseCLientsGauge.set(this.clients.size);
  }

  removeClient(id: string): void {
    this.clients.delete(id);
    sseCLientsGauge.set(this.clients.size);
  }

  /** Broadcast a message to all connected clients */
  broadcast(msg: SSEMessage): void {
    for (const client of this.clients.values()) {
      this.sendToClient(client, msg);
    }
  }

  private sendToClient(client: Client, msg: SSEMessage): void {
    const isHighPriority = msg.kind === 'incident' || msg.kind === 'device' || msg.kind === 'resync';

    if (!isHighPriority && client.queue.length >= DEFAULTS.SSE_CLIENT_QUEUE_LIMIT) {
      // Drop low-priority event, client is too slow
      client.isSlow = true;
      return;
    }

    client.queue.push(msg);
    client.emit(msg);
    sseMessagesSentTotal.inc({ kind: msg.kind });
  }

  /** Send a resync signal to all clients (e.g. after LISTEN reconnect) */
  broadcastResync(): void {
    this.broadcast({ kind: 'resync', data: { ts: new Date().toISOString() } });
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

// Singleton broker shared across the process
export const sseBroker = new SSEBroker();
