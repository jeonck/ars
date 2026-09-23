# ARS — 자동 상담 예약링크 발송 시스템

> **현장에서 전화를 못 받아도 놓치지 않습니다.**
> 부재중 전화가 오면 자동으로 발신자에게 **상담 예약 링크 문자**를 보내고,
> 고객이 링크에서 직접 편한 시간을 예약하면 **고객과 사장님 양쪽에 확정 문자**를 보냅니다.

지붕 공사처럼 현장 작업이 많아 통화가 어려운 업종을 위한 아이디어(“Missed-call → Auto-text booking link”)를,
특정 업종에 종속되지 않는 **범용·멀티테넌트** 웹 시스템으로 구현했습니다.

- **의존성 0** — Node.js 22의 내장 모듈만 사용 (`node:http`, `node:sqlite`, 내장 `fetch`). `npm install` 불필요.
- **바로 데모 가능** — Twilio 없이도 `mock` 모드로 전체 흐름이 동작(문자를 콘솔·DB에 기록).
- **실서비스 전환** — Twilio 환경변수만 넣으면 실제 SMS 발송으로 자동 전환.

---

## 동작 흐름

```
① 고객이 전화 → 사장님 현장 작업 중 (부재중)
        │
        ▼
② Twilio가 통화 종료 상태(no-answer/busy 등)를 웹훅으로 전송
   POST /webhooks/voice/:key
        │
        ▼
③ 시스템이 lead 생성 + 발신자에게 예약 링크 문자 자동 발송
   "…아래 링크에서 편하신 상담 시간을 예약해 주세요: https://…/book/:key?t=토큰"
        │
        ▼
④ 고객이 링크 접속 → 날짜·시간 선택 → 예약
   GET /book/:key  ·  POST /api/:key/bookings
        │
        ▼
⑤ 고객에게 "예약 확정" 문자 + 사장님에게 "신규 상담 예약" 알림 문자
```

---

## 빠른 시작

```bash
# 1) 실행 (npm install 필요 없음)
node src/server.js
#   또는 .env를 쓰려면:
cp .env.example .env         # 값 수정
node --env-file=.env src/server.js
```

접속:

| 페이지 | URL | 설명 |
|---|---|---|
| 랜딩 + 라이브 데모 | <http://localhost:3000/> | 부재중 전화를 시뮬레이션해 문자·링크 확인 |
| 예약 페이지(데모) | <http://localhost:3000/book/demo> | 고객이 보는 예약 화면 |
| 관리자 대시보드 | <http://localhost:3000/dashboard> | 업체·예약·리드·문자·설정 관리 |

첫 실행 시 데모 업체(`key=demo`, `든든 지붕 시공`)가 자동 생성됩니다.
대시보드 접속 토큰은 `ADMIN_TOKEN`(기본값 `dev-admin-token`)입니다.

```bash
# 테스트
node --test
```

---

## Twilio 연동 (실제 SMS 발송)

`.env`에 아래 값을 채우면 자동으로 실제 발송 모드로 전환됩니다.

```
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_FROM=+1xxxxxxxxxx
BASE_URL=https://your-public-domain.com   # 문자 링크에 쓰이는 공개 주소
```

그리고 Twilio 전화번호의 **통화 상태 콜백(Call Status Callback)** 을 아래로 지정하세요.
업체별로 `:key`를 바꾸면 하나의 서버가 여러 업체를 처리합니다(멀티테넌트).

```
POST https://your-public-domain.com/webhooks/voice/<업체키>
```

> 통화가 실제로 연결되지 않은 경우(`no-answer`, `busy`, `failed`, `canceled`)에만 문자를 보냅니다.
> Twilio의 `<Dial>` 결과를 쓰려면 `DialCallStatus`, 콜 자체 상태를 쓰려면 `CallStatus` 파라미터를 전달하면 됩니다.

---

## API 요약

### 공개
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/webhooks/voice/:key` | Twilio 통화상태 콜백. 부재중이면 문자 발송, TwiML 반환 |
| POST | `/api/:key/simulate-missed-call` | 데모용 부재중 전화 시뮬레이션 (`{ caller }`) |
| GET | `/api/:key/tenant` | 업체 공개 정보(이름·상담항목·슬롯 길이) |
| GET | `/api/:key/open-dates` | 예약 가능한 날짜 목록(향후 14일) |
| GET | `/api/:key/slots?date=YYYY-MM-DD` | 해당 날짜의 예약 가능 시간대 |
| GET | `/api/:key/lead?t=토큰` | 링크 토큰으로 발신번호 조회(폼 자동입력용) |
| POST | `/api/:key/bookings` | 예약 생성 `{ token?, name, phone, service?, slot_start, notes? }` |

### 관리자 (`x-admin-token` 헤더 또는 `?admin_token=`)
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/admin/tenants` | 업체 목록 |
| POST | `/api/admin/tenants` | 업체 생성 `{ name, key?, ... }` |
| GET/PUT | `/api/admin/tenants/:key` | 업체 조회/수정(템플릿·영업시간·상담항목 등) |
| GET | `/api/admin/:key/leads` | 부재중/리드 목록 |
| GET | `/api/admin/:key/bookings` | 예약 목록 |
| GET | `/api/admin/:key/messages` | 발송 문자 로그 |

---

## 설정 항목 (업체별)

- **sms_template** — 자동 문자 문구. 치환 변수: `{business}`, `{link}`, `{caller}`
- **business_hours** — 요일별 영업시간 `{ mon:["09:00","18:00"], sun:null, ... }` (`null`이면 휴무)
- **slot_minutes** — 예약 슬롯 길이(분)
- **services** — 상담 항목 목록(예약 페이지 드롭다운)
- **owner_phone** — 신규 예약 시 사장님에게 알림 문자를 보낼 번호
- **timezone** — 영업시간·"지난 시간" 판정 기준 IANA 타임존(기본 `Asia/Seoul`)

모두 관리자 대시보드의 **⚙️ 설정** 탭에서 편집할 수 있습니다.

---

## 구조

```
src/
  config.js   환경변수·설정
  db.js       node:sqlite 스키마 + 데이터 액세스 + 데모 시드
  slots.js    영업시간·예약 기반 가용 시간대 계산(타임존 인지)
  sms.js      SMS 발송 추상화(Twilio / mock) + 템플릿 렌더링
  core.js     핵심 로직: 부재중 처리, 예약 생성·검증
  server.js   내장 http 서버 + 라우터 + 정적 페이지
public/
  index.html      랜딩 + 라이브 데모
  book.html       고객 예약 페이지
  dashboard.html  관리자 대시보드
test/
  flow.test.js    node:test 통합 테스트
```

## 설계 메모

- **동시 예약 방지** — `bookings` 테이블에 `UNIQUE(tenant_id, slot_start, status)` 제약을 두어,
  같은 시간대 중복 예약을 DB 레벨에서 차단(경합 시 사용자 친화적 오류 반환).
- **지난 시간 필터** — 슬롯 계산은 업체 타임존 기준 현재 시각과 비교하여 과거 시간을 제외.
- **개인정보** — 발신번호는 예약 링크 토큰으로만 연결되며, 공개 API는 최소 정보만 노출.

## 라이선스

MIT
