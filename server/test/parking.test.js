'use strict';
// Runs production async handlers with a SQLite test adapter and simulated device.
// Production uses MySQL. These portable tests exercise lifecycle and SQL predicates.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');

async function fixture(t, options = {}) {
  let now = 1700000000000, nextTimer = 0;
  const timers = new Map(), routes = new Map();
  function schedule(fn, delay, repeat = false) {
    const id = ++nextTimer;
    timers.set(id, { fn, due: now + delay, delay, repeat });
    return id;
  }
  async function advance(ms) {
    await flush();
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.due;
      if (timer.repeat) timer.due += timer.delay;
      else timers.delete(id);
      await timer.fn();
      await flush();
    }
    now = target;
  }
  const app = { set() {}, disable() {}, use() {},
    get(route, handler) { routes.set('GET ' + route, handler); },
    post(route, handler) { routes.set('POST ' + route, handler); } };
  const express = Object.assign(() => app, { json() {}, urlencoded() {}, static() {} });
  class Sqlite {
    constructor() {
      const file = options.dbFile || ':memory:';
      this.db = new DatabaseSync(file);
      if (options.legacy) this.db.exec(`CREATE TABLE IF NOT EXISTS tickets (
        code TEXT PRIMARY KEY, status TEXT NOT NULL, slot INTEGER, plate TEXT, phone TEXT, ip TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER, entry_at INTEGER, exit_at INTEGER, fee INTEGER)`);
    }
    async init() {
      this.db.exec(`CREATE TABLE IF NOT EXISTS tickets (
        code TEXT PRIMARY KEY, status TEXT NOT NULL, slot INTEGER, plate TEXT, phone TEXT, ip TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER, entry_at INTEGER, exit_at INTEGER, fee INTEGER)`);
      const columns = new Set(this.db.prepare('PRAGMA table_info(tickets)').all().map(c => c.name));
      for (const [name, type] of Object.entries({ paid_at: 'INTEGER', exit_operation: 'TEXT', paid_hours: 'INTEGER', paid_parked_sec: 'INTEGER', paid_rate: 'INTEGER', paid_period_sec: 'INTEGER', admin_reset_id: 'TEXT', cancelled_at: 'INTEGER' }))
        if (!columns.has(name)) this.db.exec('ALTER TABLE tickets ADD COLUMN ' + name + ' ' + type);
      this.db.exec(`CREATE TABLE IF NOT EXISTS admin_resets (
        sequence_id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE, slot INTEGER, exit_operation TEXT,
        created_at INTEGER, completed_at INTEGER, cancelled_count INTEGER DEFAULT 0, status TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS tickets_exit_operation ON tickets(exit_operation);`);
      this.tail = Promise.resolve();
    }
    async transaction(fn) {
      const prior = this.tail;
      let release; this.tail = new Promise(resolve => { release = resolve; });
      await prior;
      this.db.exec('BEGIN IMMEDIATE');
      try { const result = await fn(); this.db.exec('COMMIT'); return result; }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
      finally { release(); }
    }
    pragma(sql) { this.db.exec('PRAGMA ' + sql); }
    exec(sql) { this.db.exec(sql); }
    prepare(sql) { return this.db.prepare(sql); }
    close() { if (!this.closed) { this.db.close(); this.closed = true; } }
  }
  class WSS extends EventEmitter {
    constructor() { super(); this.clients = new Set(); }
    handleUpgrade(_req, _socket, _head, callback) { callback(new Device()); }
  }
  class Device extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.commands = []; this.messages = []; this.reply = true; }
    send(text, cb) {
      const m = JSON.parse(text);
      this.messages.push(m);
      if (m.t === 'open') {
        this.commands.push(m);
        if (this.onOpen) this.onOpen(m);
        if (this.reply !== null) queueMicrotask(() => this.emit('message', JSON.stringify({ t: 'ack', id: m.id, ok: this.reply, operationId: m.operationId })));
      }
      if (cb) cb();
    }
    terminate() { this.readyState = 3; this.emit('close'); }
  }
  class ClockDate extends Date { static now() { return now; } }
  const server = new EventEmitter(); server.listen = () => {};
  const context = vm.createContext({
    require(name) {
      if (name === 'express') return express;
      if (name === 'ws') return { WebSocketServer: WSS, WebSocket: { OPEN: 1 } };
      if (name === './database') return Sqlite;
      if (name === 'http') return { createServer: () => server };
      return require(name);
    },
    __dirname: path.resolve(__dirname, '..'), Date: ClockDate,
    process: { env: { DEVICE_TOKEN: 'test-device-token-12345', ADMIN_TOKEN: 'test-admin-token-12345', PAYMENT_SIMULATION: options.simulation ? '1' : '0', DB_FILE: options.dbFile || ':memory:' }, on() {}, exit() { throw Error('Unexpected process.exit'); } },
    console: { log() {}, error() {} },
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true)
  });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.replace('main().catch', 'this.ready = main().catch'), context);
  const api = await context.ready;
  t.after(() => api.db.close());
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const device = new Device(); api.wssDev.emit('connection', device);
  await flush();
  async function state(entry = 'wait', exit = 'wait', slots, exitComplete = true, adminControl = true) {
    device.emit('message', JSON.stringify({ t: 'state', entry, exit, exitComplete, adminControl, slotReset: true, simulatedCheckout: true, ...(slots ? { slots } : {}) }));
    await flush();
  }
  async function request(route, body = {}, ip = '127.0.0.1') {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    const [method, url] = route.split(' ');
    const req = { body, ip, headers: { authorization: 'Bearer test-admin-token-12345' }, query: method === 'GET' ? body : {} };
    await routes.get(method + ' ' + url)(req, response);
    return response;
  }
  async function complete(operationId) { device.emit('message', JSON.stringify({ t: 'exit_complete', operationId })); await flush(); }
  return { ...api, flush, device, advance, state, request, complete };
}

