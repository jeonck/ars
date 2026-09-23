// Cloudflare Worker: the only always-on piece of the GitHub-native setup.
// It fronts Twilio (receives missed-call / SMS webhooks) and the static
// booking page (reads slots, creates booking issues) — using a GitHub token
// held as a Worker secret, so no token ever reaches the browser.
//
// Endpoints:
//   GET  /tenant?key=            public tenant info (name, services)
//   GET  /open-dates?key=        upcoming open dates
//   GET  /slots?key=&date=       available slots for a date
//   POST /book                   {key,name,phone,service?,slot_start,notes?} -> creates issue
//   POST /twilio/voice/:key      Twilio call-status callback -> repository_dispatch(missed_call)
//   POST /twilio/sms/:key        Twilio inbound SMS (STOP/START) -> repository_dispatch(sms_keyword)
//
// Secrets (wrangler secret put): GH_TOKEN, GH_REPO ("owner/repo").
// Optional var: ALLOW_ORIGIN (defaults to "*").

import tenants from '../../config/tenants.json' with { type: 'json' };
import { parseIssueForm } from '../../scripts/lib/issueops.mjs';
import { computeSlots } from '../../src/slotcalc.js';
import { dayKey, nowInTz, pad } from '../../src/time.js';

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
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) },
  });
}
function twiml(msg = '') {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${msg}</Response>`, {
    status: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
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
    if ((f['업체 키'] || '') === tenantKey && (f['희망 일시'] || '').startsWith(dateStr)) {
      set.add(f['희망 일시']);
    }
  }
  return set;
}

export async function handleRequest(request, env) {
 try {
  const url = new URL(request.url);
  const { pathname, searchParams } = url;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });

  const tenantFor = (key) => tenants[key] || tenants.demo;

  // Diagnostic: verify GitHub token/repo wiring.
  if (request.method === 'GET' && pathname === '/health') {
    const out = { worker: 'ok', gh_repo: env.GH_REPO || null, gh_token: env.GH_TOKEN ? 'set' : 'missing' };
    try {
      await gh(env, `/repos/${env.GH_REPO}/issues?state=open&per_page=1`);
      out.github = 'ok';
    } catch (e) { out.github = 'error'; out.message = String(e.message || e); }
    return json(env, out);
  }

  // ── public read APIs ───────────────────────────────────
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
    // Don't hang the page if the GitHub list fails — fall back to no bookings.
    let booked = new Set();
    try { booked = await bookedSet(env, t.key, date); } catch (e) { console.error('slots bookedSet failed:', e.message); }
    const slots = computeSlots({
      hours: t.business_hours[dayKey(date)],
      slotMinutes: t.slot_minutes,
      dateStr: date,
      booked,
      nowLocal: nowInTz(t.timezone),
    });
    return json(env, { date, slots });
  }

  // ── booking submission ─────────────────────────────────
  if (request.method === 'POST' && pathname === '/book') {
    let b;
    try { b = await request.json(); } catch { b = {}; }
    const t = tenantFor(b.key);
    const name = (b.name || '').trim();
    const phone = (b.phone || '').trim();
    const slot = (b.slot_start || '').trim();
    if (!t) return json(env, { error: 'not_found' }, 404);
    if (!name || !phone || !SLOT_RE.test(slot)) return json(env, { error: 'invalid_input' }, 400);

    // soft double-booking guard
    const booked = await bookedSet(env, t.key, slot.slice(0, 10));
    if (booked.has(slot)) return json(env, { error: 'slot_unavailable' }, 409);

    const body = [
      '### 업체 키', '', t.key, '',
      '### 이름', '', name, '',
      '### 연락처', '', phone, '',
      '### 상담 항목', '', b.service || '_No response_', '',
      '### 희망 일시', '', slot, '',
      '### 요청사항', '', b.notes || '_No response_', '',
    ].join('\n');
    const issue = await gh(env, `/repos/${env.GH_REPO}/issues`, 'POST', {
      title: `[예약] ${name} · ${slot}`,
      body,
      labels: ['type:booking'],
    });
    return json(env, { ok: true, issue_number: issue.number }, 201);
  }

  // ── Twilio inbound webhooks ────────────────────────────
  const voice = pathname.match(/^\/twilio\/voice\/([^/]+)$/);
  if (request.method === 'POST' && voice) {
    const t = tenantFor(decodeURIComponent(voice[1]));
    const form = new URLSearchParams(await request.text());
    const status = form.get('DialCallStatus') || form.get('CallStatus');
    const caller = form.get('From');
    if (t && caller && (!status || MISSED.has(status.toLowerCase()))) {
      await gh(env, `/repos/${env.GH_REPO}/dispatches`, 'POST', {
        event_type: 'missed_call',
        client_payload: { tenant: t.key, caller },
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
        event_type: 'sms_keyword',
        client_payload: { tenant: t.key, from, body: bodyText },
      });
    }
    return twiml();
  }

  return json(env, { error: 'not_found' }, 404);
 } catch (err) {
  return json(env, { error: 'server_error', message: String(err?.message || err) }, 500);
 }
}

export default {
  fetch: (request, env) => handleRequest(request, env),
};
