import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated DB per run + deterministic config, set BEFORE importing modules.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'ars-')), 'test.db');
process.env.BASE_URL = 'http://test.local';
process.env.ADMIN_TOKEN = 'test-admin';

const { createTenant, getTenantByKey } = await import('../src/db.js');
const { handleMissedCall, bookSlot, isMissedCall } = await import('../src/core.js');
const { availableSlots, upcomingOpenDates } = await import('../src/slots.js');

function makeTenant() {
  // Open every day, 24h, so slots always exist regardless of test run time.
  const allDay = ['00:00', '24:00'];
  return createTenant({
    name: '테스트 지붕',
    owner_phone: '+821099998888',
    slot_minutes: 30,
    services: ['누수 점검'],
    business_hours: { mon: allDay, tue: allDay, wed: allDay, thu: allDay, fri: allDay, sat: allDay, sun: allDay },
  });
}

test('isMissedCall classifies statuses', () => {
  assert.equal(isMissedCall('no-answer'), true);
  assert.equal(isMissedCall('busy'), true);
  assert.equal(isMissedCall('completed'), false);
  assert.equal(isMissedCall('answered'), false);
  assert.equal(isMissedCall(undefined), true); // no status -> treat as missed
});

test('missed call creates a lead and texts a booking link', async () => {
  const t = makeTenant();
  const { lead, message, link } = await handleMissedCall(t, { caller: '+821012345678', callSid: 'CA1' });
  assert.equal(lead.caller_number, '+821012345678');
  assert.equal(message.status, 'sent');
  assert.equal(message.provider, 'mock');
  assert.match(link, /http:\/\/test\.local\/book\/[^/]+\?t=[a-f0-9]+/);
  assert.ok(message.body.includes(link), 'SMS body should contain the booking link');
  assert.ok(message.body.includes(t.name), 'SMS body should contain the business name');
  // lead should now be marked texted
  const { getLeadByToken } = await import('../src/db.js');
  assert.equal(getLeadByToken(lead.token).status, 'texted');
});

test('slots exclude a booked time and booking updates lead + notifies owner', async () => {
  const t = makeTenant();
  const { lead } = await handleMissedCall(t, { caller: '+821011112222' });
  const dates = upcomingOpenDates(t);
  // pick a slot at least one day out so it is never in the past
  const date = dates[1] || dates[0];
  const before = availableSlots(t, date);
  assert.ok(before.length > 0, 'should have available slots');
  const chosen = before[0].start;

  const booking = await bookSlot(t, { name: '홍길동', phone: '+821011112222', service: '누수 점검', slot_start: chosen }, lead);
  assert.equal(booking.name, '홍길동');
  assert.equal(booking.slot_start, chosen);

  const after = availableSlots(t, date);
  assert.ok(!after.some((s) => s.start === chosen), 'booked slot must disappear');

  const { getLeadByToken, listMessages } = await import('../src/db.js');
  assert.equal(getLeadByToken(lead.token).status, 'booked');

  // customer confirmation + owner notification were logged
  const msgs = listMessages(t.id);
  assert.ok(msgs.some((m) => m.to_number === '+821011112222' && m.body.includes('확정')));
  assert.ok(msgs.some((m) => m.to_number === t.owner_phone && m.body.includes('신규 상담 예약')));
});

test('double-booking the same slot is rejected', async () => {
  const t = makeTenant();
  const date = upcomingOpenDates(t)[1];
  const chosen = availableSlots(t, date)[0].start;
  await bookSlot(t, { name: 'A', phone: '+8210', slot_start: chosen });
  await assert.rejects(
    () => bookSlot(t, { name: 'B', phone: '+8211', slot_start: chosen }),
    (e) => e.code === 'slot_unavailable',
  );
});

test('invalid bookings are rejected with codes', async () => {
  const t = makeTenant();
  const date = upcomingOpenDates(t)[1];
  const chosen = availableSlots(t, date)[0].start;
  await assert.rejects(() => bookSlot(t, { name: '', phone: '1', slot_start: chosen }), (e) => e.code === 'name_required');
  await assert.rejects(() => bookSlot(t, { name: 'X', phone: '', slot_start: chosen }), (e) => e.code === 'phone_required');
  await assert.rejects(() => bookSlot(t, { name: 'X', phone: '1', slot_start: 'nope' }), (e) => e.code === 'bad_slot');
  await assert.rejects(
    () => bookSlot(t, { name: 'X', phone: '1', slot_start: '2020-01-01 09:00' }),
    (e) => e.code === 'slot_unavailable', // in the past
  );
});

test('closed days have no slots', () => {
  const t = createTenant({ name: '평일만', business_hours: { mon: ['09:00','17:00'], sun: null,
    tue:null, wed:null, thu:null, fri:null, sat:null } });
  // find a sunday within the next 2 weeks
  const today = new Date();
  for (let i = 0; i < 14; i += 1) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + i));
    if (d.getUTCDay() === 0) {
      const ds = d.toISOString().slice(0, 10);
      assert.deepEqual(availableSlots(t, ds), []);
      return;
    }
  }
});

test('getTenantByKey round-trips services and hours', () => {
  const t = makeTenant();
  const again = getTenantByKey(t.key);
  assert.deepEqual(again.services, ['누수 점검']);
  assert.equal(again.business_hours.mon[0], '00:00');
});