test('simulated payment opens from idle and retains the same operation on retry', async t => {
  const f = await fixture(t, { simulation: true }), code = await park(f);
  await f.state('idle', 'idle');
  assert.equal((await f.request('GET /api/config')).body.paymentSimulation, true);
  assert.equal((await f.request('POST /api/checkout/quote', { code })).statusCode, 200);
  const paid = await f.request('POST /api/checkout/confirm', { code });
  assert.equal(paid.statusCode, 200);
  assert.equal(paid.body.status, 'EXIT_PENDING');
  assert.equal(paid.body.fee, 10000);
  assert.equal(f.device.commands.at(-1).simulate, true);
  assert.equal(f.device.commands.find(m => m.gate === 'entry').simulate, undefined);
  const retried = await f.request('POST /api/checkout/confirm', { code });
  assert.equal(retried.body.operationId, paid.body.operationId);
  assert.equal(retried.body.fee, paid.body.fee);
  await f.complete(paid.body.operationId);
  assert.equal((await f.snapshot()).slots[0], 'free');
  const commandCount = f.device.commands.length;
  const completed = await f.request('POST /api/checkout/confirm', { code });
  assert.equal(completed.body.status, 'COMPLETED');
  assert.equal(f.device.commands.length, commandCount);
});

test('simulated payment requires matching firmware and cannot falsely complete a rejected gate', async t => {
  const f = await fixture(t, { simulation: true }), code = await park(f);
  await f.state('idle', 'idle'); f.dev.simulatedCheckout = false;
  assert.equal((await f.request('POST /api/checkout/quote', { code })).statusCode, 409);
  assert.equal((await f.q.get.get(code)).status, 'PARKED');
  f.dev.simulatedCheckout = true;
  await f.request('POST /api/checkout/quote', { code });
  f.device.reply = false;
  assert.equal((await f.request('POST /api/checkout/confirm', { code })).statusCode, 502);
  assert.equal((await f.q.get.get(code)).status, 'PARKED');
  assert.equal((await f.snapshot()).slots[0], 'busy');
});

test('stale ticket polling does not lock valid gate attempts', async t => {
  const f = await fixture(t); await f.state();
  const reservation = await f.request('POST /api/reserve', { slot: 1, plate: '59A-12345' });
  for (let i = 0; i < 6; ++i) {
    const missing = await f.request('GET /api/ticket', { code: 'OLD234' });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.body.error, 'TICKET_NOT_FOUND');
  }
  assert.equal((await f.request('POST /api/checkin', { code: reservation.body.code })).statusCode, 200);
});

test('ticket synchronization can clear stale cache even while gate attempts are locked', async t => {
  const f = await fixture(t); await f.state();
  for (let i = 0; i < 5; ++i) await f.request('POST /api/checkin', { code: 'OLD234' });
  assert.equal((await f.request('POST /api/checkin', { code: 'OLD234' })).statusCode, 429);
  const missing = await f.request('GET /api/ticket', { code: 'OLD234' });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.error, 'TICKET_NOT_FOUND');
});

