# Twilio 등록 가이드 — 미국 SMS(A2P 10DLC) & 음성

> ARS(미스콜 → 자동 상담 예약링크 발송)를 **미국에서 실서비스**하기 위한 Twilio 등록 정리입니다.
> 대상: 미국 발송(+1). SMS는 **A2P 10DLC 등록이 사실상 필수**, 음성은 별도 10DLC 대상 아님.
>
> ⚠️ 요금·절차·처리량은 Twilio 정책에 따라 자주 바뀝니다. 수치는 **대략치**이며 반드시 Twilio 콘솔에서 최신값을 확인하세요.

최종 작성: 2026-09-23

---

## 0. 한눈에 요약

| 채널 | 미국 필수 등록 | 우리 시스템에서의 쓰임 |
|---|---|---|
| **SMS (문자)** | **A2P 10DLC** (Brand + Campaign) 또는 Toll-free Verification | 미스콜 응답 문자, 예약 확정/리마인더 발송, STOP 수신 |
| **음성 (통화)** | 10DLC 대상 아님 (별도) | Twilio가 보내는 **통화 상태 웹훅 수신**으로 부재중 감지 |

- **SMS를 일반 지역번호(10자리 long code)로 미국 고객에게 보내려면 A2P 10DLC 등록이 필요합니다.** 미등록 시 통신사가 차단/심한 제한.
- **음성**은 우리 유스케이스가 "Twilio가 통화 결과를 우리 Worker로 알려주는 것(수신)"이라 별도 등록이 필요 없습니다. (아웃바운드 통화·브랜드 발신자표시를 새로 쓸 때만 STIR/SHAKEN·CNAM 등 별건.)

---

## 1. SMS — A2P 10DLC 등록

### 1.1 A2P 10DLC란
미국 통신사가 기업 문자(Application-to-Person)를 관리하는 체계입니다. **사업자(Brand)** 와 **발송 용도(Campaign)** 를 등록해 심사받아야 정상 발송·처리량을 얻습니다.

### 1.2 두 가지 경로 (택1)
1. **A2P 10DLC (지역번호, 권장 일반경로)**
   - Brand 등록 + Campaign 등록.
   - **Standard Brand**: 미국 EIN(사업자 등록번호) 필요 → 처리량 높음.
   - **Sole Proprietor**: EIN 없는 1인/소규모용 → 등록 간단하지만 **처리량 낮음(일일 발송 한도 작음)**, 프로토타입/초기 소량엔 무방.
2. **Toll-free 번호 + Toll-free Verification (대안)**
   - 무료 검증, 승인 시 처리량 양호. 지역번호 대신 800/888 등 수신자부담 번호 사용.
   - 검증 소요: 보통 며칠~1~2주.

> 참고: **Short code**(전용 단축번호)는 처리량 최고지만 월 $1,000+ 수준으로 이 규모엔 과함.

### 1.3 비용(대략, 변동)
| 항목 | 대략 비용 |
|---|---|
| Brand 등록(1회) | ~$4 (Standard) |
| (선택) 상향 처리량 secondary vetting(1회) | ~$40 |
| Campaign(용도) 월 요금 | ~$1.5 ~ $10 / 월 (용도별) |
| Campaign 심사(1회) | ~$15 내외 |
| 발신 SMS 건당 | ~$0.0079 + 통신사 A2P 수수료 ~$0.003 |
| 지역번호 | ~$1.15 / 월 |

### 1.4 등록 절차 (Twilio 콘솔)
1. **Trust Hub → Customer Profile(사업자 정보)** 작성/제출.
2. **Messaging → Regulatory Compliance → A2P 10DLC → Brand 등록** (Standard 또는 Sole Proprietor).
3. **Messaging Service 생성** → 발송에 쓸 **전화번호를 Sender Pool에 추가**.
4. **A2P Campaign(용도) 생성** → Messaging Service에 연결 → 심사 제출.
5. 승인 후 발송 가능.

### 1.5 우리 유스케이스에 맞춘 캠페인 정보 (심사 제출용 초안, 영문)
- **Use case / Campaign type**: `Customer Care` 또는 `Conversational` (권장: Customer Care)
- **Campaign description**:
  > "When a customer calls the business and the call is not answered, the customer automatically receives one SMS containing a link to book a consultation. The business also sends booking confirmations and appointment reminders. Consent is implied by the customer's inbound call to the business; recipients can reply STOP to opt out at any time."
- **Sample messages** (실제 발송 문구와 일치해야 함):
  1. 미스콜 응답:
     > "[Sturdy Roofing] Sorry we missed your call — we're on a job site. Book a consultation time here: https://example.com/book?key=demo Reply STOP to opt out."
  2. 예약 확정:
     > "[Sturdy Roofing] Your consultation is booked for 2026-09-24 09:00. Reply to reschedule. Reply STOP to opt out."
  3. 리마인더:
     > "[Sturdy Roofing] Reminder: your consultation is at 2026-09-24 09:00. Reply STOP to opt out."
