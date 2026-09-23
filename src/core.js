import { config } from './config.js';
import {
  createLead,
  setLeadStatus,
  createBooking,
  getTenantById,
} from './db.js';
import { renderTemplate, sendSms } from './sms.js';
import { isSlotBookable } from './slots.js';

// A call is "missed" if it was not answered / connected.
const MISSED_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled', 'cancelled']);

export function isMissedCall(status) {
  return status ? MISSED_STATUSES.has(String(status).toLowerCase()) : true;
}

export function bookingLink(tenant, lead) {
  return `${config.baseUrl}/book/${tenant.key}?t=${lead.token}`;
}

/**
 * Handle a missed call: create a lead and text the caller a booking link.
 * Returns { lead, message, link }.
 */
export async function handleMissedCall(tenant, { caller, callSid }) {
  const lead = createLead(tenant.id, caller, callSid);
  const link = bookingLink(tenant, lead);
  const body = renderTemplate(tenant.sms_template, {
    business: tenant.name,
    link,
    caller,
  });
  const message = await sendSms({ tenantId: tenant.id, leadId: lead.id, to: caller, body });
  if (message.status === 'sent') setLeadStatus(lead.id, 'texted');
  return { lead, message, link };
}

/**
 * Create a booking from the public booking page.
 * Validates the slot, records it, texts a confirmation to the customer,
 * and notifies the business owner. Throws Error with .code on validation failure.
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

  const [d, hm] = slotStart.split(' ');
  const [h, m] = hm.split(':').map(Number);
  const endMin = h * 60 + m + tenant.slot_minutes;
  const slotEnd = `${d} ${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;

  let booking;
  try {
    booking = createBooking({
      tenant_id: tenant.id,
      lead_id: lead?.id || null,
      name,
      phone,
      service: input.service || null,
      slot_start: slotStart,
      slot_end: slotEnd,
      notes: input.notes || null,
    });
  } catch (err) {
    // UNIQUE(tenant_id, slot_start, status) violation = race, slot just taken
    if (String(err.message).includes('UNIQUE')) {
      throw withCode('방금 다른 분이 해당 시간을 예약했습니다.', 'slot_unavailable');
    }
    throw err;
  }

  if (lead) setLeadStatus(lead.id, 'booked');

  // Confirmation to the customer.
  const confirmBody =
    `[${tenant.name}] 상담 예약이 확정되었습니다.\n` +
    `• 일시: ${slotStart}\n` +
    (input.service ? `• 상담: ${input.service}\n` : '') +
    `변경이 필요하시면 이 번호로 회신해 주세요.`;
  await sendSms({ tenantId: tenant.id, leadId: lead?.id || null, to: phone, body: confirmBody });

  // Notify the owner, if configured.
  if (tenant.owner_phone) {
    const ownerBody =
      `[신규 상담 예약] ${tenant.name}\n` +
      `• 고객: ${name} (${phone})\n` +
      `• 일시: ${slotStart}\n` +
      (input.service ? `• 상담: ${input.service}` : '');
    await sendSms({ tenantId: tenant.id, leadId: lead?.id || null, to: tenant.owner_phone, body: ownerBody });
  }

  return booking;
}

function withCode(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export { getTenantById };
