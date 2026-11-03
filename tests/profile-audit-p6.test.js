/* global __dirname, Buffer */
/**
 * P6 权限与审计验收：画像反馈必须留下可查询的审计记录，且不泄露正文。
 *
 * 覆盖：
 * - confirm / correct 成功写入 profile.feedback 审计（result=success）；
 * - 跨用户 deny 返回 403，并写入 result=denied；
 * - /monitoring/audit 需要鉴权；
 * - 审计记录不含记忆正文或更正内容；
 * - 反馈后 profile 反映新状态。
 *
 * 运行：node tests/profile-audit-p6.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-p6-audit-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.BLUEBIRD_USER_ID = 'local-owner';
process.env.BLUEBIRD_API_TOKEN = 'p6-audit-token';
process.env.BLUEBIRD_MONITORING = '1';
process.env.BLUEBIRD_RETRIEVAL = '0';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.DEEPSEEK_API_KEY = '';

const MEMORY_FILE = path.join(TMP, 'memory.json');
const OWNER = 'local-owner';
const OTHER = 'p6-other-user';
const TOKEN = 'p6-audit-token';
const MEMORY_SENTINEL = 'P6-AUDIT-MEMORY-SENTINEL';
const PENDING_SENTINEL = 'P6-AUDIT-PENDING-SENTINEL';
const CORRECTED_SENTINEL = 'P6-AUDIT-CORRECTED-SENTINEL';

const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    origLog(`  ✔ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    failed += 1;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    origLog(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function iso() {
  return new Date().toISOString();
}

function entry(overrides = {}) {
  const now = iso();
  const content = overrides.content || '用户喜欢美式咖啡';
  const id = overrides.id || `mem-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    content,
    type: 'preference',
    keywords: ['咖啡'],
    confidence: 0.9,
    status: 'active',
    userId: OWNER,
    validFrom: now,
    validTo: null,
    createdAt: now,
    updatedAt: now,
    contributions: [
      {
        sessionId: 'p6-session',
        messageId: `msg-${id}`,
        sourceQuote: content,
        createdAt: now,
        sourceType: 'user',
      },
    ],
    ...overrides,
  };
}

function seed(items) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
}

async function main() {
  seed([
    entry({
      id: 'a1',
      content: `用户喜欢美式咖啡 ${MEMORY_SENTINEL}`,
    }),
    entry({
      id: 'p1',
      content: `用户目标是在六月跑半马 ${PENDING_SENTINEL}`,
      type: 'goal',
      status: 'pending',
      pendingReason: 'single_preference_candidate',
      pendingAt: iso(),
    }),
    entry({
      id: 'other1',
      content: '另一个用户喜欢拿铁',
      userId: OTHER,
    }),
  ]);

  const { server } = require(path.join(__dirname, '..', 'server', 'index.js'));
  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve));
  }
  const base = `http://127.0.0.1:${server.address().port}`;

  async function req(urlPath, { method = 'GET', auth = true, body } = {}) {
    const response = await fetch(base + urlPath, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Connection: 'close',
        ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
      json = await response.json();
    } catch (_) {
      /* ignore */
    }
    return { status: response.status, json };
  }

  const confirmRes = await req('/profile/feedback', {
    method: 'POST',
    body: {
      action: 'confirm',
      id: 'p1',
      feedbackId: 'fb-audit-confirm',
    },
  });
  check(
    'confirm 返回 200',
    confirmRes.status === 200 && confirmRes.json?.ok === true,
    `status=${confirmRes.status}`
  );

  const correctRes = await req('/profile/feedback', {
    method: 'POST',
    body: {
      action: 'correct',
      id: 'a1',
      feedbackId: 'fb-audit-correct',
      content: `用户喜欢拿铁咖啡 ${CORRECTED_SENTINEL}`,
    },
  });
  check(
    'correct 返回 200 并生成新版本',
    correctRes.status === 200 &&
      correctRes.json?.ok === true &&
      correctRes.json?.result?.supersededId === 'a1',
    `status=${correctRes.status}`
  );

  const foreignRes = await req('/profile/feedback', {
    method: 'POST',
    body: {
      action: 'deny',
      id: 'other1',
      feedbackId: 'fb-audit-foreign',
    },
  });
  check(
    '跨用户 deny 返回 403',
    foreignRes.status === 403 && foreignRes.json?.code === 'forbidden',
    `status=${foreignRes.status}`
  );

  const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const to = new Date(Date.now() + 60 * 1000).toISOString();
  let audit = null;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await req(
      `/monitoring/audit?from=${encodeURIComponent(from)}&to=${encodeURIComponent(
        to
      )}&limit=100`
    );
    const items = (response.json?.items || []).filter(
      item => item.action === 'profile.feedback'
    );
    if (response.status === 200 && items.length >= 3) {
      audit = { ...response.json, items };
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  const governance = audit?.items || [];
  check(
    '审计接口返回 3 条 profile.feedback',
    governance.length >= 3,
    `count=${governance.length}`
  );
  check(
    '成功反馈记为 success 且原因包含 confirm/correct',
    governance.some(
      item => item.result === 'success' && item.reason === 'confirm'
    ) &&
      governance.some(
        item => item.result === 'success' && item.reason === 'correct'
      )
  );
  check(
    '跨用户拒绝记为 denied/forbidden',
    governance.some(
      item => item.result === 'denied' && item.reason === 'forbidden'
    )
  );
  const auditText = JSON.stringify(governance);
  check(
    '审计不包含记忆正文/待确认正文/更正内容',
    !auditText.includes(MEMORY_SENTINEL) &&
      !auditText.includes(PENDING_SENTINEL) &&
      !auditText.includes(CORRECTED_SENTINEL)
  );

  const noAuth = await req(
    `/monitoring/audit?from=${encodeURIComponent(from)}&to=${encodeURIComponent(
      to
    )}`,
    { auth: false }
  );
  check('审计接口需要鉴权', noAuth.status === 401, `status=${noAuth.status}`);

  const profileRes = await req('/profile');
  const profileData = profileRes.json?.profile;
  check(
    '反馈后画像反映 active 纠正结果且 pending 清空',
    profileRes.status === 200 &&
      profileData?.pending?.length === 0 &&
      profileData?.sections?.preferences?.some(item =>
        String(item.content).includes(CORRECTED_SENTINEL)
      ) &&
      !profileData?.sections?.preferences?.some(item =>
        String(item.content).includes(MEMORY_SENTINEL)
      )
  );

  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => setTimeout(resolve, 150));

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* Windows 上可能仍有句柄，不影响结论 */
  }

  console.log = origLog;
  console.error = origErr;
  origLog(`\nP6 audit: ${passed} passed, ${failed} failed`);
  if (failed) {
    origLog('Failures:');
    for (const item of failures) origLog(`  - ${item}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(error => {
  console.log = origLog;
  console.error = origErr;
  origErr('P6 audit test error:', error);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
