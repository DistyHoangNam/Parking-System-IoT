'use strict';
/*
 * Smart Parking - MySQL backend (khớp với index.html có đặt chỗ)
 *
 *   WS   /ws                       trạng thái realtime cho trình duyệt
 *   WS   /device                   ESP32 kết nối vào (Authorization: Bearer <DEVICE_TOKEN>)
 *   GET  /api/config               {rate, holdSec, holdMin}
 *   POST /api/reserve              {slot, plate, phone}  -> mã 6 ký tự, giữ chỗ holdSec giây
 *   POST /api/cancel               {code}
 *   GET  /api/ticket?code=         trạng thái vé (web dùng để đồng bộ)
 *   POST /api/checkin              {code}  -> ra lệnh ESP32 mở cổng vào
 *   POST /api/checkout/quote       {code}  -> hoá đơn (chưa mở cổng)
 *   POST /api/checkout/confirm     {code}  -> "thanh toán", ra lệnh ESP32 mở cổng ra
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const Database = require('./database');

async function main() {

// ---------- Cấu hình (biến môi trường) ----------
const PORT          = Number(process.env.PORT) || 3000;
const TOKEN         = process.env.DEVICE_TOKEN || '';
const FEE_PER_HOUR  = Number(process.env.FEE_PER_HOUR) || 10000;
const SECS_PER_HOUR = Number(process.env.SECS_PER_HOUR) || 60;     // 60 giây = một "giờ" mô phỏng
const HOLD_SECONDS  = Number(process.env.HOLD_SECONDS) || 30;      // giây giữ mã trước check-in
const TRUST_PROXY   = Number(process.env.TRUST_PROXY ?? 1);        // số proxy đứng trước Node
const TOTAL         = 3;
const PAYMENT_SIMULATION = process.env.PAYMENT_SIMULATION !== '0';
const OFFLINE_MS    = 15000;   // quá thời gian này không nhận tin từ ESP32 thì coi là offline
const ACK_TIMEOUT   = 4000;    // chờ ESP32 xác nhận đã nhận lệnh mở cổng
const QUOTE_TTL_MS  = 5 * 60000;
const LOCK_FAILS    = 5;       // nhập sai mã quá số lần này thì khoá IP
const LOCK_MS       = 60000;
const MAX_ACTIVE_PER_IP = 2;   // số vé đang giữ chỗ tối đa cho mỗi IP
const CHARSET       = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // bỏ I, O, 0, 1

if (TOKEN.length < 16) {
  console.error('Thiếu DEVICE_TOKEN (tối thiểu 16 ký tự). Tạo bằng: openssl rand -hex 24');
  process.exit(1);
}

// ---------- Cơ sở dữ liệu ----------
const db = new Database();
await db.init();
const q = {
  get:         db.prepare('SELECT * FROM tickets WHERE code = ?'),
  insert:      db.prepare("INSERT INTO tickets (code,status,slot,plate,phone,ip,created_at,expires_at) VALUES (?, 'RESERVED', ?, ?, ?, ?, ?, ?)"),
  setStatus:   db.prepare("UPDATE tickets SET status = ? WHERE code = ? AND status = 'RESERVED'"),
  cancelTicket: db.prepare("UPDATE tickets SET status = 'CANCELLED', cancelled_at = ? WHERE code = ? AND status = 'RESERVED'"),
  setParked:   db.prepare("UPDATE tickets SET status = 'PARKED', entry_at = ? WHERE code = ? AND status = 'RESERVED'"),
  exitPending: db.prepare("SELECT * FROM tickets WHERE status = 'EXIT_PENDING' LIMIT 1"),
  byOperation: db.prepare('SELECT * FROM tickets WHERE exit_operation = ?'),
  startExit:   db.prepare("UPDATE tickets SET status = 'EXIT_PENDING', paid_at = ?, exit_operation = ?, fee = ?, paid_hours = ?, paid_parked_sec = ?, paid_rate = ?, paid_period_sec = ? WHERE code = ? AND status = 'PARKED'"),
  rejectExit:  db.prepare("UPDATE tickets SET status = 'PARKED', paid_at = NULL, exit_operation = NULL, fee = NULL, paid_hours = NULL, paid_parked_sec = NULL, paid_rate = NULL, paid_period_sec = NULL WHERE code = ? AND status = 'EXIT_PENDING' AND exit_operation = ?"),
  setDone:     db.prepare("UPDATE tickets SET status = 'COMPLETED', exit_at = ? WHERE exit_operation = ? AND status = 'EXIT_PENDING'"),
  expire:      db.prepare("UPDATE tickets SET status = 'EXPIRED' WHERE status = 'RESERVED' AND expires_at <= ? AND code <> ?"),
  heldSlots:   db.prepare("SELECT slot FROM tickets WHERE status = 'RESERVED' AND expires_at > ?"),
  parkedSlots: db.prepare("SELECT slot FROM tickets WHERE status IN ('PARKED','EXIT_PENDING')"),
  slotConflict: db.prepare("SELECT 1 FROM tickets WHERE slot = ? AND code <> ? AND (status IN ('PARKED','EXIT_PENDING') OR (status = 'RESERVED' AND expires_at > ?))"),
  plateActive: db.prepare("SELECT 1 FROM tickets WHERE REPLACE(REPLACE(REPLACE(UPPER(plate), '.', ''), '-', ''), ' ', '') = ? AND status IN ('RESERVED','PARKED','EXIT_PENDING')"),
  ipActive:    db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE ip = ? AND status = 'RESERVED'"),
  purge:       db.prepare("DELETE FROM tickets WHERE status IN ('COMPLETED','EXPIRED','CANCELLED') AND COALESCE(exit_at, cancelled_at, created_at) < ?"),
  resetById:   db.prepare('SELECT * FROM admin_resets WHERE request_id = ?'),
  latestReset: db.prepare('SELECT * FROM admin_resets ORDER BY sequence_id DESC LIMIT 1'),
  pendingReset: db.prepare("SELECT * FROM admin_resets WHERE status = 'PENDING' ORDER BY sequence_id DESC LIMIT 1"),
  insertReset: db.prepare("INSERT INTO admin_resets(request_id, created_at, slot, status) VALUES (?, ?, ?, 'PENDING')"),
  cancelAll:   db.prepare("UPDATE tickets SET status = 'CANCELLED', cancelled_at = ?, admin_reset_id = ? WHERE status IN ('RESERVED', 'PARKED', 'EXIT_PENDING')"),
  cancelSlot: db.prepare("UPDATE tickets SET status = 'CANCELLED', cancelled_at = ?, admin_reset_id = ? WHERE slot = ? AND status IN ('RESERVED','PARKED','EXIT_PENDING')"),
  resetCount:  db.prepare('UPDATE admin_resets SET cancelled_count = ? WHERE request_id = ?'),
  resetDone:   db.prepare("UPDATE admin_resets SET status = 'COMPLETED', completed_at = ? WHERE request_id = ? AND status = 'PENDING'"),
};

// ---------- Trạng thái thiết bị ----------
const dev = { ws: null, lastSeen: 0, entry: 'idle', exit: 'idle', exitComplete: false, adminControl: false, slotReset: false, simulatedCheckout: false };
let resettingAction = false;
let entering = null; // Protect a slot while its entry command is awaiting ACK.
const GATE_STATES = new Set(['idle', 'wait', 'open']);
const online = () =>
  !!dev.ws && dev.ws.readyState === WebSocket.OPEN && Date.now() - dev.lastSeen < OFFLINE_MS;

// Slot occupancy is owned by tickets. Physical IR slot readings are ignored.
async function snapshot() {
  const on = online();
  const held = new Set((await q.heldSlots.all(Date.now())).map(r => r.slot));
  const parked = new Set((await q.parkedSlots.all()).map(r => r.slot));
  if (entering) held.add(entering.slot);
  const slots = Array.from({ length: TOTAL }, (_, i) => parked.has(i + 1) ? 'busy' : held.has(i + 1) ? 'reserved' : 'free');
  return {
    free: slots.filter(s => s === 'free').length,
    total: TOTAL,
    slots,
    entry: on ? dev.entry : 'idle',
    exit:  on ? dev.exit  : 'idle',
    online: on,
    resetting: !!(await q.pendingReset.get()),
  };
}

// ---------- Gửi lệnh mở cổng và chờ ESP32 xác nhận ----------
let cmdId = 0;
const pending = new Map();
function sendOpen(gate, msg1, msg2, operationId) {
  return new Promise(resolve => {
    if (!online()) return resolve(null);
    const id = ++cmdId;
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, ACK_TIMEOUT);
    pending.set(id, { resolve, timer, operationId });
    dev.ws.send(JSON.stringify({ t: 'open', gate, id, msg1, msg2,
      ...(gate === 'exit' && PAYMENT_SIMULATION ? { simulate: true } : {}),
      ...(operationId ? { operationId } : {}) }), err => {
      if (err) { clearTimeout(timer); pending.delete(id); resolve(null); }
    });
  });
}
function onAck(m) {
  const p = pending.get(m.id);
  if (!p || typeof m.ok !== 'boolean' || (p.operationId && m.operationId !== p.operationId)) return;
  clearTimeout(p.timer); pending.delete(m.id); p.resolve(m.ok === true);
}
function failPending() {
  for (const p of pending.values()) { clearTimeout(p.timer); p.resolve(null); }
  pending.clear();
}

const guarded = fn => (...args) => Promise.resolve(fn(...args)).catch(error => {
  console.error('Parking operation failed:', error.code || error.message);
  const res = args[1];
  if (res && typeof res.status === 'function' && !res.headersSent)
    res.status(503).json({ ok: false, error: 'DATABASE_UNAVAILABLE', msg: 'Không xử lý được dữ liệu, hãy thử lại' });
});
// ---------- WebSocket ----------
const app = express();
for (const method of ['get', 'post']) {
  const register = app[method].bind(app);
  app[method] = (route, fn) => fn === undefined ? register(route) : register(route, guarded(async (req, res) => {
    const gate = route === '/api/checkin' ? 'entry' : route === '/api/checkout/confirm' ? 'exit' : null;
    if (!gate) return fn(req, res);
    if (busy[gate] || resettingAction) return fail(res, 409, 'Cổng đang bận hoặc đang reset, hãy thử lại');
    busy[gate] = true;
    try { return await fn(req, res); }
    finally { busy[gate] = false; }
  }));
}
const server = http.createServer(app);
const wssWeb = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const wssDev = new WebSocketServer({ noServer: true, maxPayload: 2048 });
function guardEvents(emitter) {
  const on = emitter.on.bind(emitter);
  emitter.on = (event, fn) => on(event, guarded(fn));
}
guardEvents(wssWeb); guardEvents(wssDev);

let lastJson = '';
async function broadcast(force = false) {
  (await q.expire.run(Date.now(), entering?.code || ''));
  const json = JSON.stringify(await snapshot());
  if (!force && json === lastJson) return;
  lastJson = json;
  for (const c of wssWeb.clients) if (c.readyState === WebSocket.OPEN) c.send(json);
  await sendParkingState();
}

async function sendParkingState() {
  if (!dev.ws || dev.ws.readyState !== WebSocket.OPEN) return;
  const state = await snapshot(), reset = (await q.latestReset.get());
  dev.ws.send(JSON.stringify({ t: 'parking_state', slots: state.slots, free: state.free,
    resetId: reset?.request_id || '', resetSlot: reset?.slot ?? null,
    resetExitOperation: reset?.slot == null ? '' : reset?.exit_operation || '', resetting: state.resetting }));
}

// Only an authenticated /device socket can initiate a Blynk admin reset.
async function adminReset(ws, m) {
  const requestId = m.requestId;
  if (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId)) return;
  if (m.slot != null && (!Number.isInteger(m.slot) || m.slot < 1 || m.slot > TOTAL)) {
    ws.send(JSON.stringify({ t: 'admin_reset_result', requestId, ok: false, msg: 'Slot khong hop le' })); return;
  }
  if (m.slot != null && !dev.slotReset) {
    ws.send(JSON.stringify({ t: 'admin_reset_result', requestId, ok: false, msg: 'Can firmware ho tro reset tung slot' })); return;
  }
  const previous = (await q.resetById.get(requestId));
  if (previous) {
    if (previous.slot !== (m.slot ?? null)) {
      ws.send(JSON.stringify({ t: 'admin_reset_result', requestId, ok: false, msg: 'requestId da dung cho pham vi khac' })); return;
    }
    ws.send(JSON.stringify({ t: 'admin_reset_result', requestId, ok: true, status: previous.status }));
    await sendParkingState(); return;
  }
  if (!dev.adminControl || !online() || busy.entry || busy.exit || pending.size || resettingAction ||
      (await q.pendingReset.get()) || dev.entry !== 'idle' || dev.exit !== 'idle') {
    ws.send(JSON.stringify({ t: 'admin_reset_result', requestId, ok: false, msg: 'Dong cong va don IR, cho luot hien tai ket thuc truoc khi reset' }));
    return;
  }
  // The reset marker and cancellations must commit together, including after a crash.
  
  resettingAction = true;
  try {
    await db.transaction(async () => {
      if (await q.pendingReset.get() || busy.entry || busy.exit) throw new Error('Reset pending or gate busy');
      const exitTicket = await q.exitPending.get();
      await q.insertReset.run(requestId, Date.now(), m.slot ?? null);
      if (exitTicket && (m.slot == null || exitTicket.slot === m.slot))
        await db.prepare('UPDATE admin_resets SET exit_operation = ? WHERE request_id = ?').run(exitTicket.exit_operation, requestId);
      const count = m.slot == null
        ? (await q.cancelAll.run(Date.now(), requestId)).changes
        : (await q.cancelSlot.run(Date.now(), requestId, m.slot)).changes;
      await q.resetCount.run(count, requestId);
    });
  } catch (error) {
    console.error('Admin reset failed');
    ws.send(JSON.stringify({ t: 'admin_reset_result', requestId, ok: false, msg: 'Khong reset duoc database' }));
    return;
  } finally {
    resettingAction = false;
  }
  if (m.slot == null) quotes.clear();
  else for (const code of quotes.keys()) if ((await q.get.get(code))?.slot === m.slot) quotes.delete(code);
  ws.send(JSON.stringify({ t: 'admin_reset_result', requestId, ok: true, status: 'PENDING' }));
  await broadcast(true);
}

function tokenOk(req) {
  const h = String(req.headers['authorization'] || '');
  if (!h.startsWith('Bearer ')) return false;
  const a = crypto.createHash('sha256').update(h.slice(7)).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname === '/ws') {
    wssWeb.handleUpgrade(req, socket, head, ws => wssWeb.emit('connection', ws, req));
  } else if (pathname === '/device') {
    if (!tokenOk(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wssDev.handleUpgrade(req, socket, head, ws => wssDev.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wssWeb.on('connection', async ws => {
  ws.on('error', () => {});
  ws.send(JSON.stringify(await snapshot()));
});

wssDev.on('connection', async ws => {
  guardEvents(ws);
  if (dev.ws && dev.ws !== ws) { try { dev.ws.terminate(); } catch (_) {} failPending(); }
  dev.ws = ws; dev.lastSeen = Date.now(); dev.exitComplete = false; dev.adminControl = false; dev.slotReset = false;
  dev.simulatedCheckout = false;
  console.log(new Date().toISOString(), 'ESP32 connected');

  ws.on('message', async data => {
    if (dev.ws !== ws) return; // Ignore messages from a replaced device socket.
    dev.lastSeen = Date.now();
    let m; try { m = JSON.parse(data.toString()); } catch (_) { return; }
    if (m.t === 'state') {
      if (GATE_STATES.has(m.entry) && GATE_STATES.has(m.exit)) {
        dev.entry = m.entry; dev.exit = m.exit;
        dev.exitComplete = m.exitComplete === true;
        dev.adminControl = m.adminControl === true;
        dev.slotReset = m.slotReset === true;
        dev.simulatedCheckout = m.simulatedCheckout === true;
      }
    } else if (m.t === 'ack') {
      onAck(m);
    } else if (m.t === 'admin_reset') {
      await adminReset(ws, m);
    } else if (m.t === 'admin_reset_ack' && typeof m.requestId === 'string') {
      const reset = (await q.latestReset.get());
      if (reset?.request_id === m.requestId) (await q.resetDone.run(Date.now(), m.requestId));
    } else if (m.t === 'exit_complete' && typeof m.operationId === 'string') {
      const ticket = (await q.byOperation.get(m.operationId));
      if (ticket && ['EXIT_PENDING', 'COMPLETED', 'CANCELLED'].includes(ticket.status)) {
        (await q.setDone.run(Date.now(), m.operationId));
        // Acknowledge only after the durable update, including duplicate events.
        ws.send(JSON.stringify({ t: 'exit_complete_ack', operationId: m.operationId }));
      }
    }
    await broadcast();
    // Periodic device states also replay reset markers when a prior frame was lost.
    if (m.t === 'state') await sendParkingState();
  });
  ws.on('close', async () => {
    if (dev.ws === ws) {
      dev.ws = null; failPending();
      console.log(new Date().toISOString(), 'ESP32 disconnected');
    }
    await broadcast();
  });
  ws.on('error', () => {});
  await broadcast(true);
});

// ---------- Chống lạm dụng ----------
const bad = new Map();        // ip -> {fails, until, last}
const rsvLog = new Map();     // ip -> [timestamps]
const ticketReads = new Map(); // Separate budget for automatic ticket synchronization.
function locked(ip) {
  const b = bad.get(ip);
  if (!b || !b.until) return false;
  if (Date.now() >= b.until) { bad.delete(ip); return false; }
  return true;
}
function noteFail(ip) {
  const now = Date.now();
  let b = bad.get(ip);
  if (!b || now - b.last > 600000) b = { fails: 0, until: 0, last: now };
  b.last = now;
  if (++b.fails >= LOCK_FAILS) b.until = now + LOCK_MS;
  bad.set(ip, b);
}
const noteOk = ip => bad.delete(ip);
function allowReserve(ip) {
  const now = Date.now();
  const list = (rsvLog.get(ip) || []).filter(t => now - t < 60000);
  if (list.length >= 10) { rsvLog.set(ip, list); return false; }
  list.push(now); rsvLog.set(ip, list); return true;
}

// ---------- API ----------
app.set('trust proxy', TRUST_PROXY);   // đứng sau Nginx: lấy IP thật từ X-Forwarded-For
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '2kb' }));
app.use(express.json({ limit: '2kb' }));

const fail = (res, status, msg, error = 'REQUEST_REJECTED') => res.status(status).json({ ok: false, error, msg });
const receipt = t => ({ code: t.code, slot: t.slot, plate: t.plate, status: t.status,
  active: ['RESERVED','PARKED','EXIT_PENDING'].includes(t.status),
  expiresAt: t.expires_at || 0, operationId: t.exit_operation, fee: t.fee,
  paidAt: t.paid_at, exitAt: t.exit_at, paymentStatus: t.paid_at == null ? 'UNCONFIRMED' : 'CONFIRMED',
  hours: t.paid_hours, parked_sec: t.paid_parked_sec, rate: t.paid_rate, billingPeriodSec: t.paid_period_sec });
const MSG_LOCK = 'Nhập sai mã quá nhiều lần. Hãy chờ 1 phút';
const cleanCode = v => {
  const c = String(v || '').trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(c) ? c : '';
};
const makeCode = () => Array.from({ length: 6 }, () => CHARSET[crypto.randomInt(CHARSET.length)]).join('');
const busy = { entry: false, exit: false };
const quotes = new Map();   // code -> {fee, hours, parked, at}

// Tìm vé theo mã, tự xử lý hết hạn giữ chỗ. Trả về {t} hoặc {err:[status,msg]}
async function lookup(req, res, readOnly = false) {
  const ip = req.ip;
  if (!readOnly && locked(ip)) { fail(res, 429, MSG_LOCK); return null; }
  const code = cleanCode((req.body && req.body.code) || req.query.code);
  const t = code && (await q.get.get(code));
  if (!t) {
    // A stale browser cache after expiry/migration is not an incorrect gate attempt.
    if (!readOnly) noteFail(ip);
    fail(res, 400, 'Không tìm thấy mã', 'TICKET_NOT_FOUND'); return null;
  }
  if (t.status === 'RESERVED' && t.expires_at <= Date.now() && entering?.code !== t.code) {
    (await q.setStatus.run('EXPIRED', code)); t.status = 'EXPIRED'; await broadcast();
  }
  return t;
}

app.get('/healthz', (_req, res) => res.json({ ok: true, esp32: online() }));

app.get('/api/config', (_req, res) => res.json({ ok: true, rate: FEE_PER_HOUR, holdSec: HOLD_SECONDS, holdMin: HOLD_SECONDS / 60, billingPeriodSec: SECS_PER_HOUR, paymentSimulation: PAYMENT_SIMULATION }));

app.post('/api/admin/reset', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || '';
  const authorization = String(req.headers.authorization || '');
  const supplied = authorization.slice(7);
  if (!authorization.startsWith('Bearer ') || adminToken.length < 16 || !crypto.timingSafeEqual(
    crypto.createHash('sha256').update(adminToken).digest(), crypto.createHash('sha256').update(supplied).digest()))
    return fail(res, 401, 'Cần token quản trị', 'UNAUTHORIZED');
  const { requestId, slot } = req.body;
  if (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId) ||
      (slot != null && (!Number.isInteger(slot) || slot < 1 || slot > TOTAL)))
    return fail(res, 400, 'requestId phải gồm 32 ký tự hex; slot từ 1 đến 3 hoặc null');
  await adminReset({ send(json) {
    const result = JSON.parse(json);
    res.status(result.ok ? result.status === 'PENDING' ? 202 : 200 : 409).json(result);
  } }, { requestId, slot });
});

app.post('/api/reserve', async (req, res) => {
  const ip = req.ip;
  if (!allowReserve(ip)) return fail(res, 429, 'Thao tác quá nhanh, hãy thử lại sau');
  if (!online()) return fail(res, 503, 'Bộ điều khiển ESP32 đang offline');
  if ((await q.pendingReset.get())) return fail(res, 409, 'Đang đồng bộ reset bãi, hãy chờ');

  const slot = Number(req.body.slot);
  const plate = String(req.body.plate || '').trim().toUpperCase();
  const phone = String(req.body.phone || '').trim();
  if (!Number.isInteger(slot) || slot < 1 || slot > TOTAL) return fail(res, 400, 'Chỗ đỗ không hợp lệ');
  if (!/^[A-Z0-9][A-Z0-9.\- ]{3,11}$/.test(plate)) return fail(res, 400, 'Biển số không hợp lệ');
  if (phone && !/^\+?[0-9 ]{8,13}$/.test(phone)) return fail(res, 400, 'Số điện thoại không hợp lệ');

  const reservation = await db.transaction(async () => {
  if (resettingAction || await q.pendingReset.get()) return fail(res, 409, 'Đang đồng bộ reset bãi, hãy chờ');
  const now = Date.now();
  (await q.expire.run(now, entering?.code || ''));
  if ((await q.slotConflict.get(slot, '', now)) || entering?.slot === slot)
    return fail(res, 400, 'Chỗ này đang được giữ hoặc sử dụng');
  if ((await q.plateActive.get(plate.replace(/[.\- ]/g, '')))) return fail(res, 400, 'Biển số này đã có vé đang dùng');
  if ((await q.ipActive.get(ip)).n >= MAX_ACTIVE_PER_IP) return fail(res, 429, 'Mạng của bạn đã đặt quá số chỗ cho phép');

  let code;
  do { code = makeCode(); } while ((await q.get.get(code)));
  const expiresAt = now + Math.round(HOLD_SECONDS * 1000);
  (await q.insert.run(code, slot, plate, phone || null, ip, now, expiresAt));
  return { ok: true, code, slot, plate, status: 'RESERVED', active: true, expiresAt };
  });
  await broadcast();
  if (reservation?.ok) res.json(reservation);
});

app.post('/api/cancel', async (req, res) => {
  const t = await lookup(req, res); if (!t) return;
  if (busy.entry || entering?.code === t.code) return fail(res, 409, 'Vé đang được xác thực tại cổng vào');
  if (t.status !== 'RESERVED') return fail(res, 400, 'Chỉ huỷ được vé đang giữ chỗ');
  (await q.cancelTicket.run(Date.now(), t.code));
  noteOk(req.ip); await broadcast();
  res.json({ ok: true });
});

app.get('/api/ticket', async (req, res) => {
  const now = Date.now();
  let budget = ticketReads.get(req.ip);
  if (!budget || now - budget.at >= 60000) budget = { at: now, count: 0 };
  ticketReads.set(req.ip, budget);
  if (++budget.count > 60) return fail(res, 429, 'Kiểm tra vé quá nhanh, hãy chờ', 'TICKET_READ_RATE_LIMIT');
  const t = await lookup(req, res, true); if (!t) return;
  res.json({ ok: true, ...receipt(t) });
});

app.post('/api/checkin', async (req, res) => {
  const t = await lookup(req, res); if (!t) return;
  if ((await q.pendingReset.get())) return fail(res, 409, 'Đang đồng bộ reset bãi, hãy chờ');
  if (t.status === 'EXPIRED')   return fail(res, 400, 'Mã đã hết hạn giữ chỗ');
  if (t.status === 'CANCELLED') return fail(res, 400, 'Mã đã bị huỷ');
  if (t.status !== 'RESERVED')  return fail(res, 400, 'Mã này đã được sử dụng');
  if (!online())                return fail(res, 503, 'Bộ điều khiển ESP32 đang offline');
  if (dev.entry !== 'wait')     return fail(res, 400, 'Chưa có xe dừng trước cổng vào');
  if ((await q.slotConflict.get(t.slot, t.code, Date.now())))
    return fail(res, 400, 'Chỗ bạn đặt đang được vé khác sử dụng, hãy liên hệ nhân viên');
  entering = { slot: t.slot, code: t.code };
  try {
    const ok = await sendOpen('entry', 'Valid.', 'Gate Open');
    if (!ok) return fail(res, 502, 'Cổng không phản hồi, hãy thử lại');
    (await q.setParked.run(Date.now(), t.code));
    noteOk(req.ip); await broadcast();
    res.json({ ok: true });
  } finally { entering = null; await broadcast(); }
});

app.post('/api/checkout/quote', async (req, res) => {
  const t = await lookup(req, res); if (!t) return;
  if (!['PARKED', 'EXIT_PENDING'].includes(t.status)) return fail(res, 400, 'Mã này chưa vào bãi hoặc đã trả bãi');
  if (!online())             return fail(res, 503, 'Bộ điều khiển ESP32 đang offline');
  if (PAYMENT_SIMULATION && !dev.simulatedCheckout) return fail(res, 409, 'Cần nạp firmware mới hỗ trợ thanh toán mô phỏng');
  if (!PAYMENT_SIMULATION && dev.exit !== 'wait' && !(t.status === 'EXIT_PENDING' && dev.exit === 'open'))
    return fail(res, 400, 'Chưa có xe dừng trước cổng ra');
  if (!dev.exitComplete) return fail(res, 409, 'Cần cập nhật firmware hỗ trợ xác nhận xe ra');

  if (t.status === 'EXIT_PENDING') return res.json({ ok: true, code: t.code, slot: t.slot,
    plate: t.plate || '', status: t.status, operationId: t.exit_operation, paidAt: t.paid_at,
    parked_sec: t.paid_parked_sec, hours: t.paid_hours, rate: t.paid_rate, fee: t.fee,
    billingPeriodSec: t.paid_period_sec });

  const now = Date.now();
  const parked = Math.max(0, Math.floor((now - t.entry_at) / 1000));
  const hours = Math.max(1, Math.ceil(parked / SECS_PER_HOUR));
  const fee = hours * FEE_PER_HOUR;
  quotes.set(t.code, { fee, hours, parked, at: now });
  res.json({ ok: true, code: t.code, slot: t.slot, plate: t.plate || '', status: t.status, parked_sec: parked, hours, rate: FEE_PER_HOUR, fee, billingPeriodSec: SECS_PER_HOUR });
});

app.post('/api/checkout/confirm', async (req, res) => {
  const t = await lookup(req, res); if (!t) return;
  if (t.status === 'COMPLETED') return res.json({ ok: true, ...receipt(t), gateAcknowledged: false, replayed: true });
  if ((await q.pendingReset.get())) return fail(res, 409, 'Đang đồng bộ reset bãi, hãy chờ');
  if (!['PARKED', 'EXIT_PENDING'].includes(t.status)) return fail(res, 400, 'Mã này chưa vào bãi hoặc đã trả bãi');
  const retry = t.status === 'EXIT_PENDING';
  const quote = quotes.get(t.code);
  if (!retry && (!quote || Date.now() - quote.at > QUOTE_TTL_MS)) return fail(res, 400, 'Hãy xem hoá đơn trước khi thanh toán');
  if (!online())             return fail(res, 503, 'Bộ điều khiển ESP32 đang offline');
  if (!dev.exitComplete) return fail(res, 409, 'Cần cập nhật firmware hỗ trợ xác nhận xe ra');
  if (PAYMENT_SIMULATION && !dev.simulatedCheckout) return fail(res, 409, 'Cần nạp firmware mới hỗ trợ thanh toán mô phỏng');
  if (!PAYMENT_SIMULATION && dev.exit !== 'wait' && !(retry && dev.exit === 'open')) return fail(res, 400, 'Chưa có xe dừng trước cổng ra');
  const outstanding = (await q.exitPending.get());
  if (outstanding && outstanding.code !== t.code) return fail(res, 409, 'Cổng ra còn một lượt chưa hoàn tất, hãy liên hệ nhân viên');

  try {
    const operationId = retry ? t.exit_operation : crypto.randomUUID();
    const fee = retry ? t.fee : quote.fee;
    if (!retry && !(await q.startExit.run(Date.now(), operationId, fee, quote.hours, quote.parked, FEE_PER_HOUR, SECS_PER_HOUR, t.code)).changes)
      return fail(res, 409, 'Vé đã đổi trạng thái, hãy kiểm tra lại');
    await broadcast();
    const ok = await sendOpen('exit', 'Paid', `${fee} VND`.slice(0, 16), operationId);
    // A timeout is ambiguous: the gate may already have opened. Never free the slot.
    // A rejection on a retry cannot undo a previously accepted/uncertain operation.
    if (ok === false && !retry) {
      (await q.rejectExit.run(t.code, operationId));
      if ((await q.get.get(t.code)).status === 'PARKED') return fail(res, 502, 'Cổng từ chối mở, hãy thử lại');
    }
    quotes.delete(t.code);
    noteOk(req.ip); await broadcast();
    const current = (await q.get.get(t.code));
    res.status(ok === true || current.status === 'COMPLETED' ? 200 : 202).json({ ok: true,
      ...receipt(current), replayed: retry,
      gateAcknowledged: ok === true });
  } finally { await broadcast(); }
});

app.use(express.static(path.join(__dirname, 'public')));   // tuỳ chọn: phục vụ index.html từ Node
app.use((_req, res) => res.status(404).type('text').send('Not found'));

// ---------- Tác vụ định kỳ ----------
setInterval(guarded(async () => await broadcast()), 1000); // Release expired reservations within one second.
setInterval(guarded(async () => {                       // phát hiện ESP32 treo (mất mạng không báo)
  if (dev.ws && Date.now() - dev.lastSeen > OFFLINE_MS) {
    console.log(new Date().toISOString(), 'ESP32 timeout');
    dev.ws.terminate();
  }
  await broadcast();                            // đồng thời cập nhật các vé hết hạn giữ chỗ
}), 5000);
setInterval(guarded(async () => {                       // giữ kết nối trình duyệt không bị proxy cắt
  for (const c of wssWeb.clients) if (c.readyState === WebSocket.OPEN) c.ping();
}), 30000);
setInterval(guarded(async () => {                       // dọn dữ liệu
  const now = Date.now();
  (await q.purge.run(now - 30 * 86400000));
  for (const [ip, b] of bad) if (now - b.last > 600000) bad.delete(ip);
  for (const [ip, b] of ticketReads) if (now - b.at >= 60000) ticketReads.delete(ip);
  for (const [c, v] of quotes) if (now - v.at > QUOTE_TTL_MS) quotes.delete(c);
}), 600000);

server.listen(PORT, '127.0.0.1', () => console.log(`Smart Parking backend: http://127.0.0.1:${PORT}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await db.close(); process.exit(0); });

return { db, q, dev, wssDev, snapshot };
}
main().catch(error => { console.error("Startup failed:", error.code || error.message); process.exit(1); });
