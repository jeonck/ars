// ─────────────────────────────────────────────────────────────
// ARS Worker — SINGLE-FILE, paste-ready for the Cloudflare dashboard.
// (No wrangler needed: Workers & Pages → Create → Worker → edit code →
//  paste this whole file → Deploy. Then set Variables: GH_TOKEN, GH_REPO,
//  ALLOW_ORIGIN. See README "대시보드로 배포".)
//
// This is the bundled equivalent of worker/src/index.mjs with its imports
// inlined. Keep it in sync (test/worker-bundle.test.js guards the config).
// ─────────────────────────────────────────────────────────────

const tenants = {
  demo: {
    key: 'demo',
    name: '든든 지붕 시공',
    owner_phone: '+821000000000',
    timezone: 'Asia/Seoul',
    services: ['지붕 누수 점검', '지붕 교체 견적', '방수 시공 상담'],
    sms_template:
      '[{business}] 방금 전화를 받지 못해 죄송합니다. 현장 작업 중이라 통화가 어려웠습니다. 아래 링크에서 편하신 상담 시간을 예약해 주세요:\n{link}',
    reminder_hours: 3,
    slot_minutes: 30,
    business_hours: {
      mon: ['09:00', '18:00'],
      tue: ['09:00', '18:00'],
      wed: ['09:00', '18:00'],
      thu: ['09:00', '18:00'],
      fri: ['09:00', '18:00'],
      sat: ['10:00', '14:00'],
      sun: null,
    },
    pages_base_url: 'https://jeonck.github.io/ars/',
  },
};