test('ticket read rate limit is independent of gate attempt lock', async t => {
  const f = await fixture(t); await f.state();
  for (let i = 0; i < 60; ++i) await f.request('GET /api/ticket', { code: 'OLD234' });
  const limited = await f.request('GET /api/ticket', { code: 'OLD234' });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.body.error, 'TICKET_READ_RATE_LIMIT');
  assert.equal((await f.request('POST /api/checkin', { code: 'OLD234' })).statusCode, 400);
  await f.advance(60000);
  assert.equal((await f.request('GET /api/ticket', { code: 'OLD234' })).statusCode, 400);
});

test('legacy IR slot frames cannot change website slots; gate-only frames work', async t => {
  const f = await fixture(t);
  for (const slots of [[1, 1, 1], [0, 0, 0], [1, 0, 1]]) {
    await f.state('wait', 'idle', slots);
    assert.deepEqual(Array.from((await f.snapshot()).slots), ['free', 'free', 'free']);
  }
  await f.state('open', 'wait');
  assert.equal(f.dev.entry, 'open'); assert.equal(f.dev.exit, 'wait');
});

test('checkout keeps the slot and code until the correlated exit completion', async t => {
  const f = await fixture(t); await f.state();
  const reserved = await f.request('POST /api/reserve', { slot: 1, plate: '59A-12345' });
  assert.equal(reserved.statusCode, 200);
  const code = reserved.body.code;
  assert.equal((await f.snapshot()).slots[0], 'reserved');
  assert.equal((await f.request('POST /api/reserve', { slot: 1, plate: '59B-12345' })).statusCode, 400);
  f.device.reply = false;
  assert.equal((await f.request('POST /api/checkin', { code })).statusCode, 502);
  assert.equal((await f.q.get.get(code)).status, 'RESERVED');
  f.device.reply = true;
  assert.equal((await f.request('POST /api/checkin', { code })).statusCode, 200);
  assert.equal(f.device.commands.at(-1).gate, 'entry');
  assert.equal((await f.q.get.get(code)).status, 'PARKED');
  assert.equal((await f.snapshot()).slots[0], 'busy');
  assert.equal((await f.request('POST /api/reserve', { slot: 1, plate: '59B-12345' })).statusCode, 400);
  assert.equal((await f.request('POST /api/checkin', { code })).statusCode, 400);
  assert.equal((await f.request('POST /api/checkout/confirm', { code })).statusCode, 400);
  await f.state('idle', 'idle');
  const commandsBeforeCheckout = f.device.commands.length;
  assert.equal((await f.request('POST /api/checkout/quote', { code })).statusCode, 400);
  assert.equal(f.device.commands.length, commandsBeforeCheckout);
  await f.state('idle', 'wait');
  assert.equal((await f.request('POST /api/checkout/quote', { code })).statusCode, 200);
  await f.state('idle', 'idle');
  assert.equal((await f.request('POST /api/checkout/confirm', { code })).statusCode, 400);
  assert.equal(f.device.commands.length, commandsBeforeCheckout);
  await f.state('idle', 'wait');
  f.device.reply = false;
  assert.equal((await f.request('POST /api/checkout/confirm', { code })).statusCode, 502);
  assert.equal((await f.q.get.get(code)).status, 'PARKED');
  f.device.reply = true;
  assert.equal((await f.request('POST /api/checkout/confirm', { code })).statusCode, 200);
  assert.equal(f.device.commands.at(-1).gate, 'exit');
  assert.equal((await f.q.get.get(code)).status, 'EXIT_PENDING');
  assert.equal((await f.q.get.get(code)).exit_at, null);
  assert.equal((await f.snapshot()).slots[0], 'busy');
  assert.equal((await f.request('POST /api/cancel', { code })).statusCode, 400);
  assert.equal((await f.request('POST /api/reserve', { slot: 2, plate: '59A-12345' })).statusCode, 400);
  assert.equal((await f.request('POST /api/reserve', { slot: 2, plate: '59A 123.45' })).statusCode, 400);
  assert.equal((await f.request('POST /api/reserve', { slot: 1, plate: '59Z-12345' })).statusCode, 400);
  await f.state('idle', 'idle');
  await f.complete('unrelated-operation');
  assert.equal((await f.q.get.get(code)).status, 'EXIT_PENDING');
  const operation = (await f.q.get.get(code)).exit_operation;
  await f.complete(operation);
  assert.equal((await f.q.get.get(code)).status, 'COMPLETED');
  assert.equal((await f.snapshot()).slots[0], 'free');
  const replay = await f.request('POST /api/checkout/confirm', { code });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.status, 'COMPLETED');
  assert.equal(replay.body.active, false);
  assert.equal(replay.body.replayed, true);
  assert.equal((await f.request('POST /api/checkin', { code })).statusCode, 400);
  const exitAt = (await f.q.get.get(code)).exit_at;
  await f.advance(1000); await f.complete(operation);
  assert.equal((await f.q.get.get(code)).exit_at, exitAt);
  assert.equal(f.device.messages.filter(m => m.t === 'exit_complete_ack').length, 2);
  assert.equal((await f.request('POST /api/reserve', { slot: 1, plate: '59A-12345' })).statusCode, 200);
});

