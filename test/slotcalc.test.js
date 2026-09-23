import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlots } from '../src/slotcalc.js';

test('computeSlots builds slots within business hours', () => {
  const slots = computeSlots({
    hours: ['09:00', '11:00'],
    slotMinutes: 30,
    dateStr: '2099-01-01',
    booked: new Set(),
    nowLocal: '2000-01-01 00:00',
  });
  assert.deepEqual(slots.map((s) => s.start), [
    '2099-01-01 09:00', '2099-01-01 09:30', '2099-01-01 10:00', '2099-01-01 10:30',
  ]);
  assert.equal(slots[0].label, '09:00–09:30');
});

test('computeSlots excludes booked and past slots', () => {
  const slots = computeSlots({
    hours: ['09:00', '11:00'],
    slotMinutes: 30,
    dateStr: '2099-01-01',
    booked: new Set(['2099-01-01 09:30']),
    nowLocal: '2099-01-01 09:15', // 09:00 is past
  });
  assert.deepEqual(slots.map((s) => s.start), ['2099-01-01 10:00', '2099-01-01 10:30']);
});

test('computeSlots returns empty for a closed day (null hours)', () => {
  assert.deepEqual(
    computeSlots({ hours: null, slotMinutes: 30, dateStr: '2099-01-01', booked: new Set(), nowLocal: '2000-01-01 00:00' }),
    [],
  );
});
