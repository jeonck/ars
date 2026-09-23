import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    key           TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    owner_phone   TEXT,
    timezone      TEXT NOT NULL DEFAULT 'Asia/Seoul',
    sms_template  TEXT NOT NULL,
    slot_minutes  INTEGER NOT NULL DEFAULT 30,
    business_hours TEXT NOT NULL,     -- JSON: { mon:["09:00","17:00"], ... } or null day = closed
    services      TEXT NOT NULL DEFAULT '[]', -- JSON array of service names
    reminder_hours   INTEGER NOT NULL DEFAULT 3,  -- send reminder this many hours before the slot
    cooldown_minutes INTEGER NOT NULL DEFAULT 60, -- don't re-text the same caller within this window
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS leads (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    caller_number TEXT NOT NULL,
    call_sid      TEXT,
    status        TEXT NOT NULL DEFAULT 'missed', -- missed | texted | booked
    token         TEXT NOT NULL UNIQUE,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id       INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    to_number     TEXT NOT NULL,
    body          TEXT NOT NULL,
    provider      TEXT NOT NULL,     -- twilio | mock
    status        TEXT NOT NULL,     -- sent | failed
    error         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id       INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    name          TEXT NOT NULL,
    phone         TEXT NOT NULL,
    service       TEXT,
    slot_start    TEXT NOT NULL,     -- "YYYY-MM-DD HH:MM" in tenant local time
    slot_end      TEXT NOT NULL,
    notes         TEXT,
    status        TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | cancelled
    manage_token  TEXT,              -- token for the customer's cancel/reschedule link
    reminded_at   TEXT,              -- set once a reminder SMS has been sent
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS opt_outs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    number        TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (tenant_id, number)
  );

  CREATE INDEX IF NOT EXISTS idx_leads_tenant   ON leads(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_msgs_tenant     ON messages(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_tenant ON bookings(tenant_id);
`);

// ── Migrations for pre-existing databases ───────────────────
// (fresh DBs already get the columns above; this upgrades older files.)
function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
ensureColumn('tenants', 'reminder_hours', 'INTEGER NOT NULL DEFAULT 3');
ensureColumn('tenants', 'cooldown_minutes', 'INTEGER NOT NULL DEFAULT 60');
ensureColumn('bookings', 'manage_token', 'TEXT');
ensureColumn('bookings', 'reminded_at', 'TEXT');

// Older schema used an inline UNIQUE(tenant_id, slot_start, status), which lets
// two *cancelled* rows collide at the same slot. Rebuild without it.
const bookingsSql =
  db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bookings'").get()?.sql || '';
if (/UNIQUE\s*\(tenant_id,\s*slot_start,\s*status\)/i.test(bookingsSql)) {
  db.exec('DROP INDEX IF EXISTS uniq_confirmed_slot;');
  db.exec(`
    CREATE TABLE bookings__new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      name TEXT NOT NULL, phone TEXT NOT NULL, service TEXT,
      slot_start TEXT NOT NULL, slot_end TEXT NOT NULL, notes TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed', manage_token TEXT, reminded_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO bookings__new SELECT id, tenant_id, lead_id, name, phone, service,
      slot_start, slot_end, notes, status, manage_token, reminded_at, created_at FROM bookings;
    DROP TABLE bookings;
    ALTER TABLE bookings__new RENAME TO bookings;
    CREATE INDEX IF NOT EXISTS idx_bookings_tenant ON bookings(tenant_id);
  `);
}

// Uniqueness only among *confirmed* bookings (cancelled rows never collide).
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS uniq_confirmed_slot ON bookings(tenant_id, slot_start) WHERE status='confirmed';",
);

// ── Defaults ────────────────────────────────────────────────
export const DEFAULT_HOURS = {
  mon: ['09:00', '18:00'],
  tue: ['09:00', '18:00'],
  wed: ['09:00', '18:00'],
  thu: ['09:00', '18:00'],
  fri: ['09:00', '18:00'],
  sat: ['10:00', '14:00'],
  sun: null,
};

export const DEFAULT_TEMPLATE =
  '[{business}] 방금 전화를 받지 못해 죄송합니다. 현장 작업 중이라 통화가 어려웠습니다. ' +
  '아래 링크에서 편하신 상담 시간을 직접 예약해 주세요:\n{link}';

// ── Tenant helpers ──────────────────────────────────────────
function rowToTenant(row) {
  if (!row) return null;
  return {
    ...row,
    business_hours: JSON.parse(row.business_hours),
    services: JSON.parse(row.services),
  };
}

export function createTenant(input) {
  const key = input.key || randomUUID().slice(0, 8);
  const stmt = db.prepare(`
    INSERT INTO tenants (key, name, owner_phone, timezone, sms_template, slot_minutes,
      business_hours, services, reminder_hours, cooldown_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    key,
    input.name,
    input.owner_phone || null,
    input.timezone || 'Asia/Seoul',
    input.sms_template || DEFAULT_TEMPLATE,
    input.slot_minutes || 30,
    JSON.stringify(input.business_hours || DEFAULT_HOURS),
    JSON.stringify(input.services || []),
    input.reminder_hours ?? 3,
    input.cooldown_minutes ?? 60,
  );
  return getTenantById(Number(info.lastInsertRowid));
}

export function updateTenant(key, patch) {
  const t = getTenantByKey(key);
  if (!t) return null;
  const next = {
    name: patch.name ?? t.name,
    owner_phone: patch.owner_phone ?? t.owner_phone,
    timezone: patch.timezone ?? t.timezone,
    sms_template: patch.sms_template ?? t.sms_template,
    slot_minutes: patch.slot_minutes ?? t.slot_minutes,
    business_hours: patch.business_hours ?? t.business_hours,
    services: patch.services ?? t.services,
    reminder_hours: patch.reminder_hours ?? t.reminder_hours,
    cooldown_minutes: patch.cooldown_minutes ?? t.cooldown_minutes,
  };
  db.prepare(`
    UPDATE tenants SET name=?, owner_phone=?, timezone=?, sms_template=?,
      slot_minutes=?, business_hours=?, services=?, reminder_hours=?, cooldown_minutes=? WHERE key=?
  `).run(
    next.name,
    next.owner_phone,
    next.timezone,
    next.sms_template,
    next.slot_minutes,
    JSON.stringify(next.business_hours),
    JSON.stringify(next.services),
    next.reminder_hours,
    next.cooldown_minutes,
    key,
  );
  return getTenantByKey(key);
}

export function getTenantByKey(key) {
  return rowToTenant(db.prepare('SELECT * FROM tenants WHERE key=?').get(key));
}
export function getTenantById(id) {
  return rowToTenant(db.prepare('SELECT * FROM tenants WHERE id=?').get(id));
}
export function listTenants() {
  return db.prepare('SELECT * FROM tenants ORDER BY id').all().map(rowToTenant);
}

// ── Lead helpers ────────────────────────────────────────────
export function createLead(tenantId, callerNumber, callSid) {
  const token = randomUUID().replace(/-/g, '');
  const info = db
    .prepare('INSERT INTO leads (tenant_id, caller_number, call_sid, token) VALUES (?, ?, ?, ?)')
    .run(tenantId, callerNumber, callSid || null, token);
  return db.prepare('SELECT * FROM leads WHERE id=?').get(Number(info.lastInsertRowid));
}
export function getLeadByToken(token) {
  return db.prepare('SELECT * FROM leads WHERE token=?').get(token);
}
export function setLeadStatus(id, status) {
  db.prepare('UPDATE leads SET status=? WHERE id=?').run(status, id);
}
export function listLeads(tenantId, limit = 100) {
  return db
    .prepare('SELECT * FROM leads WHERE tenant_id=? ORDER BY id DESC LIMIT ?')
    .all(tenantId, limit);
}

// ── Message helpers ─────────────────────────────────────────
export function logMessage(m) {
  const info = db
    .prepare(`
      INSERT INTO messages (tenant_id, lead_id, to_number, body, provider, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(m.tenant_id, m.lead_id || null, m.to_number, m.body, m.provider, m.status, m.error || null);
  return db.prepare('SELECT * FROM messages WHERE id=?').get(Number(info.lastInsertRowid));
}
export function listMessages(tenantId, limit = 100) {
  return db
    .prepare('SELECT * FROM messages WHERE tenant_id=? ORDER BY id DESC LIMIT ?')
    .all(tenantId, limit);
}

// ── Booking helpers ─────────────────────────────────────────
export function createBooking(b) {
  const manageToken = b.manage_token || randomUUID().replace(/-/g, '');
  const info = db
    .prepare(`
      INSERT INTO bookings (tenant_id, lead_id, name, phone, service, slot_start, slot_end, notes, manage_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      b.tenant_id,
      b.lead_id || null,
      b.name,
      b.phone,
      b.service || null,
      b.slot_start,
      b.slot_end,
      b.notes || null,
      manageToken,
    );
  return db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(info.lastInsertRowid));
}

export function getBookingByManageToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM bookings WHERE manage_token=?').get(token);
}
export function setBookingStatus(id, status) {
  db.prepare('UPDATE bookings SET status=? WHERE id=?').run(status, id);
  return db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
}
export function moveBooking(id, slotStart, slotEnd) {
  // reschedule: change the slot and re-arm the reminder
  db.prepare('UPDATE bookings SET slot_start=?, slot_end=?, reminded_at=NULL WHERE id=?')
    .run(slotStart, slotEnd, id);
  return db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
}
export function markReminded(id) {
  db.prepare("UPDATE bookings SET reminded_at=datetime('now') WHERE id=?").run(id);
}
export function bookingsDueForReminder(tenantId, nowLocal, cutoffLocal) {
  return db
    .prepare(`
      SELECT * FROM bookings
      WHERE tenant_id=? AND status='confirmed' AND reminded_at IS NULL
        AND slot_start > ? AND slot_start <= ?
      ORDER BY slot_start
    `)
    .all(tenantId, nowLocal, cutoffLocal);
}