test('missing gate vehicle, wrong/expired codes and missing ACK never commit entry', async t => {
  const f = await fixture(t); await f.state();
  const reserved = await f.request('POST /api/reserve', { slot: 2, plate: '59C-12345' });
  const code = reserved.body.code;
  assert.equal((await f.request('POST /api/checkin', { code: 'XXXXXX' })).statusCode, 400);
  await f.state('idle', 'idle');
  assert.equal((await f.request('POST /api/checkin', { code })).statusCode, 400);
  assert.equal(f.device.commands.length, 0);
  await f.state(); f.device.reply = null;
  const pending = f.request('POST /api/checkin', { code });
  assert.equal((await f.q.get.get(code)).status, 'RESERVED');
  assert.equal((await f.request('POST /api/cancel', { code })).statusCode, 409);
  await f.advance(4001);
  assert.equal((await pending).statusCode, 502);
  assert.equal((await f.q.get.get(code)).status, 'RESERVED');
  f.db.db.prepare('UPDATE tickets SET expires_at = 0 WHERE code = ?').run(code);
  assert.equal((await f.request('POST /api/checkin', { code })).statusCode, 400);
  assert.equal((await f.q.get.get(code)).status, 'EXPIRED');
});

test('cancel/expiry release reservations, and occupied tickets survive offline', async t => {
  const f = await fixture(t); await f.state();
  const first = await f.request('POST /api/reserve', { slot: 1, plate: '59D-12345' });
  await f.request('POST /api/cancel', { code: first.body.code });
  assert.equal((await f.snapshot()).slots[0], 'free');
  const second = await f.request('POST /api/reserve', { slot: 1, plate: '59E-12345' });
  f.db.db.prepare('UPDATE tickets SET expires_at = 0 WHERE code = ?').run(second.body.code);
  await f.advance(5000);
  assert.equal((await f.snapshot()).slots[0], 'free');
  const third = await f.request('POST /api/reserve', { slot: 1, plate: '59F-12345' });
  await f.request('POST /api/checkin', { code: third.body.code });
  f.device.terminate();
  assert.equal((await f.snapshot()).online, false);
  assert.equal((await f.snapshot()).slots[0], 'busy');
  assert.equal((await f.request('POST /api/checkout/quote', { code: third.body.code })).statusCode, 503);
});

test('5-second heartbeat stays online for five simulated minutes; silence times out', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 60; ++i) {
    await f.state('idle', 'idle'); await f.advance(5000);
    assert.equal((await f.snapshot()).online, true);
  }
  await f.advance(20000);
  assert.equal((await f.snapshot()).online, false);
  assert.equal(f.device.readyState, 3);
});

test('a stale device socket cannot update gate states for its replacement', async t => {
  const f = await fixture(t); await f.state();
  const oldDevice = f.device;
  const replacement = new EventEmitter(); replacement.readyState = 1; replacement.send = () => {};
  f.wssDev.emit('connection', replacement); await f.flush();
  oldDevice.emit('message', JSON.stringify({ t: 'state', entry: 'open', exit: 'open' }));
  assert.notEqual(f.dev.entry, 'open');
});

async function park(f, plate = '59X-12345', slot = 1) {
  await f.state();
  const reserved = await f.request('POST /api/reserve', { slot, plate });
  assert.equal(reserved.statusCode, 200);
  const code = reserved.body.code;
  assert.equal((await f.request('POST /api/checkin', { code })).statusCode, 200);
  return code;
}

