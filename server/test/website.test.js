'use strict';
// Execute the actual page script with a small DOM, fetch and storage harness.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const storedTicket = { code: 'ABC234', slot: 1, plate: '59X-12345', status: 'parked', expiresAt: 1 };
function page(storage = new Map([['parking_ticket', JSON.stringify(storedTicket)]]), initialStatus = 'PARKED', simulation = false) {
  const elements = new Map(), intervals = [], requests = [];
  let now = 1700000000000;
  class ClockDate extends Date { static now() { return now; } }
  let serverTicket = { ...storedTicket, status: initialStatus, expiresAt: 1 };
  let confirmFailure = false, quoteFailure = false;
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', hidden: false,
      disabled: false, style: {}, classList: { toggle() {} }, open: false,
      showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  }
  class Socket { constructor() { Socket.current = this; } }
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [] },
    location: { search: '', host: 'parking.test', protocol: 'https:' },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    WebSocket: Socket, AbortController, URL, Date: ClockDate, console,
    navigator: { clipboard: { async writeText() {} } },
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval(fn, ms) { intervals.push({ fn, ms }); },
    async fetch(url, options) {
      requests.push({ url, body: options.body && JSON.parse(options.body) });
      let data;
      if (url === '/api/config') data = { ok: true, rate: 10000, holdSec: 30, holdMin: 0.5, billingPeriodSec: 60, paymentSimulation: simulation };
      else if (url.startsWith('/api/ticket?')) data = { ok: true, ...serverTicket };
      else if (url === '/api/reserve') {
        const body = JSON.parse(options.body);
        serverTicket = { code: 'NEW567', slot: body.slot, plate: body.plate, status: 'RESERVED', expiresAt: now + 30000 };
        data = { ok: true, ...serverTicket };
      }
      else if (url === '/api/checkout/quote') data = quoteFailure ? { ok: false, msg: 'Chưa có xe dừng trước cổng ra' } :
        { ok: true, ...serverTicket, parked_sec: 60, hours: 1, rate: 10000, fee: 10000, billingPeriodSec: 60 };
      else if (url === '/api/checkout/confirm') {
        serverTicket = { ...serverTicket, status: 'EXIT_PENDING', operationId: 'test-operation', fee: 10000 };
        if (confirmFailure) throw new Error('Response lost after server saved the payment');
        data = { ok: true, ...serverTicket, gateAcknowledged: true };
      } else throw new Error('Unexpected request: ' + url);
      return { ok: data.ok, async json() { return data; } };
    }
  });
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1] + '\nthis.inspect = () => ({ticket, quoteCode, st}); this.synchronize = sync; this.selectSlot = n => { sel = n; };', context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  async function ready() {
    await flush(); Socket.current.onopen();
    Socket.current.onmessage({ data: JSON.stringify({ total: 3, free: 2, slots: ['busy', 'free', 'free'], entry: 'idle', exit: 'wait', online: true }) });
    await flush();
  }
  return { element, storage, requests, ready, flush,
    inspect: context.inspect, sync: context.synchronize, selectSlot: context.selectSlot,
    forgetTicket() { serverTicket = { ok: false, error: 'TICKET_NOT_FOUND' }; },
    setStatus(status) { serverTicket = { ...serverTicket, status }; },
    loseConfirmation() { confirmFailure = true; }, rejectQuote() { quoteFailure = true; },
    setGate(exit) { Socket.current.onmessage({ data: JSON.stringify({ total: 3, free: 2, slots: ['busy', 'free', 'free'], entry: 'idle', exit, online: true }) }); },
    setResetting(resetting) { Socket.current.onmessage({ data: JSON.stringify({ total: 3, free: 3, slots: ['free', 'free', 'free'], entry: 'idle', exit: 'wait', online: true, resetting }) }); },
    poll: async () => { now += 5001; for (const timer of intervals) if (timer.ms === 5000) timer.fn(); await flush(); }
  };
}

test('simulated payment buttons work with an idle exit and do not require IR', async () => {
  const f = page(undefined, 'PARKED', true); await f.ready();
  f.setGate('idle');
  assert.equal(f.element('btnOut').disabled, false);
  await f.element('btnOut').onclick();
  assert.equal(f.element('bill').open, true);
  assert.equal(f.element('bPay').disabled, false);
  await f.element('bPay').onclick();
  assert.equal(f.inspect().ticket.status, 'exit_pending');
  assert.equal(f.requests.filter(r => r.url === '/api/checkout/confirm').length, 1);
  f.setStatus('COMPLETED'); await f.sync();
  assert.equal(f.inspect().ticket, null);
});

