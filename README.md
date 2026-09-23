# ARS — 자동 상담 예약링크 발송 시스템

> **현장에서 전화를 못 받아도 놓치지 않습니다.**
> 부재중 전화가 오면 자동으로 발신자에게 **상담 예약 링크 문자**를 보내고,
> 고객이 링크에서 직접 편한 시간을 예약하면 **고객과 사장님 양쪽에 확정 문자**를 보냅니다.

지붕 공사처럼 현장 작업이 많아 통화가 어려운 업종을 위한 아이디어(“Missed-call → Auto-text booking link”)를,
특정 업종에 종속되지 않는 **범용·멀티테넌트** 웹 시스템으로 구현했습니다.

- **의존성 0** — Node.js 22의 내장 모듈만 사용 (`node:http`, `node:sqlite`, 내장 `fetch`). `npm install` 불필요.
- **바로 데모 가능** — Twilio 없이도 `mock` 모드로 전체 흐름이 동작(문자를 콘솔·DB에 기록).
- **실서비스 전환** — Twilio 환경변수만 넣으면 실제 SMS 발송으로 자동 전환.
- **예약 취소/변경, 리마인더 문자, 스팸 방지·수신거부(STOP)** 기능 내장 — 아래 [추가 기능](#추가-기능) 참고.

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
| 예약 관리(취소/변경) | `/manage/:key?b=관리토큰` | 확정 문자 링크로 접속하는 취소·변경 화면 |
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
| GET | `/api/:key/booking?b=관리토큰` | 관리 토큰으로 예약 조회(취소/변경 화면용) |
| POST | `/api/:key/bookings/cancel` | 예약 취소 `{ b: 관리토큰 }` |
| POST | `/api/:key/bookings/reschedule` | 예약 시간 변경 `{ b: 관리토큰, slot_start }` |
| POST | `/webhooks/sms/:key` | Twilio 인바운드 SMS 콜백. STOP/START 등 수신거부·재수신 처리 |

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
- **reminder_hours** — 예약 시각 몇 시간 전에 리마인더 문자를 보낼지(기본 3시간)
- **cooldown_minutes** — 같은 번호에 자동 문자를 다시 보내지 않는 최소 간격(기본 60분)

모두 관리자 대시보드의 **⚙️ 설정** 탭에서 편집할 수 있습니다.

---

## 추가 기능

### ① 예약 취소/변경
- 예약 확정 문자에 **관리 링크**(`/manage/:key?b=관리토큰`)가 포함됩니다.
- 고객이 링크에서 직접 **취소**하거나 **다른 시간으로 변경**할 수 있고, 변경·취소 시 고객·사장님 양쪽에 알림 문자가 갑니다.
- 취소하면 해당 시간대가 다시 예약 가능 상태로 풀립니다.

### ② 리마인더 문자
- 서버가 1분마다 예약을 점검해, **예약 시각 `reminder_hours`시간 전**에 리마인더 문자를 자동 발송합니다.
- 각 예약당 한 번만 발송(중복 방지). 예약을 변경하면 리마인더가 다시 예약됩니다.
- 인프로세스 스케줄러이므로 서버가 떠 있는 동안 동작합니다(별도 크론 불필요).

### ③ 중복발송 방지 + 수신거부(STOP)
- **쿨다운** — 같은 번호에서 `cooldown_minutes` 이내에 부재중 전화가 반복돼도 자동 문자를 다시 보내지 않습니다.
- **수신거부** — 고객이 `STOP`(또는 `수신거부`, `구독취소`, `그만` 등)으로 회신하면 이후 문자를 보내지 않습니다.
  `START`(또는 `수신동의`, `시작`)로 다시 켤 수 있습니다.
  Twilio 번호의 **인바운드 메시지 콜백**을 `POST /webhooks/sms/:key`로 지정하세요.
- 수신거부한 고객에게는 예약 확정·리마인더 문자도 나가지 않지만, **사장님 알림은 정상 발송**됩니다.

---

## 구조

```
src/
  config.js   환경변수·설정
  db.js       node:sqlite 스키마 + 데이터 액세스 + 데모 시드
  slots.js    영업시간·예약 기반 가용 시간대 계산(타임존 인지)
  sms.js      SMS 발송 추상화(Twilio / mock) + 템플릿 렌더링
  core.js     핵심 로직: 부재중 처리, 예약 생성·검증·취소·변경, 리마인더, 수신거부
  reminders.js 예약 리마인더 스케줄러(인프로세스 루프)
  server.js   내장 http 서버 + 라우터 + 정적 페이지
public/
  index.html      랜딩 + 라이브 데모
  book.html       고객 예약 페이지
  manage.html     예약 취소/변경 페이지
  dashboard.html  관리자 대시보드
test/
  flow.test.js         node:test 통합 테스트(기본 흐름)
  improvements.test.js 취소/변경·리마인더·수신거부·쿨다운 테스트
```

## 설계 메모

- **동시 예약 방지** — `bookings`에 `status='confirmed'` 부분 유니크 인덱스를 두어,
  같은 시간대 중복 예약을 DB 레벨에서 차단(경합 시 사용자 친화적 오류 반환).
  취소된 예약은 인덱스 대상이 아니므로 같은 시간대를 다시 예약할 수 있습니다.
- **지난 시간 필터** — 슬롯 계산은 업체 타임존 기준 현재 시각과 비교하여 과거 시간을 제외.
- **개인정보** — 발신번호는 예약 링크 토큰으로만 연결되며, 공개 API는 최소 정보만 노출.

## GitHub 네이티브 (서버리스) 옵션 — PoC

"상시 서버 없이 GitHub만으로" 운영하는 방식의 개념 증명입니다.
**GitHub Issues를 DB로, GitHub Actions를 처리 엔진으로** 사용합니다.

### 구성
```
config/tenants.json          업체 설정(이름·템플릿·상담항목·리마인더시간) — DB 대신 git 파일
.github/ISSUE_TEMPLATE/       예약·부재중 이슈 폼(구조화 입력)
scripts/lib/issueops.mjs      순수 처리 로직(파싱·플랜) — 단위 테스트 대상
scripts/issue-ops.mjs         이슈 이벤트 처리(문자 발송 + 라벨 + 코멘트)
scripts/reminders-gh.mjs      확정 예약 스캔 후 리마인더 발송
scripts/create-missed-call.mjs  repository_dispatch → 부재중 이슈 생성
worker/                       Cloudflare Worker(전화 수신 + 예약 API) + wrangler.toml
site/                         GitHub Pages 정적 예약 페이지(Worker와 통신)
.github/workflows/            issue-ops.yml (on: issues), reminders.yml (on: schedule), pages.yml (Pages 배포)
```

### 흐름
1. **예약** — 고객이 `상담 예약 요청` 이슈 폼 제출 → `issue-ops` 워크플로가 확정 문자(고객+사장님) 발송, `booking:confirmed` 라벨, 요약 코멘트.
2. **부재중** — `부재중 전화` 이슈 폼 또는 `repository_dispatch(missed_call)` → 발신자에게 예약 링크 문자, `lead:texted` 라벨.
3. **리마인더** — `reminders` 워크플로(크론)가 확정 예약을 스캔해 예약 `reminder_hours`시간 전 문자 발송(`reminded` 라벨로 1회만).

### 켜는 법
- **문자 실발송** — 저장소 Secrets에 `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM` 등록(없으면 mock: Actions 로그·코멘트에만 기록).
- **예약 페이지** — `public/book.html`을 GitHub Pages로 배포하고 `config/tenants.json`의 `pages_base_url` 갱신.
- **인증** — 처리에는 Actions 기본 `GITHUB_TOKEN` 사용(브라우저에 토큰 노출 금지).

### 배포 런북 — "서버 0대 + 공개 URL"
전화 수신은 **Cloudflare Worker**(무료 티어, 관리형)가, 예약 페이지는 **GitHub Pages**가 담당합니다.
브라우저에는 토큰이 절대 노출되지 않습니다(모든 GitHub 쓰기는 Worker의 시크릿 토큰으로).

```
[Twilio] ──POST /twilio/voice/:key──▶ [Cloudflare Worker] ──repository_dispatch──▶ [GitHub Actions] ──▶ SMS + 이슈
[고객 브라우저] ──/tenant·/slots·/book──▶ [Cloudflare Worker] ──GitHub API──▶ [GitHub Issues]
[GitHub Pages] ── 정적 예약 페이지(site/) ── 고객에게 링크로 노출
```

**1) Cloudflare Worker 배포** (`worker/`)
```bash
cd worker
npx wrangler login
npx wrangler secret put GH_TOKEN   # fine-grained PAT: Issues=RW, Contents=RW(=repository_dispatch)
npx wrangler secret put GH_REPO    # 예: jeonck/ars  (실운영은 private 저장소 권장)
npx wrangler deploy
# → https://ars-worker.<subdomain>.workers.dev
```