// ── Opt-out (SMS 수신거부) helpers ──────────────────────────
export function addOptOut(tenantId, number) {
  db.prepare('INSERT OR IGNORE INTO opt_outs (tenant_id, number) VALUES (?, ?)').run(tenantId, number);
}
export function removeOptOut(tenantId, number) {
  db.prepare('DELETE FROM opt_outs WHERE tenant_id=? AND number=?').run(tenantId, number);
}
export function isOptedOut(tenantId, number) {
  return Boolean(db.prepare('SELECT 1 FROM opt_outs WHERE tenant_id=? AND number=?').get(tenantId, number));
}

// ── Rate limiting helper ────────────────────────────────────
export function recentlyTexted(tenantId, number, minutes) {
  const row = db
    .prepare(`
      SELECT 1 FROM messages
      WHERE tenant_id=? AND to_number=? AND status='sent'
        AND created_at >= datetime('now', ?)
      LIMIT 1
    `)
    .get(tenantId, number, `-${Number(minutes)} minutes`);
  return Boolean(row);
}
export function listBookings(tenantId, limit = 200) {
  return db
    .prepare(
      "SELECT * FROM bookings WHERE tenant_id=? AND status='confirmed' ORDER BY slot_start LIMIT ?",
    )
    .all(tenantId, limit);
}
export function bookedSlotsForDate(tenantId, dateStr) {
  return db
    .prepare(
      "SELECT slot_start FROM bookings WHERE tenant_id=? AND status='confirmed' AND slot_start LIKE ?",
    )
    .all(tenantId, `${dateStr}%`)
    .map((r) => r.slot_start);
}

// ── Seed a demo tenant on first run ─────────────────────────
export function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM tenants').get().c;
  if (count > 0) return;
  createTenant({
    key: 'demo',
    name: '든든 지붕 시공',
    owner_phone: '+821000000000',
    timezone: 'Asia/Seoul',
    slot_minutes: 30,
    services: ['지붕 누수 점검', '지붕 교체 견적', '방수 시공 상담'],
  });
  // eslint-disable-next-line no-console
  console.log("[seed] created demo tenant (key='demo')");
}
