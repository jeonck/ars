// SMS sending for the Actions path. Uses Twilio when repo secrets are set,
// otherwise logs (mock) so the workflow is fully demoable without an account.

export async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;

  if (!(sid && token && from)) {
    console.log(`[mock-sms] → ${to}\n${body}\n`);
    return { provider: 'mock', status: 'sent' };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) {
    console.error(`[twilio] ${res.status}: ${await res.text()}`);
    return { provider: 'twilio', status: 'failed' };
  }
  return { provider: 'twilio', status: 'sent' };
}