- **Opt-in 설명**: inbound call = implied consent. (웹 예약 폼 제출도 명시적 동의로 기재 가능.)
- **Opt-out**: STOP/UNSUBSCRIBE → 발송 중단. **HELP** → 안내 문구 회신.

> 심사 팁: **샘플 문구에 브랜드명 + opt-out 안내(Reply STOP)** 를 반드시 포함. 설명과 실제 발송 내용이 어긋나면 반려됩니다.

### 1.6 처리량(Throughput)
- Standard Brand + 검증 정도에 따라 초당 메시지 수(MPS)와 일일 한도가 결정됩니다.
- Sole Proprietor는 낮음(소량 콜백엔 충분할 수 있음). 발송량이 늘면 Standard로 상향.

---

## 2. 음성 (Voice)

### 2.1 우리 시스템의 음성 사용 방식
- 고객이 사업자 번호로 전화 → Twilio가 **통화 상태(Voice status)를 우리 Worker로 웹훅 전송** → 부재중이면 자동 문자 트리거.
- 즉 **우리는 통화를 "받기"보다 "결과를 통지받는" 쪽** → **별도 10DLC/등록 불필요.**

### 2.2 설정 포인트
- SMS·Voice 모두 가능한 **미국 지역번호**를 구매(권장: 같은 번호로 통일 → 고객이 문자에 회신/전화 일관).
- 번호의 **Voice 설정**에서 통화 상태 콜백을 우리 Worker로 지정.
- (선택) 부재중을 명확히 하려면 짧은 안내 멘트(TwiML `<Say>`/`<Dial>`) 후 상태 콜백을 받는 흐름도 가능.

### 2.3 참고(추후 필요 시)
- 아웃바운드 통화를 새로 하거나 **발신자 이름(CNAM)**, **STIR/SHAKEN(스팸 표시 방지)** 이 필요해지면 그때 별도 설정. 현재 콜백 수신 흐름에는 불필요.

---

## 3. 우리 시스템과 연결하는 법 (등록 완료 후)

1. **GitHub → Settings → Secrets and variables → Actions** 에 등록(실제 SMS 발송 전환):
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_FROM` — 발송 번호(E.164, 예: `+1XXXXXXXXXX`)
   > 코드 메모: 10DLC 실운영은 **Messaging Service SID**(`MGxxxx`)를 발신 주체로 쓰는 것을 권장합니다.
   > 현재 발송 로직은 `From` 번호를 사용하므로, 원할 경우 `TWILIO_FROM`에 번호 대신 Messaging Service를 쓰도록 `scripts/lib/notify.mjs`/`src/sms.js`를 소폭 수정하면 됩니다(도와드릴 수 있음).
2. **Twilio 번호 웹훅**을 우리 Worker로 지정:
   - Voice status callback → `https://ars-worker.jeonck2000.workers.dev/twilio/voice/demo`
   - Messaging(수신) webhook → `https://ars-worker.jeonck2000.workers.dev/twilio/sms/demo`
3. 이후 미스콜/예약 시 **mock이 아닌 실제 SMS**가 발송됩니다(미설정 시 코멘트에만 기록되는 mock 유지).

---

## 4. 컴플라이언스 체크리스트 (미국 TCPA + 통신사 규칙)

- [x] **STOP/UNSUBSCRIBE 수신거부 처리** — 시스템에 이미 구현됨(STOP/START, 한글 키워드 포함).
- [ ] **HELP 자동응답 문구** 추가 권장(예: "Reply STOP to unsubscribe. For help call …").
- [ ] **메시지에 브랜드명 명시** + opt-out 안내 포함.
- [ ] **거래성 유지** — 판촉이 아닌 **예약/안내** 목적으로 문구 작성(미스콜 응답은 고객이 먼저 연락 → 위험 낮음).
- [ ] **발송 시간대** — 마케팅성은 현지 8am~9pm 준수. (미스콜 즉시 응답은 대체로 통화 시간대라 무방.)
- [ ] **동의 기록** — inbound call/웹 예약을 동의 근거로 보관.
- [ ] (권장) **Twilio 서명 검증** — Worker의 Twilio 웹훅에 X-Twilio-Signature 검증 추가.

---

## 5. 프로토타입 vs 실서비스 요약

| 단계 | SMS | 필요 등록 | 비용 |
|---|---|---|---|
| 프로토타입 | Twilio 트라이얼, **본인 인증 번호로만** | 없음 | 체험 크레딧(~$15) |
| 실서비스(미국) | 지역번호 + **A2P 10DLC** (또는 Toll-free 검증) | Brand + Campaign | 번호 월 ~$1.15 + 캠페인 월 ~$1.5~10 + 건당 ~$0.01 |

> 지금 우리 시스템은 **mock 모드로 $0에 전체 흐름을 시연** 중입니다. 위 등록을 마치고 Secrets만 넣으면 실제 발송으로 전환됩니다.

관련 문서: 배포 전반은 `docs/SETUP.md`, 아키텍처·엔드포인트는 `README.md` 참고.
