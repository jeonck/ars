// Entry point for the `on: issues` workflow. Reads the issue event, decides
// whether it's a booking request or a missed-call lead (from its labels),
// runs the pure planner, then sends SMS + labels/comments the issue.
//
// Local dry-run:
//   DRY_RUN=1 GITHUB_REPOSITORY=owner/repo GITHUB_EVENT_PATH=./event.json \
//     node scripts/issue-ops.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseIssueForm, planBooking, planMissedCall } from './lib/issueops.mjs';
import { sendSms } from './lib/notify.mjs';
import { comment, addLabels } from './lib/gh.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTenants() {
  return JSON.parse(readFileSync(join(__dirname, '..', 'config', 'tenants.json'), 'utf8'));
}

const FOOTER = '\n\n---\n🤖 자동 처리 (ARS · GitHub Actions)';

export async function processIssue(issue, tenants) {
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const fields = parseIssueForm(issue.body || '');
  const tenantKey = fields['업체 키'] || 'demo';
  const tenant = tenants[tenantKey] || tenants.demo;
  if (!tenant) throw new Error(`unknown tenant: ${tenantKey}`);

  const isMissed = labels.includes('type:missed-call') || /^부재중/.test(issue.title || '');

  // Idempotency: our own label writes re-trigger the workflow. Skip if already done.
  if (isMissed && labels.includes('lead:texted')) return { status: 'skip', labels: [] };
  if (!isMissed && labels.includes('booking:confirmed')) return { status: 'skip', labels: [] };

  const plan = isMissed ? planMissedCall(fields, tenant) : planBooking(fields, tenant);

  for (const m of plan.sms) await sendSms(m.to, m.body);
  await addLabels(issue.number, plan.labels);
  await comment(issue.number, plan.comment + FOOTER);
  return plan;
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH not set');
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  if (!event.issue) {
    console.log('[issue-ops] no issue in event; skipping');
    return;
  }
  const plan = await processIssue(event.issue, loadTenants());
  console.log(`[issue-ops] #${event.issue.number} → ${plan.status} (${plan.labels.join(', ')})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
