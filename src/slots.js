import { bookedSlotsForDate } from './db.js';
import { pad, dayKey, nowInTz, addHoursLocal, slotEndFor } from './time.js';
import { computeSlots } from './slotcalc.js';

// Re-exported so existing importers can keep getting these from ./slots.js.
export { dayKey, nowInTz, addHoursLocal, slotEndFor };

/**
 * Available slots for a tenant on a given date.
 * Returns [{ start, end, label }] excluding booked and past slots.
 */
export function availableSlots(tenant, dateStr) {
  return computeSlots({
    hours: tenant.business_hours[dayKey(dateStr)],
    slotMinutes: tenant.slot_minutes,
    dateStr,
    booked: new Set(bookedSlotsForDate(tenant.id, dateStr)),
    nowLocal: nowInTz(tenant.timezone),
  });
}

// Validate that a proposed slot_start is genuinely bookable right now.
export function isSlotBookable(tenant, slotStart) {
  const dateStr = slotStart.slice(0, 10);
  return availableSlots(tenant, dateStr).some((s) => s.start === slotStart);
}

// Next N days (as "YYYY-MM-DD") from today in tenant tz that have any hours defined.
export function upcomingOpenDates(tenant, days = 14) {
  const today = nowInTz(tenant.timezone).slice(0, 10);
  const [y, m, d] = today.split('-').map(Number);
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    const ds = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
    if (tenant.business_hours[dayKey(ds)]) out.push(ds);
  }
  return out;
}