**1-대안 A) Workers Builds (GitHub 저장소 연결 · CI 자동 배포)**
대시보드에서 저장소를 연결하면 CI가 저장소 **루트**에서 `npx wrangler deploy`를 실행합니다.
이를 위해 루트에 `wrangler.toml`(entry = `worker/src/index.mjs`)이 포함되어 있습니다.
1. **Create an app** 화면 — Build command 는 비움, Deploy command 는 `npx wrangler deploy` 그대로, **Preview builds 토글은 끄기**(구버전 `wrangler preview` 오류 방지) → **Deploy**.
2. 첫 배포 후 Worker → **Settings → Variables and Secrets** 에 `GH_TOKEN`(Secret), `GH_REPO`(Text), `ALLOW_ORIGIN`(Text, 선택) 추가.
3. 이후 `main` 에 푸시할 때마다 자동 재배포됩니다.

**1-대안 B) wrangler 없이 대시보드 코드 편집기로 붙여넣기**
`wrangler`는 CLI라 대시보드에는 없습니다. 대신 브라우저만으로 배포하려면:
1. <https://dash.cloudflare.com> → **Workers & Pages → Create → Create Worker** → 이름 지정 → Deploy.
2. **Edit code** 로 들어가 `worker/dist/index.js`(모든 import가 합쳐진 단일 파일) 전체를 붙여넣고 **Deploy**.
3. Worker → **Settings → Variables and Secrets** 에서 추가:
   - `GH_TOKEN` (Secret) — fine-grained PAT: Issues=RW, Contents=RW
   - `GH_REPO` (Text) — `jeonck/ars`
   - `ALLOW_ORIGIN` (Text, 선택) — `https://jeonck.github.io`
