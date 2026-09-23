import { listTenants } from './db.js';
import { sendDueReminders } from './core.js';
import { nowInTz } from './slots.js';

/**
 * Periodically scan all tenants and send appointment reminders that are due.
 * Runs in-process; reminders fire while the server is up. Returns the timer.
 */
export function startReminderLoop(intervalMs = 60_000) {
  const tick = async () => {
    for (const t of listTenants()) {
      try {
        await sendDueReminders(t, nowInTz(t.timezone));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[reminder] ${t.key}:`, err.message);
      }
    }
  };
  tick();
  const handle = setInterval(tick, intervalMs);
  handle.unref?.(); // don't keep the process alive just for reminders
  return handle;
}
