// Entry point for the scheduled (`on: schedule`) reminder workflow.
// Scans open confirmed-booking issues and sends a reminder for each whose
// appointment is within the reminder window, labeling it "reminded" so it
// fires only once.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseIssueForm, planReminder } from './lib/issueops.mjs';
import { sendSms } from './lib/notify.mjs';
import { comment, addLabels, listOpenIssues } from './lib/gh.mjs';
import { nowInTz } from '../src/time.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FOOTER = '\n\n---\n🤖 자동 처리 (ARS · GitHub Actions)';

function loadTenants() {
  return JSON.parse(readFileSync(join(__dirname, '..', 'config', 'tenants.json'), 'utf8'));
}

async function main() {
  const tenants = loadTenants();
  const issues = await listOpenIssues('booking:confirmed');
  let sent = 0;
  for (const issue of issues) {
    const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
    const fields = parseIssueForm(issue.body || '');
    const tenant = tenants[fields['업체 키'] || 'demo'] || tenants.demo;
    if (!tenant) continue;
    const plan = planReminder(fields, tenant, nowInTz(tenant.timezone), labels);
    if (plan.status !== 'ok') continue;
    for (const m of plan.sms) await sendSms(m.to, m.body);
    await addLabels(issue.number, plan.labels);
    await comment(issue.number, plan.comment + FOOTER);
    sent += 1;
  }
  console.log(`[reminders] processed ${issues.length} open booking(s), sent ${sent} reminder(s)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