// ── time helpers (from src/time.js) ─────────────────────────
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = (n) => String(n).padStart(2, '0');
function dayKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
function nowInTz(timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

// ── slot computation (from src/slotcalc.js) ─────────────────
function computeSlots({ hours, slotMinutes, dateStr, booked = new Set(), nowLocal = '' }) {
  if (!hours) return [];
  const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const openMin = toMin(hours[0]);
  const closeMin = toMin(hours[1]);
  const out = [];
  for (let m = openMin; m + slotMinutes <= closeMin; m += slotMinutes) {
    const sH = pad(Math.floor(m / 60)); const sM = pad(m % 60);
    const e = m + slotMinutes; const eH = pad(Math.floor(e / 60)); const eM = pad(e % 60);
    const start = `${dateStr} ${sH}:${sM}`;
    if (booked.has(start)) continue;
    if (nowLocal && start <= nowLocal) continue;
    out.push({ start, end: `${dateStr} ${eH}:${eM}`, label: `${sH}:${sM}–${eH}:${eM}` });
  }
  return out;
}

// ── issue-form parsing (from scripts/lib/issueops.mjs) ──────
function parseIssueForm(body) {
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

// ── worker (from worker/src/index.mjs) ──────────────────────
const MISSED = new Set(['no-answer', 'busy', 'failed', 'canceled', 'cancelled']);
const SLOT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function json(env, obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) },
  });
}
function twiml(msg = '') {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${msg}</Response>`, {
    status: 200, headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}
async function gh(env, path, method = 'GET', body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'ars-worker',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
function upcomingOpenDates(tenant, days = 14) {
  const today = nowInTz(tenant.timezone).slice(0, 10);
  const [y, m, d] = today.split('-').map(Number);
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    const ds = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
    if (tenant.business_hours[dayKey(ds)]) out.push(ds);
  }
  return out;
}
async function bookedSet(env, tenantKey, dateStr) {
  const issues = await gh(env, `/repos/${env.GH_REPO}/issues?state=open&labels=booking:confirmed&per_page=100`);
  const set = new Set();
  for (const issue of issues || []) {
    const f = parseIssueForm(issue.body || '');
    if ((f['업체 키'] || '') === tenantKey && (f['희망 일시'] || '').startsWith(dateStr)) set.add(f['희망 일시']);
  }
  return set;
}

export async function handleRequest(request, env) {
 try {
  const url = new URL(request.url);
  const { pathname, searchParams } = url;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
  const tenantFor = (key) => tenants[key] || tenants.demo;

  if (request.method === 'GET' && pathname === '/health') {
    const out = { worker: 'ok', gh_repo: env.GH_REPO || null, gh_token: env.GH_TOKEN ? 'set' : 'missing' };
    try { await gh(env, `/repos/${env.GH_REPO}/issues?state=open&per_page=1`); out.github = 'ok'; }
    catch (e) { out.github = 'error'; out.message = String(e.message || e); }
    return json(env, out);
  }

  if (request.method === 'GET' && pathname === '/tenant') {
    const t = tenantFor(searchParams.get('key'));
    if (!t) return json(env, { error: 'not_found' }, 404);
    return json(env, { key: t.key, name: t.name, services: t.services, slot_minutes: t.slot_minutes });
  }
  if (request.method === 'GET' && pathname === '/open-dates') {
    const t = tenantFor(searchParams.get('key'));
    if (!t) return json(env, { error: 'not_found' }, 404);
    return json(env, { dates: upcomingOpenDates(t) });
  }
  if (request.method === 'GET' && pathname === '/slots') {
    const t = tenantFor(searchParams.get('key'));
    const date = searchParams.get('date') || '';
    if (!t) return json(env, { error: 'not_found' }, 404);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(env, { error: 'bad_date' }, 400);
    let booked = new Set();
    try { booked = await bookedSet(env, t.key, date); } catch (e) { console.error('slots bookedSet failed:', e.message); }
    const slots = computeSlots({
      hours: t.business_hours[dayKey(date)], slotMinutes: t.slot_minutes,
      dateStr: date, booked, nowLocal: nowInTz(t.timezone),
    });
    return json(env, { date, slots });
  }
  if (request.method === 'POST' && pathname === '/book') {
    let b; try { b = await request.json(); } catch { b = {}; }
    const t = tenantFor(b.key);
    const name = (b.name || '').trim();
    const phone = (b.phone || '').trim();
    const slot = (b.slot_start || '').trim();
    if (!t) return json(env, { error: 'not_found' }, 404);
    if (!name || !phone || !SLOT_RE.test(slot)) return json(env, { error: 'invalid_input' }, 400);
    const booked = await bookedSet(env, t.key, slot.slice(0, 10));
    if (booked.has(slot)) return json(env, { error: 'slot_unavailable' }, 409);
    const body = [
      '### 업체 키', '', t.key, '', '### 이름', '', name, '', '### 연락처', '', phone, '',
      '### 상담 항목', '', b.service || '_No response_', '', '### 희망 일시', '', slot, '',
      '### 요청사항', '', b.notes || '_No response_', '',
    ].join('\n');
    const issue = await gh(env, `/repos/${env.GH_REPO}/issues`, 'POST', {
      title: `[예약] ${name} · ${slot}`, body, labels: ['type:booking'],
    });
    return json(env, { ok: true, issue_number: issue.number }, 201);
  }

  const voice = pathname.match(/^\/twilio\/voice\/([^/]+)$/);
  if (request.method === 'POST' && voice) {
    const t = tenantFor(decodeURIComponent(voice[1]));
    const form = new URLSearchParams(await request.text());
    const status = form.get('DialCallStatus') || form.get('CallStatus');
    const caller = form.get('From');
    if (t && caller && (!status || MISSED.has(status.toLowerCase()))) {
      await gh(env, `/repos/${env.GH_REPO}/dispatches`, 'POST', {
        event_type: 'missed_call', client_payload: { tenant: t.key, caller },
      });
    }
    return twiml();
  }
  const sms = pathname.match(/^\/twilio\/sms\/([^/]+)$/);
  if (request.method === 'POST' && sms) {
    const t = tenantFor(decodeURIComponent(sms[1]));
    const form = new URLSearchParams(await request.text());
    const from = form.get('From');
    const bodyText = (form.get('Body') || '').trim();
    if (t && from && bodyText) {
      await gh(env, `/repos/${env.GH_REPO}/dispatches`, 'POST', {
        event_type: 'sms_keyword', client_payload: { tenant: t.key, from, body: bodyText },
      });
    }
    return twiml();
  }
  return json(env, { error: 'not_found' }, 404);
 } catch (err) {
  return json(env, { error: 'server_error', message: String(err?.message || err) }, 500);
 }
}

export const __tenants = tenants; // for the sync test
export default { fetch: (request, env) => handleRequest(request, env) };