test('timeout retains durable payment; retry reuses operation and never charges again', async t => {
  const f = await fixture(t), code = await park(f);
  const quote = await f.request('POST /api/checkout/quote', { code });
  f.device.reply = null;
  f.device.onOpen = command => {
    const saved = f.q.get.get(code);
    assert.equal(saved.status, 'EXIT_PENDING');
    assert.equal(saved.exit_operation, command.operationId);
    assert.equal(saved.fee, quote.body.fee);
  };
  const confirmation = f.request('POST /api/checkout/confirm', { code });
  await f.flush();
  const first = (await f.q.get.get(code));
  await f.advance(4001);
  assert.equal((await confirmation).statusCode, 202);
  for (let i = 0; i < 370; ++i) { await f.state(); await f.advance(5000); }
  assert.equal((await f.q.get.get(code)).status, 'EXIT_PENDING'); // beyond reservation/quote expiry
  const retryQuote = await f.request('POST /api/checkout/quote', { code });
  assert.equal(retryQuote.body.fee, first.fee);
  assert.equal(retryQuote.body.parked_sec, first.paid_parked_sec);
  f.device.reply = false;
  assert.equal((await f.request('POST /api/checkout/confirm', { code })).statusCode, 202);
  assert.equal((await f.q.get.get(code)).status, 'EXIT_PENDING'); // retry rejection is ambiguous
  f.device.reply = true; await f.state('idle', 'open');
  assert.equal((await f.request('POST /api/checkout/confirm', { code })).statusCode, 200);
  assert.equal(f.device.commands.at(-1).operationId, first.exit_operation);
  assert.equal((await f.q.get.get(code)).paid_at, first.paid_at);
  await f.complete(first.exit_operation);
  assert.equal((await f.q.get.get(code)).fee, first.fee);
  assert.equal((await f.q.get.get(code)).status, 'COMPLETED');
});

test('disconnect cannot roll back an exit; other tickets cannot steal its gate', async t => {
  const f = await fixture(t), code = await park(f);
  const second = await park(f, '59Y-12345', 2);
  await f.request('POST /api/checkout/quote', { code });
  await f.request('POST /api/checkout/quote', { code: second });
  f.device.reply = null;
  const confirmation = f.request('POST /api/checkout/confirm', { code });
  await f.flush();
  assert.equal((await f.request('POST /api/checkout/confirm', { code: second })).statusCode, 409);
  f.device.terminate();
  assert.equal((await confirmation).statusCode, 202);
  assert.equal((await f.q.get.get(code)).status, 'EXIT_PENDING');
  assert.equal((await f.snapshot()).slots[0], 'busy');
  assert.equal((await f.request('GET /api/ticket', { code })).body.status, 'EXIT_PENDING');
});

test('legacy firmware is rejected, capabilities reset on reconnect', async t => {
  const f = await fixture(t), code = await park(f);
  await f.state('wait', 'wait', undefined, false);
  assert.equal((await f.request('POST /api/checkout/quote', { code })).statusCode, 409);
  await f.state(); await f.request('POST /api/checkout/quote', { code });
  await f.state('wait', 'wait', undefined, false);
  assert.equal((await f.request('POST /api/checkout/confirm', { code })).statusCode, 409);
  assert.equal((await f.q.get.get(code)).status, 'PARKED');
  await f.state();
  const replacement = new EventEmitter(); replacement.readyState = 1; replacement.send = () => {};
  f.wssDev.emit('connection', replacement);
  assert.equal(f.dev.exitComplete, false);
});

test('exit completion arriving before the open ACK cannot be undone', async t => {
  const f = await fixture(t), code = await park(f);
  await f.request('POST /api/checkout/quote', { code });
  f.device.onOpen = m => { f.complete(m.operationId); };
  f.device.reply = false;
  const result = await f.request('POST /api/checkout/confirm', { code });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, 'COMPLETED');
  assert.equal((await f.snapshot()).slots[0], 'free');
});

test('wrong-operation ACK is ignored; stale socket completion cannot finish a ticket', async t => {
  const f = await fixture(t), code = await park(f);
  await f.request('POST /api/checkout/quote', { code });
  f.device.reply = null;
  const confirmation = f.request('POST /api/checkout/confirm', { code });
  await f.flush();
  const command = f.device.commands.at(-1);
  f.device.emit('message', JSON.stringify({ t: 'ack', id: command.id, ok: true, operationId: 'wrong' }));
  await f.advance(4001);
  assert.equal((await confirmation).statusCode, 202);
  const replacement = new EventEmitter(); replacement.readyState = 1; replacement.send = () => {};
  f.wssDev.emit('connection', replacement);
  await f.complete(command.operationId);
  assert.equal((await f.q.get.get(code)).status, 'EXIT_PENDING');
});

