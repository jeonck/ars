import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest, __tenants } from '../worker/dist/index.js';

const env = { GH_TOKEN: 'x', GH_REPO: 'jeonck/ars', ALLOW_ORIGIN: '*' };

test('bundled worker config stays in sync with config/tenants.json', () => {
  const src = JSON.parse(readFileSync(new URL('../config/tenants.json', import.meta.url)));
  assert.deepEqual(__tenants, src, 'worker/dist/index.js tenants drifted from config/tenants.json');
});

test('bundled worker behaves like the source (tenant, book, voice)', async () => {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (String(url).includes('/issues?')) return new Response('[]', { status: 200 });
    if (String(url).endsWith('/issues')) return new Response(JSON.stringify({ number: 7 }), { status: 201 });
    if (String(url).endsWith('/dispatches')) return new Response(null, { status: 204 });
    return new Response('{}', { status: 200 });
  };
  try {
    const t = await (await handleRequest(new Request('https://w/tenant?key=demo'), env)).json();
    assert.equal(t.name, '든든 지붕 시공');
    assert.equal(t.owner_phone, undefined);

    const ok = await handleRequest(new Request('https://w/book', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'demo', name: 'A', phone: '010', slot_start: '2099-01-05 09:00' }),
    }), env);
    assert.equal(ok.status, 201);
    assert.ok(calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues')));

    await handleRequest(new Request('https://w/twilio/voice/demo', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: '+8210', CallStatus: 'no-answer' }),
    }), env);
    assert.ok(calls.find((c) => c.url.endsWith('/dispatches')));
  } finally { globalThis.fetch = orig; }
});