test('payment retains code, storage and occupied slot; reload restores pending ticket', async () => {
  const f = page(); await f.ready();
  assert.match(f.element('holdNote').textContent, /30 giây/);
  assert.match(f.element('rateNote').textContent, /60 giây/);
  await f.element('btnOut').onclick();
  assert.match(f.element('bHours').textContent, /chu kỳ 60 giây/);
  assert.equal(f.element('bill').open, true);
  await f.element('bPay').onclick();
  assert.equal(f.inspect().ticket.status, 'exit_pending');
  assert.equal(f.element('codeOut').value, storedTicket.code);
  assert.equal(JSON.parse(f.storage.get('parking_ticket')).status, 'exit_pending');
  assert.equal(f.inspect().st.slots[0], 'busy');
  assert.match(f.element('ticket').innerHTML, /đang chờ xe ra/);
  assert.doesNotMatch(f.element('ticket').innerHTML, /id="cancel"/);
  f.setGate('open');
  assert.equal(f.element('btnOut').disabled, false);
  await f.element('btnOut').onclick();
  assert.match(f.element('bPay').textContent, /không tính thêm phí/);
  await f.element('bPay').onclick();
  const reloaded = page(f.storage, 'EXIT_PENDING'); await reloaded.ready();
  assert.equal(reloaded.inspect().ticket.status, 'exit_pending');
  assert.equal(reloaded.element('codeOut').value, storedTicket.code);
  reloaded.setStatus('COMPLETED'); await reloaded.sync();
  assert.equal(reloaded.inspect().ticket, null);
  assert.equal(reloaded.storage.has('parking_ticket'), false);
  assert.equal(reloaded.element('codeOut').value, '');
});

test('finished session is cleared before reserving again and both gate inputs use the new code', async () => {
  const f = page(); await f.ready();
  await f.element('btnOut').onclick();
  f.setStatus('COMPLETED');
  f.selectSlot(2); f.element('plate').value = '59X-12345';
  await f.element('btnRes').onclick();
  assert.equal(f.inspect().ticket.code, 'NEW567');
  assert.equal(f.inspect().ticket.status, 'reserved');
  assert.equal(f.inspect().quoteCode, '');
  assert.equal(f.element('bill').open, false);
  assert.equal(f.element('codeIn').value, 'NEW567');
  assert.equal(f.element('codeOut').value, 'NEW567');
  const saved = JSON.parse(f.storage.get('parking_ticket'));
  assert.equal(saved.code, 'NEW567');
  assert.equal(Object.hasOwn(saved, 'operationId'), false);
});

test('missing database ticket clears stale browser storage and permits a new reservation', async () => {
  const f = page(); await f.ready();
  f.forgetTicket(); await f.sync();
  assert.equal(f.inspect().ticket, null);
  assert.equal(f.storage.has('parking_ticket'), false);
  f.selectSlot(2); f.element('plate').value = '59X-12345';
  await f.element('btnRes').onclick();
  assert.equal(f.inspect().ticket.code, 'NEW567');
});

test('lost payment response synchronizes pending state instead of deleting the ticket', async () => {
  const f = page(); await f.ready();
  await f.element('btnOut').onclick(); f.loseConfirmation();
  await f.element('bPay').onclick(); await f.flush();
  assert.equal(f.inspect().ticket.status, 'exit_pending');
  assert.equal(f.element('codeOut').value, storedTicket.code);
  assert.equal(f.storage.has('parking_ticket'), true);
});

test('manually entered code restores ticket; failed quote and dismissed bill leave it parked', async () => {
  const f = page(new Map()); await f.ready();
  f.element('codeOut').value = storedTicket.code;
  f.rejectQuote(); await f.element('btnOut').onclick();
  assert.equal(f.inspect().ticket, null);
  assert.equal(f.element('codeOut').value, storedTicket.code);
  const restored = page(new Map()); await restored.ready();
  restored.element('codeOut').value = storedTicket.code;
  await restored.element('btnOut').onclick();
  assert.equal(restored.inspect().ticket.status, 'parked');
  restored.element('bNo').onclick();
  assert.equal(restored.inspect().ticket.status, 'parked');
  assert.equal(restored.storage.has('parking_ticket'), true);
  assert.equal(restored.requests.some(r => r.url === '/api/checkout/confirm'), false);
});

test('periodic polling keeps pending codes and closes stale bills only at completion', async () => {
  const f = page(undefined, 'EXIT_PENDING'); await f.ready();
  await f.element('btnOut').onclick();
  await f.poll();
  assert.equal(f.inspect().ticket.status, 'exit_pending');
  f.setStatus('COMPLETED'); await f.poll();
  assert.equal(f.element('bill').open, false);
  assert.equal(f.inspect().quoteCode, '');
  assert.equal(f.element('bPay').disabled, true);
});

test('admin reset locks actions during synchronization and removes cancelled cached codes', async () => {
  const f = page(undefined, 'EXIT_PENDING'); await f.ready();
  f.setResetting(true);
  assert.equal(f.element('btnIn').disabled, true);
  assert.equal(f.element('btnOut').disabled, true);
  assert.match(f.element('connectionStatus').textContent, /reset bãi/);
  await f.flush();
  f.setStatus('CANCELLED'); await f.poll();
  assert.equal(f.inspect().ticket, null);
  assert.equal(f.storage.has('parking_ticket'), false);
  assert.equal(f.element('codeOut').value, '');
  f.setResetting(false);
  assert.equal(f.element('btnOut').disabled, false);
});
