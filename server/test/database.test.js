'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function database() {
  const calls = [];
  let sequence = 0;
  const pool = {
    async query(sql) { calls.push(['pool', sql]); },
    async execute(sql, args) { calls.push(['pool', sql, args]); return [[{ n: 1 }]]; },
    async getConnection() {
      const id = ++sequence;
      return {
        async beginTransaction() { calls.push([id, 'BEGIN']); },
        async query(sql) { calls.push([id, sql]); },
        async execute(sql, args) { calls.push([id, sql, args]); return [{ affectedRows: 1 }]; },
        async commit() { calls.push([id, 'COMMIT']); },
        async rollback() { calls.push([id, 'ROLLBACK']); },
        release() { calls.push([id, 'RELEASE']); },
      };
    },
    async end() { calls.push(['pool', 'END']); },
  };
  const context = vm.createContext({ module: { exports: {} }, process: { env: {} }, __dirname: path.resolve(__dirname, '..'),
    require(name) { return name === 'mysql2/promise' ? { createPool: () => pool } : require(name); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../database.js'), 'utf8'), context);
  return { db: new context.module.exports(), calls };
}

test('MySQL transactions isolate their connections and commit before release', async () => {
  const { db, calls } = database();
  await Promise.all([1, 2].map(value => db.transaction(async () => {
    await Promise.resolve();
    assert.equal((await db.prepare('UPDATE test SET value = ?').run(value)).changes, 1);
  })));
  for (const id of [1, 2]) {
    const own = calls.filter(c => c[0] === id);
    assert.deepEqual(own.map(c => c[1]), ['BEGIN', 'SELECT id FROM parking_lock WHERE id = 1 FOR UPDATE',
      'UPDATE test SET value = ?', 'COMMIT', 'RELEASE']);
    assert.equal(own[2][2][0], id);
  }
  assert.equal((await db.prepare('SELECT 1 AS n').get()).n, 1);
  assert.equal(calls.at(-1)[0], 'pool');
});

test('MySQL write failure rolls back and releases the same connection', async () => {
  const { db, calls } = database();
  await assert.rejects(db.transaction(async () => { throw new Error('write failed'); }), /write failed/);
  assert.deepEqual(calls.slice(-2), [[1, 'ROLLBACK'], [1, 'RELEASE']]);
});
