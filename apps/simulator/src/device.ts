import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DeviceEvent, IngestResponse } from '@rtops/shared';

export interface SimulatedDeviceConfig {
  deviceId: string;
  apiKey: string;
  apiBaseUrl: string;
  bufferDir: string;
}

export class SimulatedDevice {
  public deviceId: string;
  private apiKey: string;
  private apiBaseUrl: string;
  private bufferFile: string;
  private seq = 0;
  private isOnline = true;
  private buffer: DeviceEvent[] = [];
  public totalGenerated = 0;
  public totalAcked = 0;
  public totalDuplicates = 0;
  public totalRejected = 0;

  constructor(config: SimulatedDeviceConfig) {
    this.deviceId = config.deviceId;
    this.apiKey = config.apiKey;
    this.apiBaseUrl = config.apiBaseUrl;

    if (!fs.existsSync(config.bufferDir)) {
      fs.mkdirSync(config.bufferDir, { recursive: true });
    }
    this.bufferFile = path.join(config.bufferDir, `${this.deviceId}.jsonl`);
    this.loadBufferFromDisk();
  }

  public setOnline(online: boolean): void {
    this.isOnline = online;
  }

  public getOnline(): boolean {
    return this.isOnline;
  }

  private loadBufferFromDisk(): void {
    if (fs.existsSync(this.bufferFile)) {
      const lines = fs.readFileSync(this.bufferFile, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          this.buffer.push(JSON.parse(line));
        } catch {
          // ignore corrupted line
        }
      }
      this.totalGenerated += this.buffer.length;
    }
  }

  private persistBuffer(): void {
    const content = this.buffer.map((e) => JSON.stringify(e)).join('\n') + (this.buffer.length > 0 ? '\n' : '');
    fs.writeFileSync(this.bufferFile, content, 'utf-8');
  }

  public generateTelemetry(customTemp?: number, skewSeconds = 0): DeviceEvent {
    this.seq++;
    this.totalGenerated++;

    const temp = customTemp ?? 20 + Math.random() * 15; // 20 - 35 °C normal
    const ts = new Date(Date.now() + skewSeconds * 1000).toISOString();

    const event: DeviceEvent = {
      event_id: randomUUID(),
      device_id: this.deviceId,
      seq: this.seq,
      type: 'telemetry',
      ts,
      payload: {
        temperature: parseFloat(temp.toFixed(1)),
        humidity: parseFloat((40 + Math.random() * 30).toFixed(1)),
        battery: Math.max(5, Math.min(100, Math.round(95 - (this.seq % 50)))),
      },
      schema_version: 1,
    };

    this.buffer.push(event);
    this.persistBuffer();
    return event;
  }

  public generateEvent(type: string, payload: Record<string, unknown> = {}, skewSeconds = 0): DeviceEvent {
    this.seq++;
    this.totalGenerated++;

    const ts = new Date(Date.now() + skewSeconds * 1000).toISOString();
    const event: DeviceEvent = {
      event_id: randomUUID(),
      device_id: this.deviceId,
      seq: this.seq,
      type,
      ts,
      payload,
      schema_version: 1,
    };

    this.buffer.push(event);
    this.persistBuffer();
    return event;
  }

  public async flush(batchLimit = 100): Promise<{ sent: number; acked: number }> {
    if (!this.isOnline || this.buffer.length === 0) {
      return { sent: 0, acked: 0 };
    }

    const batch = this.buffer.slice(0, batchLimit);

    try {
      const res = await fetch(`${this.apiBaseUrl}/v1/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': this.deviceId,
          'X-Device-Key': this.apiKey,
        },
        body: JSON.stringify({ events: batch }),
      });

      if (res.status === 429) {
        // Backpressure: read Retry-After header and pause
        const retryAfter = parseInt(res.headers.get('Retry-After') ?? '1', 10);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        return { sent: batch.length, acked: 0 };
      }

      if (!res.ok) {
        return { sent: batch.length, acked: 0 };
      }

      const data = (await res.json()) as IngestResponse;
      const ackedIds = new Set<string>();

      for (const item of data.results) {
        if (item.status === 'accepted') {
          this.totalAcked++;
          ackedIds.add(item.event_id);
        } else if (item.status === 'duplicate') {
          this.totalDuplicates++;
          ackedIds.add(item.event_id);
        } else if (item.status === 'rejected') {
          this.totalRejected++;
          ackedIds.add(item.event_id); // Drop rejected event from buffer so it is not retried forever
        }
      }

      // Compact buffer: remove processed events
      this.buffer = this.buffer.filter((e) => !ackedIds.has(e.event_id));
      this.persistBuffer();

      return { sent: batch.length, acked: ackedIds.size };
    } catch {
      // Network drop, keep in buffer
      return { sent: batch.length, acked: 0 };
    }
  }

  public getBufferDepth(): number {
    return this.buffer.length;
  }
}
