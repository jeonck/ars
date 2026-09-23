import { config } from './config.js';
import {
  createLead,
  setLeadStatus,
  createBooking,
  getTenantById,
  getBookingByManageToken,
  setBookingStatus,
  moveBooking,
  markReminded,
  bookingsDueForReminder,
  isOptedOut,
  addOptOut,
  removeOptOut,
  recentlyTexted,
  logMessage,
} from './db.js';
import { renderTemplate, sendSms } from './sms.js';
import { isSlotBookable, slotEndFor, addHoursLocal, nowInTz } from './slots.js';

// A call is "missed" if it was not answered / connected.
const MISSED_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled', 'cancelled']);

// Inbound-SMS keywords (English uppercased; Korean unaffected by toUpperCase).
const STOP_WORDS = new Set([
  'STOP', 'STOPALL', 'UNSUBSCRIBE', 'QUIT', 'END', 'CANCEL',
  '수신거부', '구독취소', '그만', '거부', '중지',
]);
const START_WORDS = new Set(['START', 'UNSTOP', 'YES', '수신동의', '시작', '재개']);

export function isMissedCall(status) {
  return status ? MISSED_STATUSES.has(String(status).toLowerCase()) : true;
}

export function bookingLink(tenant, lead) {
  return `${config.baseUrl}/book/${tenant.key}?t=${lead.token}`;
}
export function manageLink(tenant, booking) {
  return `${config.baseUrl}/manage/${tenant.key}?b=${booking.manage_token}`;
}

// Send to a customer, but honor opt-out. Owner notifications bypass this.
async function notifyCustomer(tenant, leadId, to, body) {
  if (isOptedOut(tenant.id, to)) {
    return logMessage({
      tenant_id: tenant.id, lead_id: leadId, to_number: to, body,
      provider: 'skipped', status: 'skipped', error: 'opted_out',
    });
  }
  return sendSms({ tenantId: tenant.id, leadId, to, body });
}

/**
 * Handle a missed call: create a lead and text the caller a booking link.
 * Skips when the caller opted out or was already texted within the cooldown.
 * Returns { lead, message, link } or { skipped, reason }.
 */
export async function handleMissedCall(tenant, { caller, callSid }) {
  if (isOptedOut(tenant.id, caller)) return { skipped: true, reason: 'opt_out' };
  if (recentlyTexted(tenant.id, caller, tenant.cooldown_minutes)) {
    return { skipped: true, reason: 'cooldown' };
  }

  const lead = createLead(tenant.id, caller, callSid);
  const link = bookingLink(tenant, lead);
  const body = renderTemplate(tenant.sms_template, { business: tenant.name, link, caller });
  const message = await sendSms({ tenantId: tenant.id, leadId: lead.id, to: caller, body });
  if (message.status === 'sent') setLeadStatus(lead.id, 'texted');
  return { lead, message, link };
}

/**
 * Create a booking from the public booking page.
 * Validates the slot, records it, texts a confirmation (with a manage link)
 * to the customer, and notifies the owner. Throws Error with .code on failure.
 */
export async function bookSlot(tenant, input, lead = null) {
  const name = (input.name || '').trim();
  const phone = (input.phone || '').trim();
  const slotStart = (input.slot_start || '').trim();

  if (!name) throw withCode('이름을 입력해 주세요.', 'name_required');
  if (!phone) throw withCode('연락처를 입력해 주세요.', 'phone_required');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(slotStart)) {
    throw withCode('예약 시간 형식이 올바르지 않습니다.', 'bad_slot');
  }
  if (!isSlotBookable(tenant, slotStart)) {
    throw withCode('이미 예약되었거나 선택할 수 없는 시간입니다.', 'slot_unavailable');
  }

  const slotEnd = slotEndFor(slotStart, tenant.slot_minutes);
  let booking;
  try {
    booking = createBooking({
      tenant_id: tenant.id,
      lead_id: lead?.id || null,
      name, phone,
      service: input.service || null,
      slot_start: slotStart,
      slot_end: slotEnd,
      notes: input.notes || null,
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw withCode('방금 다른 분이 해당 시간을 예약했습니다.', 'slot_unavailable');
    }
    throw err;
  }

  if (lead) setLeadStatus(lead.id, 'booked');

  const confirmBody =
    `[${tenant.name}] 상담 예약이 확정되었습니다.\n` +
    `• 일시: ${slotStart}\n` +
    (input.service ? `• 상담: ${input.service}\n` : '') +
    `예약 변경/취소: ${manageLink(tenant, booking)}`;
  await notifyCustomer(tenant, lead?.id || null, phone, confirmBody);

  await notifyOwner(tenant, lead?.id || null, '신규 상담 예약', { name, phone, slotStart, service: input.service });
  return booking;
}

