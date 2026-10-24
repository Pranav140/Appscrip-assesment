import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimulatedDevice } from './device.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface DeviceCreds {
  device_id: string;
  api_key: string;
  location_id: number;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {
    scenario: 'normal',
    api: process.env.API_URL ?? 'http://localhost:3000',
    devices: '5',
    rate: '1',
    duration: '30',
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].replace(/^--/, '');
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
      options[key] = val;
    }
  }
  return options;
}

async function loadCredentials(): Promise<Record<string, DeviceCreds>> {
  const candidates = [
    path.join(__dirname, '../../scripts/device-credentials.json'),
    path.join(__dirname, '../../../scripts/device-credentials.json'),
    path.join(process.cwd(), 'scripts/device-credentials.json'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  }

  // Fallback credentials if seed has not been run
  console.log('Notice: scripts/device-credentials.json not found, using default generated device keys');
  const defaults: Record<string, DeviceCreds> = {};
  for (let i = 1; i <= 12; i++) {
    const id = `dev-${String(i).padStart(3, '0')}`;
    defaults[id] = { device_id: id, api_key: `rtops_key_${id}_demo_secret`, location_id: 1 };
  }
  return defaults;
}

async function main() {
  const opts = parseArgs();
  const credentials = await loadCredentials();
  const bufferDir = path.join(process.cwd(), '.simulator_buffers');

  console.log(`=======================================================`);
  console.log(`  RTOps Device Fleet Simulator`);
  console.log(`  Scenario: ${opts.scenario}`);
  console.log(`  Target API: ${opts.api}`);
  console.log(`=======================================================\n`);

  const credEntries = Object.values(credentials).slice(0, parseInt(opts.devices, 10));
  const fleet: SimulatedDevice[] = credEntries.map(
    (c) =>
      new SimulatedDevice({
        deviceId: c.device_id,
        apiKey: c.api_key,
        apiBaseUrl: opts.api,
        bufferDir,
      })
  );

  switch (opts.scenario) {
    case 'normal':
      await runNormal(fleet, parseInt(opts.duration, 10), parseFloat(opts.rate));
      break;
    case 'offline-reconnect':
      await runOfflineReconnect(fleet);
      break;
    case 'duplicates':
      await runDuplicates(fleet);
      break;
    case 'out-of-order':
      await runOutOfOrder(fleet);
      break;
    case 'burst':
      await runBurst(fleet, 5000);
      break;
    case 'malformed':
      await runMalformed(fleet, opts.api);
      break;
    case 'abnormal-readings':
      await runAbnormalReadings(fleet);
      break;
    default:
      console.log(`Unknown scenario: ${opts.scenario}`);
      break;
  }

  printSummary(fleet);
}

async function runNormal(fleet: SimulatedDevice[], durationSec: number, rateHz: number) {
  console.log(`Running steady normal traffic for ${durationSec}s at ${rateHz} event/sec/dev...`);
  const interval = 1000 / rateHz;
  const end = Date.now() + durationSec * 1000;

  while (Date.now() < end) {
    for (const dev of fleet) {
      dev.generateTelemetry();
      await dev.flush(50);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function runOfflineReconnect(fleet: SimulatedDevice[]) {
  const target = fleet[0];
  console.log(`1. Target ${target.deviceId} generating telemetry while ONLINE`);
  for (let i = 0; i < 5; i++) {
    target.generateTelemetry();
  }
  await target.flush();

  console.log(`2. Taking ${target.deviceId} OFFLINE (simulating disconnect). Expect silence detector to notice...`);
  target.setOnline(false);

  // Generate 10 events while offline (buffered to local disk!)
  for (let i = 0; i < 10; i++) {
    target.generateTelemetry();
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`   ${target.deviceId} has ${target.getBufferDepth()} events buffered locally`);

  console.log(`3. Reconnecting ${target.deviceId} ONLINE and replaying buffered backlog...`);
  target.setOnline(true);
  const res = await target.flush(100);
  console.log(`   Replay complete: acked ${res.acked} events from buffer`);
}

async function runDuplicates(fleet: SimulatedDevice[]) {
  const target = fleet[0];
  console.log(`Generating a batch of 10 events from ${target.deviceId}...`);
  for (let i = 0; i < 10; i++) {
    target.generateTelemetry();
  }
  console.log(`Sending original batch...`);
  await target.flush();

  console.log(`Re-sending identical batch (expect server ack as 'duplicate' with zero DB duplication)...`);
  // Re-load and flush again
  const res = await target.flush();
  console.log(`Server responded to duplicates correctly: ${target.totalDuplicates} marked duplicate`);
}

async function runOutOfOrder(fleet: SimulatedDevice[]) {
  const target = fleet[0];
  console.log(`Generating events with deliberately shuffled and past timestamps...`);
  target.generateTelemetry(25, -300); // 5 min in past
  target.generateTelemetry(26, 0);    // now
  target.generateTelemetry(27, -600); // 10 min in past
  target.generateTelemetry(28, -60);  // 1 min in past
  await target.flush();
  console.log(`Out-of-order batch delivered; verify server monotonic last_seen_at protection`);
}

async function runBurst(fleet: SimulatedDevice[], count: number) {
  console.log(`Generating burst of ${count} events rapidly across ${fleet.length} devices...`);
  for (let i = 0; i < count; i++) {
    const dev = fleet[i % fleet.length];
    dev.generateTelemetry();
    if (i % 500 === 0) {
      process.stdout.write(`Generated ${i}/${count}...\r`);
    }
  }
  console.log(`\nFlushing burst batches to API with backpressure handling...`);
  for (const dev of fleet) {
    while (dev.getBufferDepth() > 0) {
      await dev.flush(100);
    }
  }
  console.log(`Burst drain complete.`);
}

async function runMalformed(fleet: SimulatedDevice[], apiBaseUrl: string) {
  const target = fleet[0];
  console.log(`Sending invalid and malformed payloads to verify isolation & rejected_events logging...`);

  const malformedPayloads = [
    { event_id: 'bad-1', device_id: target.deviceId, type: 'telemetry' }, // missing ts, schema_version
    { event_id: 'bad-2', device_id: target.deviceId, type: 'telemetry', ts: '2099-01-01T00:00:00Z', schema_version: 1 }, // future ts
    { event_id: 'bad-3', device_id: 'wrong-device-id', type: 'telemetry', ts: new Date().toISOString(), schema_version: 1 }, // mismatched device id
  ];

  try {
    const res = await fetch(`${apiBaseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': target.deviceId,
        'X-Device-Key': 'dummy_key',
      },
      body: JSON.stringify({ events: malformedPayloads }),
    });
    console.log(`API response status for malformed batch: ${res.status}`);
  } catch (err) {
    console.log(`Expected network/API handling: ${String(err)}`);
  }
}

async function runAbnormalReadings(fleet: SimulatedDevice[]) {
  const target = fleet[0];
  console.log(`Emitting temperature spike (>95°C) from ${target.deviceId} to trigger high temperature alarm...`);
  for (let i = 0; i < 5; i++) {
    target.generateTelemetry(98.5); // Alarm condition!
    await target.flush();
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`Emitting tamper security event...`);
  target.generateEvent('tamper', { sensor: 'chassis_switch', raw_code: 0xdead });
  await target.flush();
  console.log(`Abnormal events delivered! Check incident console for single open incident with bumped occurrence count.`);
}

function printSummary(fleet: SimulatedDevice[]) {
  console.log(`\n================ SIMULATOR RUN SUMMARY ================`);
  let totalGen = 0;
  let totalAck = 0;
  let totalDup = 0;
  let totalRej = 0;

  for (const d of fleet) {
    totalGen += d.totalGenerated;
    totalAck += d.totalAcked;
    totalDup += d.totalDuplicates;
    totalRej += d.totalRejected;
    console.log(
      `  Device ${d.deviceId}: generated=${d.totalGenerated}, acked=${d.totalAcked}, duplicates=${d.totalDuplicates}, buffered=${d.getBufferDepth()}`
    );
  }
  console.log(`-------------------------------------------------------`);
  console.log(`  TOTAL: Generated=${totalGen} | Acked=${totalAck} | Duplicates=${totalDup} | Rejected=${totalRej}`);
  console.log(`=======================================================\n`);
}

main().catch(console.error);
