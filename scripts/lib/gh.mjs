// Minimal GitHub REST client (fetch-based, zero-dep) for the Actions runtime.
// Reads GITHUB_TOKEN and GITHUB_REPOSITORY from the environment.
// When DRY_RUN is set, mutating calls are printed instead of executed.

const API = 'https://api.github.com';
const DRY = process.env.DRY_RUN === '1';

function repo() {
  const r = process.env.GITHUB_REPOSITORY;
  if (!r) throw new Error('GITHUB_REPOSITORY not set');
  return r;
}

async function gh(path, method = 'GET', body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

export async function comment(issueNumber, body) {
  if (DRY) { console.log(`\n[dry-run comment #${issueNumber}]\n${body}\n`); return; }
  await gh(`/repos/${repo()}/issues/${issueNumber}/comments`, 'POST', { body });
}

export async function addLabels(issueNumber, labels) {
  if (!labels?.length) return;
  if (DRY) { console.log(`[dry-run label #${issueNumber}] + ${labels.join(', ')}`); return; }
  await gh(`/repos/${repo()}/issues/${issueNumber}/labels`, 'POST', { labels });
}

export async function listOpenIssues(label) {
  const q = label ? `&labels=${encodeURIComponent(label)}` : '';
  return gh(`/repos/${repo()}/issues?state=open&per_page=100${q}`);
}

export async function createIssue({ title, body, labels }) {
  if (DRY) { console.log(`\n[dry-run create issue] ${title}\n${body}\nlabels: ${labels?.join(', ')}`); return { number: 0 }; }
  return gh(`/repos/${repo()}/issues`, 'POST', { title, body, labels });
}