/** Cancel a booking via its manage token. Frees the slot; notifies both sides. */
export async function cancelBooking(tenant, manageToken) {
  const b = getBookingByManageToken(manageToken);
  if (!b || b.tenant_id !== tenant.id) throw withCode('예약을 찾을 수 없습니다.', 'not_found');
  if (b.status === 'cancelled') return b;

  const updated = setBookingStatus(b.id, 'cancelled');
  await notifyCustomer(tenant, b.lead_id, b.phone,
    `[${tenant.name}] 상담 예약(${b.slot_start})이 취소되었습니다.`);
  await notifyOwner(tenant, b.lead_id, '상담 예약 취소', { name: b.name, phone: b.phone, slotStart: b.slot_start, service: b.service });
  return updated;
}

/** Reschedule a booking to a new slot via its manage token. */
export async function rescheduleBooking(tenant, manageToken, newSlot) {
  const b = getBookingByManageToken(manageToken);
  if (!b || b.tenant_id !== tenant.id) throw withCode('예약을 찾을 수 없습니다.', 'not_found');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(newSlot)) {
    throw withCode('예약 시간 형식이 올바르지 않습니다.', 'bad_slot');
  }
  if (!isSlotBookable(tenant, newSlot)) {
    throw withCode('선택할 수 없는 시간입니다.', 'slot_unavailable');
  }

  let updated;
  try {
    updated = moveBooking(b.id, newSlot, slotEndFor(newSlot, tenant.slot_minutes));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw withCode('방금 예약된 시간입니다.', 'slot_unavailable');
    throw err;
  }

  await notifyCustomer(tenant, b.lead_id, b.phone,
    `[${tenant.name}] 상담 예약 시간이 변경되었습니다.\n• 변경 후: ${newSlot}\n예약 변경/취소: ${manageLink(tenant, updated)}`);
  await notifyOwner(tenant, b.lead_id, '상담 예약 시간 변경', { name: b.name, phone: b.phone, slotStart: newSlot, service: b.service });
  return updated;
}

/**
 * Send reminders for confirmed bookings starting within the reminder window.
 * Marks each as reminded so it fires only once. Returns the number sent.
 */
export async function sendDueReminders(tenant, nowLocal = nowInTz(tenant.timezone)) {
  const cutoff = addHoursLocal(nowLocal, tenant.reminder_hours);
  const due = bookingsDueForReminder(tenant.id, nowLocal, cutoff);
  let sent = 0;
  for (const b of due) {
    markReminded(b.id); // mark first so a send failure doesn't loop forever
    if (isOptedOut(tenant.id, b.phone)) continue;
    const body =
      `[${tenant.name}] 상담 예약 리마인더\n` +
      `• 일시: ${b.slot_start}\n` +
      (b.service ? `• 상담: ${b.service}\n` : '') +
      `예약 변경/취소: ${manageLink(tenant, b)}`;
    await sendSms({ tenantId: tenant.id, leadId: b.lead_id, to: b.phone, body });
    sent += 1;
  }
  return sent;
}

/** Handle an inbound SMS (Twilio) for opt-out / opt-in keywords. */
export async function handleInboundSms(tenant, { from, body }) {
  const key = (body || '').trim().toUpperCase();
  if (STOP_WORDS.has(key)) {
    addOptOut(tenant.id, from);
    return { action: 'opt_out', reply: `[${tenant.name}] 문자 수신을 거부하셨습니다. 다시 받으시려면 START 를 보내주세요.` };
  }
  if (START_WORDS.has(key)) {
    removeOptOut(tenant.id, from);
    return { action: 'opt_in', reply: `[${tenant.name}] 문자 수신이 다시 설정되었습니다.` };
  }
  return { action: 'none', reply: null };
}

async function notifyOwner(tenant, leadId, title, { name, phone, slotStart, service }) {
  if (!tenant.owner_phone) return;
  const body =
    `[${title}] ${tenant.name}\n` +
    `• 고객: ${name} (${phone})\n` +
    `• 일시: ${slotStart}` +
    (service ? `\n• 상담: ${service}` : '');
  await sendSms({ tenantId: tenant.id, leadId, to: tenant.owner_phone, body });
}

function withCode(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export { getTenantById };
