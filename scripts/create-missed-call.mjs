// Entry point for the `repository_dispatch: missed_call` workflow.
// An external trigger (a Cloudflare Worker fronting Twilio, or a phone
// automation calling the GitHub API) sends:
//   { event_type: "missed_call", client_payload: { tenant, caller } }
// This turns that into a missed-call issue, which the issue-ops workflow
// then processes (texts the caller a booking link).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createIssue } from './lib/gh.mjs';

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const p = event.client_payload || {};
  const tenant = p.tenant || 'demo';
  const caller = p.caller;
  if (!caller) throw new Error('client_payload.caller is required');

  const body = ['### 업체 키', '', tenant, '', '### 발신 번호', '', caller, ''].join('\n');
  const issue = await createIssue({
    title: `부재중: ${caller}`,
    body,
    labels: ['type:missed-call'],
  });
  console.log(`[missed-call] created issue #${issue.number} for ${caller}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
