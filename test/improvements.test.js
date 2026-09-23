import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'ars-imp-')), 'test.db');
process.env.BASE_URL = 'http://test.local';

const db = await import('../src/db.js');
const core = await import('../src/core.js');
const slots = await import('../src/slots.js');

const allDay = ['00:00', '24:00'];
function makeTenant(over = {}) {
  return db.createTenant({
    name: '테스트 지붕',
    owner_phone: '+821099998888',
    slot_minutes: 30,
    services: ['누수 점검'],
    business_hours: { mon: allDay, tue: allDay, wed: allDay, thu: allDay, fri: allDay, sat: allDay, sun: allDay },
    ...over,
  });
}
function futureDate(t, i = 1) {
  return slots.upcomingOpenDates(t)[i];
}

// ── ① 취소/변경 ───────────────────────────────────────────
test('booking carries a manage token', async () => {
  const t = makeTenant();
  const slot = `${futureDate(t)} 09:00`;
  const b = await core.bookSlot(t, { name: 'A', phone: '+8210', slot_start: slot });
  assert.ok(b.manage_token && b.manage_token.length >= 16, 'manage_token should be set');
});

test('cancelling a booking frees the slot and notifies owner', async () => {
  const t = makeTenant();
  const date = futureDate(t);
  const slot = `${date} 10:00`;
  const b = await core.bookSlot(t, { name: 'A', phone: '+8210', slot_start: slot });
  assert.ok(!slots.availableSlots(t, date).some((s) => s.start === slot), 'slot taken while confirmed');

  const cancelled = await core.cancelBooking(t, b.manage_token);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(slots.availableSlots(t, date).some((s) => s.start === slot), 'slot freed after cancel');

  const msgs = db.listMessages(t.id);
  assert.ok(msgs.some((m) => m.to_number === t.owner_phone && m.body.includes('취소')), 'owner told of cancel');
});

test('cancel with a bad token is rejected', async () => {
  const t = makeTenant();
  await assert.rejects(() => core.cancelBooking(t, 'nope'), (e) => e.code === 'not_found');
});

test('rescheduling moves the booking and frees the old slot', async () => {
  const t = makeTenant();
  const date = futureDate(t);
  const slot1 = `${date} 11:00`;
  const slot2 = `${date} 15:00`;
  const b = await core.bookSlot(t, { name: 'A', phone: '+8210', slot_start: slot1 });

  const moved = await core.rescheduleBooking(t, b.manage_token, slot2);
  assert.equal(moved.slot_start, slot2);
  assert.equal(moved.id, b.id, 'same booking id kept');
  assert.ok(slots.availableSlots(t, date).some((s) => s.start === slot1), 'old slot freed');
  assert.ok(!slots.availableSlots(t, date).some((s) => s.start === slot2), 'new slot taken');

  const msgs = db.listMessages(t.id);
  assert.ok(msgs.some((m) => m.body.includes('변경')), 'reschedule notification sent');
});

test('rescheduling onto a taken slot is rejected', async () => {
  const t = makeTenant();
  const date = futureDate(t);
  const b1 = await core.bookSlot(t, { name: 'A', phone: '+8210', slot_start: `${date} 12:00` });
  await core.bookSlot(t, { name: 'B', phone: '+8211', slot_start: `${date} 13:00` });
  await assert.rejects(
    () => core.rescheduleBooking(t, b1.manage_token, `${date} 13:00`),
    (e) => e.code === 'slot_unavailable',
  );
});

// ── ② 리마인더 ────────────────────────────────────────────
test('addHoursLocal handles day rollover', () => {
  assert.equal(slots.addHoursLocal('2026-09-25 22:00', 3), '2026-09-26 01:00');
  assert.equal(slots.addHoursLocal('2026-09-25 09:00', 2), '2026-09-25 11:00');
});

test('reminders fire once for bookings inside the window', async () => {
  const t = makeTenant({ reminder_hours: 3 });
  const now = '2026-06-15 09:00';
  const inWindow = '2026-06-15 11:00'; // 2h away, inside 3h window
  const outWindow = '2026-06-15 18:00'; // outside
  db.createBooking({ tenant_id: t.id, name: 'In', phone: '+8210', slot_start: inWindow, slot_end: '2026-06-15 11:30' });
  db.createBooking({ tenant_id: t.id, name: 'Out', phone: '+8211', slot_start: outWindow, slot_end: '2026-06-15 18:30' });

  const sent1 = await core.sendDueReminders(t, now);
  assert.equal(sent1, 1, 'exactly one reminder sent');
  const sent2 = await core.sendDueReminders(t, now);
  assert.equal(sent2, 0, 'no duplicate reminder on second run');

  const msgs = db.listMessages(t.id);
  assert.ok(msgs.some((m) => m.to_number === '+8210' && m.body.includes('리마인더')));
  assert.ok(!msgs.some((m) => m.to_number === '+8211'), 'out-of-window booking not reminded');
});

// ── ③ 중복발송 방지 + 수신거부 ────────────────────────────
test('cooldown prevents a duplicate auto-text to the same caller', async () => {
  const t = makeTenant({ cooldown_minutes: 60 });
  const r1 = await core.handleMissedCall(t, { caller: '+821012345678' });
  assert.ok(!r1.skipped, 'first text sent');
  const r2 = await core.handleMissedCall(t, { caller: '+821012345678' });
  assert.equal(r2.skipped, true);
  assert.equal(r2.reason, 'cooldown');

  const toCaller = db.listMessages(t.id).filter((m) => m.to_number === '+821012345678' && m.status === 'sent');
  assert.equal(toCaller.length, 1, 'only one auto-text to the caller');
});

test('opted-out numbers do not receive auto-texts', async () => {
  const t = makeTenant();
  db.addOptOut(t.id, '+821000001111');
  const r = await core.handleMissedCall(t, { caller: '+821000001111' });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'opt_out');
  assert.ok(db.isOptedOut(t.id, '+821000001111'));
});

test('inbound STOP opts out, START opts back in', async () => {
  const t = makeTenant();
  const stop = await core.handleInboundSms(t, { from: '+821022223333', body: '수신거부' });
  assert.equal(stop.action, 'opt_out');
  assert.ok(db.isOptedOut(t.id, '+821022223333'));

  const start = await core.handleInboundSms(t, { from: '+821022223333', body: 'START' });
  assert.equal(start.action, 'opt_in');
  assert.ok(!db.isOptedOut(t.id, '+821022223333'));
});

test('opt-out blocks booking confirmation but still notifies owner', async () => {
  const t = makeTenant();
  const date = futureDate(t);
  db.addOptOut(t.id, '+821044445555');
  await core.bookSlot(t, { name: 'C', phone: '+821044445555', slot_start: `${date} 16:00` });
  const msgs = db.listMessages(t.id);
  assert.ok(!msgs.some((m) => m.to_number === '+821044445555' && m.status === 'sent'),
    'no confirmation SMS to opted-out customer');
  assert.ok(msgs.some((m) => m.to_number === t.owner_phone && m.body.includes('신규 상담 예약')),
    'owner still notified');
});
