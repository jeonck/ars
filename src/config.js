// 환경 변수에서 설정을 읽어옵니다. .env는 별도 로더 없이
// process.env 로만 다루므로, 배포 환경 변수로 주입하거나
// `node --env-file=.env src/server.js` 로 실행하세요.

const port = Number(process.env.PORT || 3000);

export const config = {
  port,
  baseUrl: (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  adminToken: process.env.ADMIN_TOKEN || 'dev-admin-token',
  dbPath: process.env.DB_PATH || './data/ars.db',
  twilio: {
    sid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_FROM || '',
  },
};

// Twilio 자격증명이 모두 있으면 실제 발송, 아니면 mock(콘솔/DB 기록) 모드.
export const smsLive = Boolean(
  config.twilio.sid && config.twilio.authToken && config.twilio.from,
);
