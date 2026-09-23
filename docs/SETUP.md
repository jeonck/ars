# ARS 배포 설정 가이드 (서버 0대 · GitHub-네이티브)

> 이 문서는 `jeonck/ars`(자동 상담 예약링크 발송 시스템)를 **상시 서버 없이**
> 배포하기까지 실제로 진행한 설정과, 그 과정에서 겪은 문제·해결을 기록합니다.
> 최종 상태: **예약 페이지 → Cloudflare Worker → GitHub Issues → GitHub Actions** 파이프라인이 라이브로 동작 확인됨.

최종 업데이트: 2026-09-23

---

## 1. 전체 구조

```
[Twilio]  ──POST /twilio/voice/:key──▶ [Cloudflare Worker] ──repository_dispatch──▶ [GitHub Actions] ──▶ 문자 + 이슈
[고객 브라우저] ──/tenant·/slots·/book──▶ [Cloudflare Worker] ──GitHub API──▶ [GitHub Issues]
[GitHub Pages] ── 정적 예약 페이지(site/) ── 고객에게 링크로 노출
```

- **상시 켜둔 서버 없음.** Cloudflare Worker(관리형)와 GitHub Pages/Actions만 사용.
- **토큰은 브라우저에 노출되지 않음.** 모든 GitHub 쓰기는 Worker의 시크릿 토큰으로 수행.
- **데이터 저장소 = GitHub Issues**, **처리 엔진 = GitHub Actions**, **설정 = git 파일**.

### 라이브 주소
| 용도 | URL |
|---|---|
| 예약 페이지 | https://jeonck.github.io/ars/ |
| Worker (API·전화 수신) | https://ars-worker.jeonck2000.workers.dev |
| 진단(health) | https://ars-worker.jeonck2000.workers.dev/health?key=demo |
| 저장소 | https://github.com/jeonck/ars |

---

## 2. 완료된 설정 단계

### 2.1 GitHub 저장소 / 코드
- 기본 브랜치 `main`에 애플리케이션 + 서버리스 구성 전부 포함.
- 주요 디렉터리
  - `site/` — GitHub Pages 정적 예약 페이지 (`config.js`의 `ARS_WORKER`에 Worker URL 지정)
  - `worker/` — Cloudflare Worker (`src/index.mjs` 소스, `dist/index.js` 붙여넣기용 단일 파일)
  - `config/tenants.json` — 업체 설정(이름·상담항목·영업시간·리마인더 등), DB 대신 git 파일
  - `.github/ISSUE_TEMPLATE/` — 예약/부재중 이슈 폼
  - `.github/workflows/` — `issue-ops.yml`(이슈 처리), `reminders.yml`(리마인더 크론), `pages.yml`(Pages 배포)
  - `scripts/` — 이슈 처리 로직(`issue-ops.mjs`, `reminders-gh.mjs`, `create-missed-call.mjs`, `lib/`)
  - 루트 `wrangler.toml` — Workers Builds가 사용하는 배포 설정

### 2.2 GitHub Pages
- 저장소 **Settings → Pages → Build and deployment → Source = "GitHub Actions"** 로 설정.
- `pages.yml` 워크플로가 `site/` 디렉터리를 배포 → https://jeonck.github.io/ars/

### 2.3 Cloudflare Worker (Workers Builds · GitHub 연결)
- `dash.cloudflare.com` → **Workers & Pages** 에서 GitHub 저장소를 연결(Workers Builds).
- Create an app 화면:
  - App 이름: `ars-worker`
  - **Build command**: 비움
  - **Deploy command**: `npx wrangler deploy`
  - **Preview builds**: 끔(구버전 `wrangler preview` 오류 방지)
- 루트 `wrangler.toml`이 엔트리(`worker/src/index.mjs`)를 가리키므로, CI가 저장소 루트에서 자동 번들·배포.
- `main`에 푸시할 때마다 자동 재배포됨.

### 2.4 환경 변수 / 시크릿 (Worker · Runtime variables and secrets)
Cloudflare Worker → **Settings → Variables and Secrets (Production)**:

| Type | Name | Value | 비고 |
|---|---|---|---|
| Secret | `GH_TOKEN` | *(암호화)* GitHub fine-grained PAT | 절대 평문/공개 금지 |
| Variable | `GH_REPO` | `jeonck/ars` | |
| Variable | `ALLOW_ORIGIN` | `https://jeonck.github.io` | CORS 허용 출처 |

> ⚠️ **중요(함정):** Workers Builds는 푸시마다 `npx wrangler deploy`를 실행하는데,
> 이때 `wrangler.toml`의 `[vars]`에 **없는 평문 변수는 배포 시 삭제**됩니다(Secret은 유지).
> 그래서 `GH_REPO`·`ALLOW_ORIGIN`을 루트 `wrangler.toml`의 `[vars]`에 **고정**해 두었습니다.
> `GH_TOKEN`은 시크릿이라 `wrangler.toml`에 넣지 않고 대시보드/`wrangler secret`으로만 관리합니다.

```toml
# wrangler.toml (루트)
name = "ars-worker"
main = "worker/src/index.mjs"
compatibility_date = "2025-01-01"

[vars]
GH_REPO = "jeonck/ars"
ALLOW_ORIGIN = "https://jeonck.github.io"
```

### 2.5 GitHub Fine-grained PAT 권한 (첨부 내용 포함)
Worker의 `GH_TOKEN`으로 쓸 **fine-grained personal access token** 설정:

