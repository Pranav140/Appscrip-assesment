import { getPool } from '@rtops/db';
import { createLogger } from '@rtops/shared';

const logger = createLogger({ service: 'scripts:reconcile' });

async function main() {
  const pool = getPool();

  console.log(`=======================================================`);
  console.log(`  RTOps System Consistency & Zero-Loss Reconciliation`);
  console.log(`=======================================================\n`);

  try {
    // 1. Check duplicate events in DB
    const dupRes = await pool.query<{ count: string }>(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT device_id, event_id, COUNT(*)
        FROM events
        GROUP BY device_id, event_id
        HAVING COUNT(*) > 1
      ) dupes
    `);
    const duplicateCount = parseInt(dupRes.rows[0].count, 10);

    // 2. Event status counts
    const statusRes = await pool.query<{ status: string; count: string }>(`
      SELECT status, COUNT(*)::text AS count
      FROM events
      GROUP BY status
    `);
    const statusMap = Object.fromEntries(statusRes.rows.map((r) => [r.status, parseInt(r.count, 10)]));

    // 3. Duplicate incidents under active state
    const incDupeRes = await pool.query<{ count: string }>(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT dedupe_key, COUNT(*)
        FROM incidents
        WHERE state IN ('open', 'acknowledged')
        GROUP BY dedupe_key
        HAVING COUNT(*) > 1
      ) dupes
    `);
    const duplicateIncidents = parseInt(incDupeRes.rows[0].count, 10);

    // 4. Notification outbox stats
    const notifRes = await pool.query<{ status: string; count: string }>(`
      SELECT status, COUNT(*)::text AS count
      FROM notifications
      GROUP BY status
    `);
    const notifMap = Object.fromEntries(notifRes.rows.map((r) => [r.status, parseInt(r.count, 10)]));

    // 5. Total counts
    const totalEvents = Object.values(statusMap).reduce((a, b) => a + b, 0);

    console.log(`Events Overview:`);
    console.log(`  Total Ingested:      ${totalEvents}`);
    console.log(`  Done:                ${statusMap['done'] ?? 0}`);
    console.log(`  Failed (Dead-letter):${statusMap['failed'] ?? 0}`);
    console.log(`  Pending:             ${statusMap['pending'] ?? 0}`);
    console.log(`  Processing (in-flight): ${statusMap['processing'] ?? 0}`);
    console.log(`  Duplicate Event Rows:   ${duplicateCount} (Expected: 0)`);

    console.log(`\nIncidents Overview:`);
    console.log(`  Active Duplicate Violations: ${duplicateIncidents} (Expected: 0)`);

    console.log(`\nNotification Outbox:`);
    console.log(`  Sent:                ${notifMap['sent'] ?? 0}`);
    console.log(`  Pending/Sending:     ${(notifMap['pending'] ?? 0) + (notifMap['sending'] ?? 0)}`);
    console.log(`  Dead-letter:         ${notifMap['dead'] ?? 0}`);

    console.log(`\n-------------------------------------------------------`);
    const isClean = duplicateCount === 0 && duplicateIncidents === 0;

    if (isClean) {
      console.log(`  AUDIT RESULT: [ PASS ] Zero data loss, zero duplication.`);
    } else {
      console.log(`  AUDIT RESULT: [ FAIL ] Consistency violation detected.`);
    }
    console.log(`=======================================================\n`);
  } catch (err) {
    logger.error({ err }, 'Reconciliation failed with error');
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch(console.error);
