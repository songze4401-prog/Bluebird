/**
 * W0 回归基线：跨轮状态 / 完成校验的已知缺口。
 *
 * 这三个用例是 W1/W2 的验收目标，当前以 todo 形式登记，避免把故意失败的
 * 测试带进 main；真正的“红”证据由 `npm run audit:agent -- --run` 输出。
 *
 * 转绿方式：
 *  - W2 收紧 readback 正则后，把 A1 改成 assert.equal(requiresReadBack(...), false)；
 *  - W2 让 Claim Guard 覆盖零工具声明后，把 B2 改成 assert.notEqual(detectClaimMismatch(...), null)；
 *  - W2 扩展失败词表后，把 F2 改成 assert.notEqual(detectClaimMismatch(...), null)。
 */
const test = require('node:test');

test.todo('A1: 写入指令“内容……确认”不应被判定为读回要求（W2 目标）');
test.todo('B2: 无工具调用却声称文件已创建，必须产生 no_receipt 不匹配（W2 目标）');
test.todo('F2: 成功工具回执被描述为“没拿到回执”，必须产生 failure_claim 不匹配（W2 目标）');
