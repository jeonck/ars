import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../worker/src/index.mjs';

const env = { GH_TOKEN: 'x', GH_REPO: 'jeonck/ars', ALLOW_ORIGIN: '*' };

// Install a fake GitHub API; returns per-route canned data and records calls.
function fakeGitHub(calls, { issues = [] } = {}) {
  return async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const u = String(url);
    if (u.includes('/issues?')) return new Response(JSON.stringify(issues), { status: 200 });
    if (u.endsWith('/issues')) return new Response(JSON.stringify({ number: 42 }), { status: 201 });
    if (u.endsWith('/dispatches')) return new Response(null, { status: 204 });
    return new Response('{}', { status: 200 });
  };
}

function withFetch(fn, ...args) {
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  return { restore: () => { globalThis.fetch = orig; } };
}

test('GET /tenant returns public tenant info', async () => {
  const g = withFetch(async () => new Response('{}'));
  try {
    const res = await handleRequest(new Request('https://w/tenant?key=demo'), env);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.name, '든든 지붕 시공');
    assert.ok(Array.isArray(body.services));
    assert.equal(body.owner_phone, undefined, 'must not leak owner phone');
  } finally { g.restore(); }
});

test('GET /slots excludes an already-booked time', async () => {
  const calls = [];
  const issues = [{ number: 5, labels: [{ name: 'booking:confirmed' }],
    body: '### 업체 키\n\ndemo\n\n### 희망 일시\n\n2099-01-05 09:30\n' }];
  const g = withFetch(fakeGitHub(calls, { issues }));
  try {
    const res = await handleRequest(new Request('https://w/slots?key=demo&date=2099-01-05'), env);
    const body = await res.json();
    const starts = body.slots.map((s) => s.start);
    assert.ok(starts.includes('2099-01-05 09:00'));
    assert.ok(!starts.includes('2099-01-05 09:30'), 'booked slot excluded');
  } finally { g.restore(); }
});

test('POST /book validates and creates an issue', async () => {
  const calls = [];
  const g = withFetch(fakeGitHub(calls));
  try {
    const bad = await handleRequest(new Request('https://w/book', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'demo', name: '', phone: '', slot_start: '' }),
    }), env);
    assert.equal(bad.status, 400);

    const ok = await handleRequest(new Request('https://w/book', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'demo', name: '홍길동', phone: '010-1', service: '지붕 누수 점검', slot_start: '2099-01-05 09:00' }),
    }), env);
    const body = await ok.json();
    assert.equal(ok.status, 201);
    assert.equal(body.ok, true);
    const created = calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues'));
    assert.ok(created, 'issue create called');
    assert.ok(created.body.labels.includes('type:booking'));
    assert.ok(created.body.body.includes('홍길동'));
  } finally { g.restore(); }
});

test('POST /twilio/voice dispatches on a missed call and returns TwiML', async () => {
  const calls = [];
  const g = withFetch(fakeGitHub(calls));
  try {
    const res = await handleRequest(new Request('https://w/twilio/voice/demo', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: '+821012345678', CallStatus: 'no-answer' }),
    }), env);
    const xml = await res.text();
    assert.match(xml, /<Response>/);
    const disp = calls.find((c) => c.url.endsWith('/dispatches'));
    assert.ok(disp, 'repository_dispatch called');
    assert.equal(disp.body.event_type, 'missed_call');
    assert.equal(disp.body.client_payload.caller, '+821012345678');
  } finally { g.restore(); }
});

test('POST /twilio/voice does NOT dispatch on a completed call', async () => {
  const calls = [];
  const g = withFetch(fakeGitHub(calls));
  try {
    await handleRequest(new Request('https://w/twilio/voice/demo', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: '+8210', CallStatus: 'completed' }),
    }), env);
    assert.ok(!calls.find((c) => c.url.endsWith('/dispatches')), 'no dispatch for answered call');
  } finally { g.restore(); }
});
