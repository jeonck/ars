// Pure slot-availability computation, shared by the server (src/slots.js)
// and the Cloudflare Worker. No DB, no I/O.
import { pad } from './time.js';

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * @param {object} p
 * @param {[string,string]|null} p.hours  ["09:00","18:00"] or null (closed)
 * @param {number} p.slotMinutes
 * @param {string} p.dateStr   "YYYY-MM-DD"
 * @param {Set<string>} p.booked  set of taken "YYYY-MM-DD HH:MM"
 * @param {string} p.nowLocal   current "YYYY-MM-DD HH:MM" (tenant tz)
 * @returns {{start:string,end:string,label:string}[]}
 */
export function computeSlots({ hours, slotMinutes, dateStr, booked = new Set(), nowLocal = '' }) {
  if (!hours) return [];
  const openMin = toMinutes(hours[0]);
  const closeMin = toMinutes(hours[1]);
  const out = [];
  for (let m = openMin; m + slotMinutes <= closeMin; m += slotMinutes) {
    const sH = pad(Math.floor(m / 60));
    const sM = pad(m % 60);
    const e = m + slotMinutes;
    const eH = pad(Math.floor(e / 60));
    const eM = pad(e % 60);
    const start = `${dateStr} ${sH}:${sM}`;
    if (booked.has(start)) continue;
    if (nowLocal && start <= nowLocal) continue;
    out.push({ start, end: `${dateStr} ${eH}:${eM}`, label: `${sH}:${sM}–${eH}:${eM}` });
  }
  return out;
}
