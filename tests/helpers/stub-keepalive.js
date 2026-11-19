'use strict';

/**
 * 本地 provider/API stub 服务器的 keep-alive 收口（#88 竞态根治家族；
 * 2026-11-19 健康度审计后从 24 个测试文件抽成共享 helper）。
 *
 * openai SDK 以 maxRetries:0 + keep-alive 连接池工作：本地 stub 默认
 * keepAliveTimeout（Node 默认 5s）会在测试间隙掐死池中空闲连接，SDK 复用死
 * socket 即 model_connection 失败或请求悬挂（全量跑里曾表现为 120s 被
 * spawnSync 击杀）。统一把 stub 服务器空闲超时抬到 30s，远超任何测试间隙。
 * 另一个已实证的受害面：主 API server 的 keep-alive 连接在子测试空窗
 * （waitForTask 轮询、退避等待等 >5s）同样会被掐死，api() 复用死 socket 时
 * undici 偶发请求悬挂——所以 provider 桩与主 API server 都要过本 helper。
 *
 * 历史案例锚点（细节见各自文档/REPAIR_ROADMAP）：
 *   - memory-bot/agent-worker 偶发：model_connection 失败 → 排队任务退避
 *     retrying → 其余任务完成后无人再触发调度 → 队列卡死（#88 根因链）；
 *   - agent-dispatch SSE 偶发（REPAIR_ROADMAP §6.7 记录），与本修复同族；
 *   - agent-publish-gate 2026-11-15 全量跑：b+c 被外部卡顿拖到 7.6s，
 *     d 的模型调用复用死 socket，任务进门之前就被收口 failed。
 *
 * 用法（stub 服务器创建后、listen 前后皆可，返回原服务器可链式）：
 *   const { applyStubKeepAlive } = require('./helpers/stub-keepalive');
 *   const server = http.createServer(app);
 *   applyStubKeepAlive(server);
 *
 * 新增带本地 stub 的测试一律经此 helper 设置，不要再手写数字。
 */
const STUB_KEEP_ALIVE_TIMEOUT_MS = 30000;

function applyStubKeepAlive(server) {
  // 故意不做静默守卫：传错变量名/传了 undefined 时必须当场炸——
  // 静默 no-op 会让 stub 以 Node 默认 5s 运行，恰是本 helper 要根除的偶发竞态，
  // 且以「偶发 flake」而非「明确报错」的形式回归（2026-11-19 oracle 复查定级）。
  if (!server || typeof server !== 'object') {
    throw new TypeError(
      'applyStubKeepAlive 需要一个 stub 服务器实例（http.createServer 的返回值）；' +
        '收到 ' + (server === null ? 'null' : typeof server)
    );
  }
  server.keepAliveTimeout = STUB_KEEP_ALIVE_TIMEOUT_MS;
  return server;
}

module.exports = { applyStubKeepAlive, STUB_KEEP_ALIVE_TIMEOUT_MS };
