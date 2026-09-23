import { config, smsLive } from './config.js';
import { logMessage } from './db.js';

// Render an SMS template. Supported placeholders: {business}, {link}, {caller}.
export function renderTemplate(template, vars) {
  return template.replace(/\{(business|link|caller)\}/g, (_, k) => vars[k] ?? '');
}

async function sendViaTwilio(to, body) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.sid}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: config.twilio.from, Body: body });
  const auth = Buffer.from(`${config.twilio.sid}:${config.twilio.authToken}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Send an SMS. Uses Twilio when configured, otherwise a mock provider that
 * logs to console + DB so the flow is fully demoable offline.
 * Always records the attempt in the messages table.
 */
export async function sendSms({ tenantId, leadId, to, body }) {
  const provider = smsLive ? 'twilio' : 'mock';
  try {
    if (smsLive) {
      await sendViaTwilio(to, body);
    } else {
      // eslint-disable-next-line no-console
      console.log(`\n[mock-sms] → ${to}\n${body}\n`);
    }
    return logMessage({
      tenant_id: tenantId,
      lead_id: leadId,
      to_number: to,
      body,
      provider,
      status: 'sent',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[sms] send failed:', err.message);
    return logMessage({
      tenant_id: tenantId,
      lead_id: leadId,
      to_number: to,
      body,
      provider,
      status: 'failed',
      error: err.message,
    });
  }
}