- **Repository access**: *Only select repositories* → **`jeonck/ars`** (1개)
- **Repository permissions** (최종, 필요한 3가지):

| 권한 | Access | 용도 |
|---|---|---|
| **Issues** | **Read and write** | 예약 이슈 **생성/조회** (핵심) |
| **Contents** | **Read and write** | 부재중 전화 트리거 `repository_dispatch` |
| **Metadata** | Read-only *(Required)* | 필수(자동 포함) |

> 📌 **겪은 문제:** 처음엔 **Contents + Metadata만** 부여되어(첨부 스크린샷 상태) 권한이 2개였고,
> 이 때문에 시간 조회는 되어도(폴백 덕분) **예약 제출(이슈 생성)에서 `server_error`(403)** 가 발생했습니다.
> **Issues = Read and write** 를 추가(권한 3개)한 뒤 정상 동작했습니다.
> fine-grained 토큰은 권한 변경이 즉시 반영되며, 토큰 문자열이 그대로면 Cloudflare 재설정 불필요.

### 2.6 프론트–Worker 연결
- `site/config.js`의 `window.ARS_WORKER = "https://ars-worker.jeonck2000.workers.dev"` 로 설정 → 커밋 → Pages 자동 재배포.
- `config/tenants.json`의 `pages_base_url = "https://jeonck.github.io/ars/"` (부재중 문자 링크에 사용).

---

## 3. 라이브 검증 결과

| 검증 | 방법 | 결과 |
|---|---|---|
| 이슈 처리(issue-ops) | 이슈 #1 생성(예약 폼) | ✅ 라벨 `booking:confirmed` + 확정/사장님 코멘트, 약 12초 |
| 전체 파이프라인 | 예약 페이지에서 실제 제출 → 이슈 #2 | ✅ Worker가 이슈 생성 → Actions가 확정 처리, 약 8초 |
| 이슈 #2 코멘트 | github-actions[bot] | ✅ 고객 확정 문자(mock) + 사장님 알림 문자(mock) 기록 |

> 문자는 현재 **mock 모드**(코멘트에만 기록). Twilio 시크릿을 넣으면 실제 SMS로 전환됩니다(4장).

---

## 4. 트러블슈팅 로그 (실제로 막혔다가 해결한 것들)

1. **Pages 배포 실패** — `configure-pages` 단계 실패 → Pages Source를 "GitHub Actions"로 설정하니 해결.
2. **`GH_TOKEN` 값이 안내 문구 그대로** — Value에 `GitHub fine-grained PAT`라는 설명을 그대로 입력함 → 실제 `github_pat_...` 값으로 교체.
3. **`GH_TOKEN` Secret 체크 누락** — 평문으로 저장될 뻔 → **Secret(암호화)** 로 저장.
4. **평문 변수 유실 위험** — `wrangler deploy`가 `[vars]`에 없는 변수를 지움 → `GH_REPO`·`ALLOW_ORIGIN`을 `wrangler.toml`에 고정.
5. **시간 항목 무한 "불러오는 중…"** — `/slots`가 CORS 없는 500을 반환 → Worker에 try/catch(읽을 수 있는 JSON 오류) + 실패 시 빈 예약으로 폴백 + `/health` 진단 추가, 프론트도 오류 표시하도록 수정.
6. **예약 제출 시 `server_error`** — PAT에 **Issues 권한 누락** → Issues=Read and write 추가로 해결.

---

## 5. 실서비스 전환 시 남은 작업(선택)

1. **실제 문자 발송(Twilio)**
   - GitHub 저장소 **Settings → Secrets and variables → Actions** 에
     `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` 추가 → mock에서 실제 SMS로 자동 전환.
2. **전화 수신 연결(Twilio 콘솔)**
   - 번호 **Voice status callback** → `https://ars-worker.jeonck2000.workers.dev/twilio/voice/demo`
   - 번호 **Messaging webhook** → `https://ars-worker.jeonck2000.workers.dev/twilio/sms/demo`
3. **개인정보(PII) 보호** — 현재 저장소가 **public**이라 예약 시 고객 전화번호가 공개 이슈에 남습니다.
   실운영은 반드시 **private 저장소**로 운영하세요. (예: 이슈 #2에 테스트 번호 노출됨 → 정리 권장)
4. **Twilio 서명 검증** — 현재 Worker의 Twilio 웹훅은 서명 미검증(데모 기준). 실운영 전 추가 권장.
5. **`ALLOW_ORIGIN`** — 이미 `https://jeonck.github.io`로 제한됨(운영 도메인에 맞게 유지).

---

## 6. 참고: Worker 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/health?key=demo` | 토큰/저장소 연동 진단 |
| GET | `/tenant?key=` | 업체 공개 정보 |
| GET | `/open-dates?key=` | 예약 가능한 날짜 |
| GET | `/slots?key=&date=` | 해당 날짜 예약 가능 시간 |
| POST | `/book` | 예약 생성(이슈 생성) |
| POST | `/twilio/voice/:key` | Twilio 통화상태 콜백 → 부재중 트리거 |
| POST | `/twilio/sms/:key` | Twilio 인바운드 SMS(STOP/START) |

배포·아키텍처 상세는 저장소 `README.md`의 "GitHub 네이티브 (서버리스) 옵션" 및 "배포 런북" 참고.