4. 발급된 `https://<worker>.workers.dev` 주소를 사용합니다.
> 참고: 대시보드 편집기는 단일 파일만 받으므로 `worker/src/index.mjs`(여러 파일 import)가 아니라 반드시 **`worker/dist/index.js`** 를 붙여넣으세요. 두 파일은 같은 동작이며 테스트로 동기화가 보장됩니다.

**2) GitHub Pages 배포** (`site/`)
- `site/config.js` 의 `window.ARS_WORKER` 를 위 Worker URL로 수정 → 커밋/푸시.
- 저장소 **Settings → Pages → Source = "GitHub Actions"** 한 번 설정.
- `Deploy Pages` 워크플로가 `site/` 를 배포 → `https://<user>.github.io/<repo>/`.
- `config/tenants.json` 의 `pages_base_url` 를 그 주소로 맞춤(부재중 문자 링크에 사용).

**3) Twilio 연결**
- 번호의 **Voice status callback** → `POST https://…workers.dev/twilio/voice/demo`
- 번호의 **Messaging webhook** → `POST https://…workers.dev/twilio/sms/demo`
- Actions Secrets 에 `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM` 등록(문자 실발송).

> 제약: Worker/Pages **배포 명령 자체는 각자의 계정 로그인**이 필요합니다(코드·설정·런북은 저장소에 준비됨).
> Twilio 서명 검증은 다음 단계 권장 항목입니다(현재 Worker는 미검증 — public 데모 기준).

### 로컬 dry-run (네트워크 없이 처리 미리보기)
```bash
DRY_RUN=1 GITHUB_REPOSITORY=owner/repo GITHUB_EVENT_PATH=event.json node scripts/issue-ops.mjs
```

### ⚠️ 한계 (정직하게)
- **전화/문자 수신 엔드포인트는 GitHub가 대체 불가.** Twilio 인바운드 웹훅을 받을 초경량 서버리스(예: Cloudflare Workers 무료) 또는 사장님 폰 자동화(→ `repository_dispatch`)가 필요합니다.
- **지연** — Actions 큐·콜드스타트로 수십 초, 스케줄 크론은 수 분 지연/누락 가능(리마인더엔 무방, "즉시 응답"엔 불리).
- **개인정보** — 고객 전화번호가 이슈에 쌓이므로 **반드시 private 저장소**로 운영하세요.

> 정리: 예약 페이지·저장·처리·리마인더는 GitHub로 옮길 수 있고, **딱 "전화 수신" 한 조각만** 외부 트리거가 필요합니다.

## 라이선스

MIT
