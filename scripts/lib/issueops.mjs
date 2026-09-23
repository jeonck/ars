// Pure logic for the GitHub-native ("Issues as backend") processing path.
// No network, no filesystem — everything here is unit-tested. The runtime
// glue (reading the event, calling the GitHub API, sending SMS) lives in
// scripts/issue-ops.mjs and scripts/reminders-gh.mjs.

import { renderTemplate } from '../../src/template.js';
import { addHoursLocal } from '../../src/time.js';

/**
 * Parse a GitHub issue-form body into a { heading: value } map.
 * Issue forms render as:  "### Heading\n\nvalue\n\n### Next\n\n..."
 * Empty optional fields render as "_No response_" (normalized to "").
 */
export function parseIssueForm(body) {
  const fields = {};
  const parts = String(body || '').split(/^###\s+/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    let value = (nl === -1 ? '' : part.slice(nl + 1)).trim();
    if (value === '_No response_') value = '';
    fields[heading] = value;
  }
  return fields;
}

const SLOT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

function smsBlock(sms) {
  return sms.map((m) => `→ ${m.to}\n${m.body}`).join('\n\n');
}

/** Plan the processing of a booking-request issue. */
export function planBooking(fields, tenant) {
  const name = (fields['이름'] || '').trim();
  const phone = (fields['연락처'] || '').trim();
  const slot = (fields['희망 일시'] || '').trim();
  const service = (fields['상담 항목'] || '').trim();

  const missing = [];
  if (!name) missing.push('이름');
  if (!phone) missing.push('연락처');
  if (!slot) missing.push('희망 일시');
  if (missing.length) {
    return {
      status: 'needs_info',
      labels: ['needs-info'],
      sms: [],
      comment: `⚠️ 예약을 확정하려면 다음 항목이 필요합니다: ${missing.join(', ')}\n이슈 본문을 수정하면 자동으로 다시 처리됩니다.`,
    };
  }

  const confirm =
    `[${tenant.name}] 상담 예약이 접수되었습니다.\n` +
    `• 일시: ${slot}\n` +
    (service ? `• 상담: ${service}\n` : '') +
    `담당자가 곧 확인해 드립니다.`;
  const sms = [{ to: phone, body: confirm }];
  if (tenant.owner_phone) {
    sms.push({
      to: tenant.owner_phone,
      body:
        `[신규 상담 예약] ${tenant.name}\n` +
        `• 고객: ${name} (${phone})\n` +
        `• 일시: ${slot}` +
        (service ? `\n• 상담: ${service}` : ''),
    });
  }
  return {
    status: 'ok',
    labels: ['booking:confirmed'],
    sms,
    comment: `✅ 예약 접수: ${name} · ${slot}${service ? ` · ${service}` : ''}\n\n**문자 발송**\n${smsBlock(sms)}`,
  };
}

/** Plan the processing of a missed-call lead issue. */
export function planMissedCall(fields, tenant, opts = {}) {
  const caller = (fields['발신 번호'] || fields['연락처'] || '').trim();
  if (!caller) {
    return { status: 'needs_info', labels: ['needs-info'], sms: [], comment: '⚠️ 발신 번호가 필요합니다.' };
  }
  const base = opts.pagesBaseUrl || tenant.pages_base_url || '';
  const link = `${base}?key=${encodeURIComponent(tenant.key)}`;
  const body = renderTemplate(tenant.sms_template, { business: tenant.name, link, caller });
  const sms = [{ to: caller, body }];
  return {
    status: 'ok',
    labels: ['lead:texted'],
    sms,
    comment: `📞 부재중 리드: ${caller}\n\n**문자 발송**\n${smsBlock(sms)}`,
  };
}

/**
 * Plan a reminder for one confirmed booking.
 * Fires only when the slot is within [now, now + reminder_hours] and the
 * issue is not already labeled "reminded".
 */
export function planReminder(fields, tenant, nowLocal, labels = []) {
  const slot = (fields['희망 일시'] || '').trim();
  const phone = (fields['연락처'] || '').trim();
  if (!SLOT_RE.test(slot) || !phone) return { status: 'skip', reason: 'no_slot_or_phone' };
  if (labels.includes('reminded')) return { status: 'skip', reason: 'already_reminded' };

  const cutoff = addHoursLocal(nowLocal, tenant.reminder_hours);
  if (!(slot > nowLocal && slot <= cutoff)) return { status: 'skip', reason: 'out_of_window' };

  const service = (fields['상담 항목'] || '').trim();
  const body =
    `[${tenant.name}] 상담 예약 리마인더\n` +
    `• 일시: ${slot}\n` +
    (service ? `• 상담: ${service}\n` : '') +
    `변경이 필요하시면 회신해 주세요.`;
  return {
    status: 'ok',
    labels: ['reminded'],
    sms: [{ to: phone, body }],
    comment: `⏰ 리마인더 발송 (${slot})\n\n→ ${phone}\n${body}`,
  };
}
