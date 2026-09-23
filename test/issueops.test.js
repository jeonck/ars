import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIssueForm,
  planBooking,
  planMissedCall,
  planReminder,
} from '../scripts/lib/issueops.mjs';

const tenant = {
  key: 'demo',
  name: '든든 지붕 시공',
  owner_phone: '+821000000000',
  services: ['지붕 누수 점검'],
  sms_template: '[{business}] 부재중 전화 드립니다. 예약: {link}',
  reminder_hours: 3,
  pages_base_url: 'https://user.github.io/ars/book.html',
};

test('parseIssueForm extracts GitHub issue-form fields', () => {
  const body = [
    '### 업체 키', '', 'demo', '',
    '### 이름', '', '홍길동', '',
    '### 연락처', '', '010-1234-5678', '',
    '### 상담 항목', '', '지붕 누수 점검', '',
    '### 희망 일시', '', '2026-09-25 10:00', '',
    '### 요청사항', '', '_No response_', '',
  ].join('\n');
  const f = parseIssueForm(body);
  assert.equal(f['업체 키'], 'demo');
  assert.equal(f['이름'], '홍길동');
  assert.equal(f['연락처'], '010-1234-5678');
  assert.equal(f['희망 일시'], '2026-09-25 10:00');
  assert.equal(f['요청사항'], ''); // _No response_ normalized to empty
});

test('planBooking confirms a valid booking and texts customer + owner', () => {
  const f = { 이름: '홍길동', 연락처: '010-1234-5678', '상담 항목': '지붕 누수 점검', '희망 일시': '2026-09-25 10:00' };
  const plan = planBooking(f, tenant);
  assert.equal(plan.status, 'ok');
  assert.ok(plan.labels.includes('booking:confirmed'));
  assert.equal(plan.sms.length, 2);
  assert.ok(plan.sms.some((m) => m.to === '010-1234-5678' && m.body.includes('예약')));
  assert.ok(plan.sms.some((m) => m.to === tenant.owner_phone && m.body.includes('신규 상담 예약')));
  assert.ok(plan.comment.includes('2026-09-25 10:00'));
});

test('planBooking asks for missing required fields', () => {
  const plan = planBooking({ 이름: '홍길동' }, tenant); // no phone / slot
  assert.equal(plan.status, 'needs_info');
  assert.ok(plan.labels.includes('needs-info'));
  assert.equal(plan.sms.length, 0);
  assert.ok(plan.comment.includes('연락처'));
  assert.ok(plan.comment.includes('희망 일시'));
});

test('planMissedCall texts the caller a booking link', () => {
  const plan = planMissedCall({ '발신 번호': '+821012345678' }, tenant);
  assert.equal(plan.status, 'ok');
  assert.ok(plan.labels.includes('lead:texted'));
  assert.equal(plan.sms.length, 1);
  const sms = plan.sms[0];
  assert.equal(sms.to, '+821012345678');
  assert.ok(sms.body.includes(tenant.name));
  assert.ok(sms.body.includes('key=demo'), 'link should carry the tenant key');
});

test('planMissedCall needs a caller number', () => {
  const plan = planMissedCall({}, tenant);
  assert.equal(plan.status, 'needs_info');
  assert.equal(plan.sms.length, 0);
});

test('planReminder fires only inside the window and once', () => {
  const now = '2026-06-15 09:00';
  const inWindow = planReminder({ 연락처: '+8210', '희망 일시': '2026-06-15 11:00' }, tenant, now, []);
  assert.equal(inWindow.status, 'ok');
  assert.ok(inWindow.sms[0].body.includes('리마인더'));

  const outWindow = planReminder({ 연락처: '+8210', '희망 일시': '2026-06-15 18:00' }, tenant, now, []);
  assert.equal(outWindow.status, 'skip');

  const already = planReminder({ 연락처: '+8210', '희망 일시': '2026-06-15 11:00' }, tenant, now, ['reminded']);
  assert.equal(already.status, 'skip');
});
