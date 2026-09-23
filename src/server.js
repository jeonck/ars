import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { config, smsLive } from './config.js';
import {
  seedIfEmpty,
  listTenants,
  getTenantByKey,
  createTenant,
  updateTenant,
  getLeadByToken,
  getBookingByManageToken,
  listLeads,
  listBookings,
  listMessages,
} from './db.js';
import { availableSlots, upcomingOpenDates } from './slots.js';
import { handleMissedCall, bookSlot, cancelBooking, rescheduleBooking, handleInboundSms } from './core.js';
import { startReminderLoop } from './reminders.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── tiny helpers ────────────────────────────────────────────
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function sendJson(res, status, obj) {
  send(res, status, obj);
}
function notFound(res) {
  sendJson(res, 404, { error: 'not_found' });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return { _raw: raw };
}

function requireAdmin(req) {
  const header = req.headers['x-admin-token'];
  const url = new URL(req.url, 'http://x');
  const token = header || url.searchParams.get('admin_token');
  return token && token === config.adminToken;
}

async function serveStatic(res, name) {
  const safe = normalize(name).replace(/^(\.\.[/\\])+/, '');
  const path = join(PUBLIC_DIR, safe);
  try {
    const data = await readFile(path);
    const ext = path.slice(path.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    notFound(res);
  }
}

// ── routing ─────────────────────────────────────────────────
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp(
    '^' +
      pattern.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
      }) +
      '$',
  );
  routes.push({ method, rx, keys, handler });
}

// Public tenant view (safe subset).
function publicTenant(t) {
  return { key: t.key, name: t.name, services: t.services, slot_minutes: t.slot_minutes };
}

// ── public API ──────────────────────────────────────────────
route('GET', '/healthz', (req, res) => sendJson(res, 200, { ok: true, sms: smsLive ? 'twilio' : 'mock' }));

route('GET', '/api/:key/tenant', (req, res, p) => {
  const t = getTenantByKey(p.key);
  if (!t) return notFound(res);
  sendJson(res, 200, publicTenant(t));
});

route('GET', '/api/:key/open-dates', (req, res, p) => {
  const t = getTenantByKey(p.key);
  if (!t) return notFound(res);
  sendJson(res, 200, { dates: upcomingOpenDates(t) });
});