test('pending operations survive restart and replay completes once with test storage', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-test-'));
  // Remove only this test-created directory, after all fixture databases close.
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbFile = path.join(directory, 'parking.db');
  const f = await fixture(t, { dbFile, legacy: true }), code = await park(f);
  await f.request('POST /api/checkout/quote', { code });
  await f.request('POST /api/checkout/confirm', { code });
  const saved = (await f.q.get.get(code));
  f.db.close();
  const restarted = await fixture(t, { dbFile }); await restarted.state();
  assert.equal((await restarted.snapshot()).slots[0], 'busy');
  assert.equal((await restarted.request('POST /api/checkout/confirm', { code })).statusCode, 200);
  assert.equal(restarted.device.commands.at(-1).operationId, saved.exit_operation);
  assert.equal((await restarted.q.get.get(code)).fee, saved.fee);
  await restarted.complete(saved.exit_operation);
  restarted.db.close();
  const again = await fixture(t, { dbFile });
  await again.complete(saved.exit_operation);
  assert.equal((await again.q.get.get(code)).status, 'COMPLETED');
  assert.equal((await again.snapshot()).slots[0], 'free');
  assert.equal(again.device.messages.at(-1).t, 'exit_complete_ack');
  again.db.close();
});

test('slot reset preserves other slots and old completion cannot finish a new ticket', async t => {
  const f = await fixture(t), code = await park(f);
  await f.request('POST /api/checkout/quote', { code });
  await f.request('POST /api/checkout/confirm', { code });
  const oldOperation = (await f.q.get.get(code)).exit_operation;
  const other = await f.request('POST /api/reserve', { slot: 2, plate: '59B-12345' });
  await f.state('idle', 'idle');
  const reset = await f.request('POST /api/admin/reset', { requestId: resetId, slot: 1 });
  assert.equal(reset.statusCode, 202);
  assert.equal((await f.q.get.get(code)).status, 'CANCELLED');
  assert.equal((await f.q.get.get(other.body.code)).status, 'RESERVED');
  const frame = f.device.messages.filter(m => m.t === 'parking_state').at(-1);
  assert.equal(frame.resetSlot, 1);
  assert.equal(frame.resetExitOperation, oldOperation);
  await deviceMessage(f, { t: 'admin_reset_ack', requestId: resetId });
  const next = await f.request('POST /api/reserve', { slot: 1, plate: '59X-12345' });
  assert.equal(next.statusCode, 200);
  await f.complete(oldOperation);
  assert.equal((await f.q.get.get(next.body.code)).status, 'RESERVED');
  assert.equal((await f.q.get.get(code)).status, 'CANCELLED');
  const replay = await f.request('POST /api/admin/reset', { requestId: resetId, slot: 1 });
  assert.equal(replay.statusCode, 200);
  assert.equal((await f.q.get.get(next.body.code)).status, 'RESERVED');
  assert.equal((await f.request('POST /api/admin/reset', { requestId: resetId, slot: 2 })).statusCode, 409);
});

test('reset of another slot preserves the pending exit and rejects unsafe firmware', async t => {
  const f = await fixture(t), code = await park(f);
  await f.request('POST /api/checkout/quote', { code });
  await f.request('POST /api/checkout/confirm', { code });
  await f.state('idle', 'idle');
  f.dev.slotReset = false;
  assert.equal((await f.request('POST /api/admin/reset', { requestId: resetId, slot: 2 })).statusCode, 409);
  f.dev.slotReset = true;
  assert.equal((await f.request('POST /api/admin/reset', { requestId: resetId, slot: 2 })).statusCode, 202);
  const frame = f.device.messages.filter(m => m.t === 'parking_state').at(-1);
  assert.equal(frame.resetExitOperation, '');
  assert.equal((await f.q.get.get(code)).status, 'EXIT_PENDING');
  await deviceMessage(f, { t: 'admin_reset_ack', requestId: resetId });
  await f.complete((await f.q.get.get(code)).exit_operation);
  assert.equal((await f.q.get.get(code)).status, 'COMPLETED');
});

test('concurrent reservations cannot assign the same slot or normalized plate twice', async t => {
  const f = await fixture(t); await f.state();
  const sameSlot = await Promise.all([
    f.request('POST /api/reserve', { slot: 1, plate: '59A-12345' }),
    f.request('POST /api/reserve', { slot: 1, plate: '59B-12345' }),
  ]);
  assert.deepEqual(sameSlot.map(r => r.statusCode).sort(), [200, 400]);
  const plate = sameSlot.find(r => r.statusCode === 200).body.plate.replace(/-/g, '.');
  assert.equal((await f.request('POST /api/reserve', { slot: 2, plate })).statusCode, 400);
});

