'use strict';
// Run with Node 22.13+ while the old backend is stopped. The source is read-only.
const { DatabaseSync } = require('node:sqlite');
const Database = require('../database');
const path = require('node:path');

async function migrate() {
  if (!process.argv[2]) throw new Error('Usage: node --env-file=.env scripts/migrate-sqlite.js /path/to/parking.db');
  const source = new DatabaseSync(path.resolve(process.argv[2]), { readOnly: true });
  const target = new Database();
  try {
    await target.init();
    const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
    const tickets = source.prepare('SELECT * FROM tickets ORDER BY created_at, code').all();
    const resets = tables.has('admin_resets') ? source.prepare('SELECT * FROM admin_resets ORDER BY rowid').all() : [];
    const fields = ['code','status','slot','plate','phone','ip','created_at','expires_at','entry_at','exit_at',
      'fee','paid_at','exit_operation','paid_hours','paid_parked_sec','paid_rate','paid_period_sec','admin_reset_id','cancelled_at'];
    await target.transaction(async () => {
      if ((await target.prepare('SELECT COUNT(*) AS n FROM tickets').get()).n ||
          (await target.prepare('SELECT COUNT(*) AS n FROM admin_resets').get()).n)
        throw new Error('Target database must be empty. No existing records were overwritten.');
      for (const reset of resets) await target.prepare(
        'INSERT INTO admin_resets(request_id,created_at,completed_at,cancelled_count,status,slot,exit_operation) VALUES (?,?,?,?,?,?,?)'
      ).run(reset.request_id, reset.created_at, reset.completed_at ?? null, reset.cancelled_count, reset.status,
        reset.slot ?? null, reset.exit_operation ?? null);
      const insert = target.prepare(`INSERT INTO tickets(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`);
      for (const ticket of tickets) {
        // Expired holds must not violate the unique active slot/plate constraints.
        if (ticket.status === 'RESERVED' && ticket.expires_at <= Date.now()) ticket.status = 'EXPIRED';
        await insert.run(...fields.map(field => ticket[field] ?? null));
      }
    });
    console.log(`Migrated ${tickets.length} tickets and ${resets.length} resets. Source SQLite was not modified.`);
  } finally { source.close(); await target.close(); }
}
migrate().catch(error => { console.error('Migration failed:', error.code || error.message); process.exitCode = 1; });