route('GET', '/api/:key/slots', (req, res, p) => {
  const t = getTenantByKey(p.key);
  if (!t) return notFound(res);
  const date = new URL(req.url, 'http://x').searchParams.get('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return sendJson(res, 400, { error: 'bad_date' });
  sendJson(res, 200, { date, slots: availableSlots(t, date) });
});

route('GET', '/api/:key/lead', (req, res, p) => {
  const t = getTenantByKey(p.key);
  if (!t) return notFound(res);
  const token = new URL(req.url, 'http://x').searchParams.get('t');
  const lead = token ? getLeadByToken(token) : null;
  sendJson(res, 200, { caller: lead && lead.tenant_id === t.id ? lead.caller_number : null });
});

route('POST', '/api/:key/bookings', async (req, res, p) => {
  const t = getTenantByKey(p.key);
  if (!t) return notFound(res);
  const body = await readBody(req);
  const token = body.token || new URL(req.url, 'http://x').searchParams.get('t');
  const lead = token ? getLeadByToken(token) : null;
  try {
    const booking = await bookSlot(t, body, lead && lead.tenant_id === t.id ? lead : null);
    sendJson(res, 201, { ok: true, booking });
  } catch (err) {
    sendJson(res, err.code ? 400 : 500, { error: err.code || 'server_error', message: err.message });
  }
});

// Booking lookup by manage token (for the cancel/reschedule page).
route('GET', '/api/:key/booking', (req, res, p) => {
  const t = getTenantByKey(p.key);
  if (!t) return notFound(res);
  const token = new URL(req.url, 'http://x').searchParams.get('b');
  const b = getBookingByManageToken(token);
  if (!b || b.tenant_id !== t.id) return notFound(res);
  sendJson(res, 200, {
    tenant: publicTenant(t),
    booking: {
      name: b.name, phone: b.phone, service: b.service,
      slot_start: b.slot_start, slot_end: b.slot_end, status: b.status,
    },
  });
});

route('POST', '/api/:key/bookings/cancel', async (req, res, p) => {
  const t = getTenantByKey(p.key);
  if (!t) return notFound(res);
  const body = await readBody(req);
  try {
    const booking = await cancelBooking(t, body.b || body.token);
    sendJson(res, 200, { ok: true, booking });
  } catch (err) {
    sendJson(res, err.code ? 400 : 500, { error: err.code || 'server_error', message: err.message });
  }
});

route('POST', '/api/:key/bookings/reschedule', async (req, res, p) => {
  const t = getTenantByKey(p.key);
  if (!t) return notFound(res);
  const body = await readBody(req);
  try {
    const booking = await rescheduleBooking(t, body.b || body.token, (body.slot_start || '').trim());
    sendJson(res, 200, { ok: true, booking });
  } catch (err) {
    sendJson(res, err.code ? 400 : 500, { error: err.code || 'server_error', message: err.message });
  }
});

// Inbound SMS webhook (Twilio) — handles STOP/START opt-out keywords.
route('POST', '/webhooks/sms/:key', async (req, res, p) => {
  const t = getTenantByKey(p.key);
  const body = await readBody(req);
  const reply = (msg) =>
    send(res, 200,
      `<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${msg.replace(/[<&]/g, (c) => ({ '<': '&lt;', '&': '&amp;' }[c]))}</Message>` : ''}</Response>`,
      { 'Content-Type': 'text/xml; charset=utf-8' });
  if (!t || !body.From) return reply('');
  const result = await handleInboundSms(t, { from: body.From, body: body.Body || '' });
  reply(result.reply);
});

// Demo helper: simulate a missed call without any phone system.
route('POST', '/api/:key/simulate-missed-call', async (req, res, p) => {
  const t = getTenantByKey(p.key);
  if (!t) return notFound(res);
  const body = await readBody(req);
  const caller = (body.caller || '').trim();
  if (!caller) return sendJson(res, 400, { error: 'caller_required' });
  const result = await handleMissedCall(t, { caller, callSid: `SIM-${Date.now()}` });
  if (result.skipped) {
    return sendJson(res, 200, { ok: true, skipped: true, reason: result.reason });
  }
  sendJson(res, 200, {
    ok: true,
    link: result.link,
    sms_status: result.message.status,
    provider: result.message.provider,
    body: result.message.body,
  });
});

// ── Twilio voice status webhook ─────────────────────────────
// Configure this URL as the call-status callback for the business's number.
route('POST', '/webhooks/voice/:key', async (req, res, p) => {
  const t = getTenantByKey(p.key);
  const body = await readBody(req);
  const status = body.DialCallStatus || body.CallStatus;
  const caller = body.From;
  const xml = (msg) =>
    send(res, 200, `<?xml version="1.0" encoding="UTF-8"?><Response>${msg}</Response>`, {
      'Content-Type': 'text/xml; charset=utf-8',
    });

  if (!t) return xml('');
  // Only text back when the call was actually missed.
  const { isMissedCall } = await import('./core.js');
  if (caller && isMissedCall(status)) {
    await handleMissedCall(t, { caller, callSid: body.CallSid });
  }
  xml('');
});

// ── admin API ───────────────────────────────────────────────
route('GET', '/api/admin/tenants', (req, res) => {
  if (!requireAdmin(req)) return sendJson(res, 401, { error: 'unauthorized' });
  sendJson(res, 200, { tenants: listTenants() });
});
route('POST', '/api/admin/tenants', async (req, res) => {
  if (!requireAdmin(req)) return sendJson(res, 401, { error: 'unauthorized' });
  const body = await readBody(req);
  if (!body.name) return sendJson(res, 400, { error: 'name_required' });
  try {
    sendJson(res, 201, { tenant: createTenant(body) });
  } catch (err) {
    sendJson(res, 400, { error: 'create_failed', message: err.message });
  }
});
route('GET', '/api/admin/tenants/:key', (req, res, p) => {
  if (!requireAdmin(req)) return sendJson(res, 401, { error: 'unauthorized' });
  const t = getTenantByKey(p.key);
  return t ? sendJson(res, 200, { tenant: t }) : notFound(res);
});
route('PUT', '/api/admin/tenants/:key', async (req, res, p) => {
  if (!requireAdmin(req)) return sendJson(res, 401, { error: 'unauthorized' });
  const body = await readBody(req);
  const t = updateTenant(p.key, body);
  return t ? sendJson(res, 200, { tenant: t }) : notFound(res);
});
route('GET', '/api/admin/:key/leads', (req, res, p) => {
  if (!requireAdmin(req)) return sendJson(res, 401, { error: 'unauthorized' });
  const t = getTenantByKey(p.key);
  if (!t) return notFound(res);
  sendJson(res, 200, { leads: listLeads(t.id) });
});
route('GET', '/api/admin/:key/bookings', (req, res, p) => {
  if (!requireAdmin(req)) return sendJson(res, 401, { error: 'unauthorized' });
  const t = getTenantByKey(p.key);
  if (!t) return notFound(res);
  sendJson(res, 200, { bookings: listBookings(t.id) });
});
route('GET', '/api/admin/:key/messages', (req, res, p) => {
  if (!requireAdmin(req)) return sendJson(res, 401, { error: 'unauthorized' });
  const t = getTenantByKey(p.key);
  if (!t) return notFound(res);
  sendJson(res, 200, { messages: listMessages(t.id) });
});

// ── pages ───────────────────────────────────────────────────
route('GET', '/', (req, res) => serveStatic(res, 'index.html'));
route('GET', '/dashboard', (req, res) => serveStatic(res, 'dashboard.html'));
route('GET', '/book/:key', (req, res) => serveStatic(res, 'book.html'));
route('GET', '/manage/:key', (req, res) => serveStatic(res, 'manage.html'));

// ── dispatcher ──────────────────────────────────────────────
export const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://x').pathname;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.rx.exec(path);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      await r.handler(req, res, params);
      return;
    }
    // static fallback (css/js assets under /public)
    if (req.method === 'GET' && path.includes('.')) return serveStatic(res, path.replace(/^\//, ''));
    notFound(res);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[server] error:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
  }
});

// Start unless imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedIfEmpty();
  startReminderLoop();
  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`ARS listening on ${config.baseUrl}  (SMS: ${smsLive ? 'Twilio' : 'mock'})`);
    // eslint-disable-next-line no-console
    console.log(`  • Landing:   ${config.baseUrl}/`);
    console.log(`  • Dashboard: ${config.baseUrl}/dashboard`);
    console.log(`  • Demo book: ${config.baseUrl}/book/demo`);
  });
}