test('reservation expires at 30 seconds and frees both slot and plate', async t => {
  const f = await fixture(t); await f.state();
  const config = await f.request('GET /api/config');
  assert.equal(config.body.holdSec, 30);
  assert.equal(config.body.billingPeriodSec, 60);
  const reservation = await f.request('POST /api/reserve', { slot: 1, plate: '59X-12345' });
  const code = reservation.body.code;
  assert.equal(reservation.body.expiresAt - (await f.q.get.get(code)).created_at, 30000);
  for (let i = 0; i < 2; ++i) { await f.advance(10000); await f.state(); }
  await f.advance(9999); await f.state();
  assert.equal((await f.request('GET /api/ticket', { code })).body.status, 'RESERVED');
  assert.equal((await f.snapshot()).slots[0], 'reserved');
  await f.advance(1);
  assert.equal((await f.q.get.get(code)).status, 'EXPIRED');
  assert.equal((await f.snapshot()).slots[0], 'free');
  assert.equal((await f.request('POST /api/checkin', { code })).statusCode, 400);
  assert.equal((await f.request('POST /api/reserve', { slot: 1, plate: '59X-12345' })).statusCode, 200);
});

test('a parked ticket outlives the hold timeout; 60 seconds is one billing period', async t => {
  const f = await fixture(t), code = await park(f);
  for (let i = 0; i < 6; ++i) { await f.advance(10000); await f.state(); }
  assert.equal((await f.request('GET /api/ticket', { code })).body.status, 'PARKED');
  assert.equal((await f.snapshot()).slots[0], 'busy');
  const first = await f.request('POST /api/checkout/quote', { code });
  assert.equal(first.body.parked_sec, 60);
  assert.equal(first.body.hours, 1);
  assert.equal(first.body.fee, 10000);
  assert.equal(first.body.billingPeriodSec, 60);
  await f.advance(1000);
  const second = await f.request('POST /api/checkout/quote', { code });
  assert.equal(second.body.hours, 2);
  assert.equal(second.body.fee, 20000);
  assert.equal((await f.request('POST /api/cancel', { code })).statusCode, 400);
  await f.request('POST /api/checkout/confirm', { code });
  const operation = (await f.q.get.get(code)).exit_operation;
  for (let i = 0; i < 7; ++i) { await f.advance(10000); await f.state(); }
  assert.equal((await f.q.get.get(code)).status, 'EXIT_PENDING');
  assert.equal((await f.q.get.get(code)).fee, 20000);
  assert.equal((await f.snapshot()).slots[0], 'busy');
  assert.equal((await f.request('POST /api/checkout/quote', { code })).body.fee, 20000);
  await f.complete(operation);
  assert.equal((await f.q.get.get(code)).status, 'COMPLETED');
});

test('check-in started before expiry keeps plate locked while waiting for ACK', async t => {
  const f = await fixture(t); await f.state();
  const { body: { code } } = await f.request('POST /api/reserve', { slot: 1, plate: '59X-12345' });
  for (let i = 0; i < 2; ++i) { await f.advance(10000); await f.state(); }
  await f.advance(9999); await f.state(); f.device.reply = null;
  const checkin = f.request('POST /api/checkin', { code });
  await f.flush();
  await f.advance(1000);
  assert.equal((await f.request('GET /api/ticket', { code })).body.status, 'RESERVED');
  assert.equal((await f.request('POST /api/reserve', { slot: 2, plate: '59X-12345' })).statusCode, 400);
  assert.equal((await f.request('POST /api/cancel', { code })).statusCode, 409);
  const command = f.device.commands.at(-1);
  f.device.emit('message', JSON.stringify({ t: 'ack', id: command.id, ok: true }));
  assert.equal((await checkin).statusCode, 200);
  assert.equal((await f.q.get.get(code)).status, 'PARKED');
  assert.equal((await f.snapshot()).slots[0], 'busy');
});

async function deviceMessage(f, message) { f.device.emit('message', JSON.stringify(message)); await f.flush(); }
const resetId = 'abcdef0123456789abcdef0123456789';

test('Blynk receives authoritative ticket slots, including EXIT_PENDING', async t => {
  const f = await fixture(t), code = await park(f);
  let frame = f.device.messages.filter(m => m.t === 'parking_state').at(-1);
  assert.deepEqual(frame.slots, ['busy', 'free', 'free']);
  await f.request('POST /api/checkout/quote', { code });
  await f.request('POST /api/checkout/confirm', { code });
  await f.state();
  frame = f.device.messages.filter(m => m.t === 'parking_state').at(-1);
  assert.equal(frame.slots[0], 'busy');
  const operation = (await f.q.get.get(code)).exit_operation;
  await f.complete(operation);
  frame = f.device.messages.filter(m => m.t === 'parking_state').at(-1);
  assert.deepEqual(frame.slots, ['free', 'free', 'free']);
});

