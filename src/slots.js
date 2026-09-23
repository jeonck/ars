import { bookedSlotsForDate } from './db.js';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function pad(n) {
  return String(n).padStart(2, '0');
}

// day-of-week key for a "YYYY-MM-DD" string (timezone-independent).
export function dayKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return DAY_KEYS[dow];
}

// Current "YYYY-MM-DD HH:MM" in the given IANA timezone.
export function nowInTz(timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Available slots for a tenant on a given date.
 * Returns [{ start, end, label }] excluding booked and past slots.
 */
export function availableSlots(tenant, dateStr) {
  const hours = tenant.business_hours[dayKey(dateStr)];
  if (!hours) return []; // closed that day

  const [openMin, closeMin] = [toMinutes(hours[0]), toMinutes(hours[1])];
  const step = tenant.slot_minutes;
  const booked = new Set(bookedSlotsForDate(tenant.id, dateStr));
  const nowLocal = nowInTz(tenant.timezone);

  const slots = [];
  for (let m = openMin; m + step <= closeMin; m += step) {
    const startH = pad(Math.floor(m / 60));
    const startM = pad(m % 60);
    const endTot = m + step;
    const endH = pad(Math.floor(endTot / 60));
    const endM = pad(endTot % 60);
    const start = `${dateStr} ${startH}:${startM}`;
    const end = `${dateStr} ${endH}:${endM}`;

    if (booked.has(start)) continue;
    if (start <= nowLocal) continue; // in the past

    slots.push({ start, end, label: `${startH}:${startM}–${endH}:${endM}` });
  }
  return slots;
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
