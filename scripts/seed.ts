import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from '@rtops/db';
import { createLogger } from '@rtops/shared';

const logger = createLogger({ service: 'scripts:seed' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runSeed(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    logger.info('Starting database seed...');

    // 1. Locations
    const locations = [
      'Warehouse A - North Wing',
      'Manufacturing Plant 2',
      'Distribution Hub Austin',
    ];

    const locationIds: number[] = [];
    for (const name of locations) {
      const res = await client.query<{ id: number }>(
        `INSERT INTO locations (name) VALUES ($1)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [name]
      );
      if (res.rows.length > 0) {
        locationIds.push(res.rows[0].id);
      } else {
        const existing = await client.query<{ id: number }>('SELECT id FROM locations WHERE name = $1', [name]);
        locationIds.push(existing.rows[0].id);
      }
    }
    logger.info({ count: locationIds.length }, 'Seeded locations');

    // 2. Operators & operator_locations
    const operators = [
      { name: 'Alice Chen', email: 'alice@rtops.dev', webhook: 'http://localhost:3003/webhook' },
      { name: 'Bob Martinez', email: 'bob@rtops.dev', webhook: 'http://localhost:3003/webhook' },
      { name: 'Charlie Kim', email: 'charlie@rtops.dev', webhook: 'http://localhost:3003/webhook' },
    ];

    const operatorIds: number[] = [];
    for (let i = 0; i < operators.length; i++) {
      const op = operators[i];
      const res = await client.query<{ id: number }>(
        `INSERT INTO operators (name, email, webhook_url, active)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (email) DO UPDATE SET webhook_url = EXCLUDED.webhook_url
         RETURNING id`,
        [op.name, op.email, op.webhook]
      );
      const opId = res.rows[0].id;
      operatorIds.push(opId);

      // Map operator to corresponding location
      const locId = locationIds[i % locationIds.length];
      await client.query(
        `INSERT INTO operator_locations (operator_id, location_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [opId, locId]
      );
    }
    logger.info({ count: operatorIds.length }, 'Seeded operators and location mappings');

    // 3. Devices & Credentials
    const deviceCredentials: Record<string, { device_id: string; api_key: string; location_id: number }> = {};
    const deviceNames = [
      'Edge Gateway 01', 'HVAC Sensor North', 'Boiler Telemetry A', 'Chiller Monitor B',
      'Conveyor Belt Sensor', 'Ambient Lab 04', 'Battery Backup Rack', 'Solar Inverter 02',
      'Pump Station East', 'Cold Storage Unit 3', 'Transformer Unit 01', 'Security Node Main'
    ];

    for (let i = 0; i < deviceNames.length; i++) {
      const deviceId = `dev-${String(i + 1).padStart(3, '0')}`;
      const name = deviceNames[i];
      const locationId = locationIds[i % locationIds.length];
      const rawKey = `rtops_key_${deviceId}_${randomBytes(12).toString('hex')}`;
      const hash = createHash('sha256').update(rawKey).digest('hex');

      await client.query(
        `INSERT INTO devices (id, name, location_id, api_key_hash, status, metadata)
         VALUES ($1, $2, $3, $4, 'unknown', $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           location_id = EXCLUDED.location_id,
           api_key_hash = EXCLUDED.api_key_hash`,
        [
          deviceId,
          name,
          locationId,
          hash,
          JSON.stringify({ model: 'IoT-SensEdge-v2', firmware: '1.4.2' }),
        ]
      );

      deviceCredentials[deviceId] = {
        device_id: deviceId,
        api_key: rawKey,
        location_id: locationId,
      };
    }

    // Save credentials file for simulator
    const credsPath = path.join(__dirname, 'device-credentials.json');
    fs.writeFileSync(credsPath, JSON.stringify(deviceCredentials, null, 2), 'utf-8');
    logger.info({ count: Object.keys(deviceCredentials).length, file: credsPath }, 'Saved device credentials');

    // 4. Default Rules
    const defaultRules = [
      {
        name: 'High Temperature Alarm (>80°C)',
        enabled: true,
        type: 'threshold',
        scope: 'all',
        config: { metric: 'temperature', op: '>', value: 80 },
        severity: 'high',
        cooldown_seconds: 60,
        ignore_replayed: true,
        auto_resolve: false,
      },
      {
        name: 'Device Silence Warning (>60s)',
        enabled: true,
        type: 'silence',
        scope: 'all',
        config: { seconds: 60 },
        severity: 'medium',
        cooldown_seconds: 0,
        ignore_replayed: false,
        auto_resolve: true,
      },
      {
        name: 'Physical Tamper Detected',
        enabled: true,
        type: 'event_type',
        scope: 'all',
        config: { event_type: 'tamper' },
        severity: 'critical',
        cooldown_seconds: 120,
        ignore_replayed: false,
        auto_resolve: false,
      },
      {
        name: 'Battery Critical (<15%)',
        enabled: true,
        type: 'threshold',
        scope: 'all',
        config: { metric: 'battery', op: '<', value: 15 },
        severity: 'low',
        cooldown_seconds: 300,
        ignore_replayed: true,
        auto_resolve: false,
      },
    ];

    for (const rule of defaultRules) {
      await client.query(
        `INSERT INTO rules (
          name, enabled, type, scope, config, severity, cooldown_seconds, ignore_replayed, auto_resolve
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING`,
        [
          rule.name,
          rule.enabled,
          rule.type,
          rule.scope,
          JSON.stringify(rule.config),
          rule.severity,
          rule.cooldown_seconds,
          rule.ignore_replayed,
          rule.auto_resolve,
        ]
      );
    }
    logger.info({ count: defaultRules.length }, 'Seeded default rules');

    await client.query('COMMIT');
    logger.info('Database seeding completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err }, 'Database seeding failed');
    throw err;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

// Auto-run if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSeed()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