test('reset cancels all active codes, preserves history and waits for durable device ACK', async t => {
  const f = await fixture(t), code = await park(f);
  const held = await f.request('POST /api/reserve', { slot: 2, plate: '59R-12345' });
  const parked = await park(f, '59S-12345', 3);
  await f.request('POST /api/checkout/quote', { code });
  await f.request('POST /api/checkout/confirm', { code });
  const paid = (await f.q.get.get(code));
  await f.state('idle', 'idle');
  await deviceMessage(f, { t: 'admin_reset', requestId: resetId });
  assert.equal((await f.q.pendingReset.get()).cancelled_count, 3);
  assert.equal((await f.snapshot()).resetting, true);
  for (const c of [code, held.body.code, parked]) {
    assert.equal((await f.q.get.get(c)).status, 'CANCELLED');
    assert.equal((await f.q.get.get(c)).admin_reset_id, resetId);
  }
  assert.equal((await f.q.get.get(code)).fee, paid.fee);
  assert.deepEqual(Array.from((await f.snapshot()).slots), ['free', 'free', 'free']);
  assert.equal((await f.request('POST /api/reserve', { slot: 1, plate: '59T-12345' })).statusCode, 409);
  await deviceMessage(f, { t: 'admin_reset_ack', requestId: 'wrong-reset' });
  assert.equal((await f.snapshot()).resetting, true);
  await f.complete(paid.exit_operation); // replay of a pre-reset event must not resurrect a cancelled ticket
  assert.equal((await f.q.get.get(code)).status, 'CANCELLED');
  await deviceMessage(f, { t: 'admin_reset_ack', requestId: resetId });
  assert.equal((await f.snapshot()).resetting, false);
  const next = await f.request('POST /api/reserve', { slot: 1, plate: '59X-12345' });
  assert.equal(next.statusCode, 200);
  await deviceMessage(f, { t: 'admin_reset', requestId: resetId }); // lost response retry
  assert.equal((await f.q.get.get(next.body.code)).status, 'RESERVED');
  assert.equal((await f.q.latestReset.get()).cancelled_count, 3);
});

test('reset rejects malformed requests, unsupported firmware, active gates and in-flight commands', async t => {
  const f = await fixture(t), code = await park(f);
  await deviceMessage(f, { t: 'admin_reset', requestId: 'invalid' });
  assert.equal((await f.q.latestReset.get()), undefined);
  await f.state('idle', 'idle', undefined, true, false);
  await deviceMessage(f, { t: 'admin_reset', requestId: resetId });
  assert.equal((await f.q.latestReset.get()), undefined);
  await f.state('wait', 'idle');
  await deviceMessage(f, { t: 'admin_reset', requestId: resetId });
  assert.equal((await f.q.latestReset.get()), undefined);
  await f.state(); await f.request('POST /api/checkout/quote', { code });
  f.device.reply = null;
  const checkout = f.request('POST /api/checkout/confirm', { code });
  await f.flush();
  await f.state('idle', 'idle');
  await deviceMessage(f, { t: 'admin_reset', requestId: resetId });
  assert.equal((await f.q.latestReset.get()), undefined);
  assert.equal((await f.q.get.get(code)).status, 'EXIT_PENDING');
  await f.advance(4001); await checkout;
});

test('pending reset survives backend restart and replays its marker on device heartbeat', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-reset-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbFile = path.join(directory, 'parking.db');
  const f = await fixture(t, { dbFile }), code = await park(f);
  await f.state('idle', 'idle'); await deviceMessage(f, { t: 'admin_reset', requestId: resetId });
  f.db.close();
  const restarted = await fixture(t, { dbFile }); await restarted.state('idle', 'idle');
  assert.equal((await restarted.q.get.get(code)).status, 'CANCELLED');
  assert.equal((await restarted.snapshot()).resetting, true);
  assert.equal(restarted.device.messages.filter(m => m.t === 'parking_state').at(-1).resetId, resetId);
  await deviceMessage(restarted, { t: 'admin_reset_ack', requestId: resetId });
  assert.equal((await restarted.snapshot()).resetting, false);
  restarted.db.close();
});

test('a failed reset transaction cannot leave tickets cancelled or a reset half recorded', async t => {
  const f = await fixture(t), code = await park(f);
  await f.state('idle', 'idle');
  const original = f.q.resetCount.run;
  f.q.resetCount.run = () => { throw new Error('Simulated SQLite write failure'); };
  await deviceMessage(f, { t: 'admin_reset', requestId: resetId });
  f.q.resetCount.run = original;
  assert.equal((await f.q.get.get(code)).status, 'PARKED');
  assert.equal((await f.q.latestReset.get()), undefined);
  assert.equal((await f.snapshot()).resetting, false);
  const result = f.device.messages.filter(m => m.t === 'admin_reset_result').at(-1);
  assert.equal(result.ok, false);
});
