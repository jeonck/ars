// Pure time helpers (no DB coupling), shared by the server and Actions scripts.

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function pad(n) {
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
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

// Add N hours to a "YYYY-MM-DD HH:MM" wall-clock string (handles day rollover).
export function addHoursLocal(localStr, hours) {
  const [d, t] = localStr.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, da, h + hours, mi));
  return (
    `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ` +
    `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`
  );
}

// End time of a slot starting at slotStart with the given length in minutes.
export function slotEndFor(slotStart, minutes) {
  const [d, hm] = slotStart.split(' ');
  const [h, m] = hm.split(':').map(Number);
  const tot = h * 60 + m + minutes;
  return `${d} ${pad(Math.floor(tot / 60))}:${pad(tot % 60)}`;
}
