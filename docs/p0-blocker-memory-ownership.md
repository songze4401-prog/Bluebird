# 阻断项处理：记忆接口的用户归属校验

> 来源：`docs/p2-memory-observability.md` §8「🔴 P0 阻断项（多用户上线前必须解决）」
> 关联：`docs/p1-user-scoped-memory.md`（用户级读作用域）、`ARCHITECTURE.md` §6

- 处理日期：2026-11-02
- 范围：只给记忆管理接口补归属校验。**不**引入多用户认证（按约束本轮不扩展）。

---

## 1. 问题原状

长期记忆的**检索**读路径在 P1 已改为用户级（`visibility:'user'` + 可信 `userId`），但**管理接口**仍是全库语义：

| 接口 | 处理前 |
|---|---|
| `GET /memory` | 返回库内全部记忆（含所有用户的） |
| `GET /memory/pending` | 返回全部待确认候选 |
| `POST /memory/delete` | 按 id 直接删，不校验归属 |
| `POST /memory/archive` / `confirm` / `reject` | 按 id 直接改，不校验归属 |
| `POST /memory/clear` | 清空整库 |
| `POST /memory/clear-session` | 按 sessionId 摘贡献，不校验归属 |
| Memory Bot 审批执行器（`memory-service.execute`） | 按 id 执行 update/merge/supersede/archive/withdraw/delete，不校验归属 |

单用户部署下全库 == 本人，所以看不出问题；一旦接入真实多用户，**任意已认证用户都能读取、修改、删除他人的记忆**。

---

## 2. 修复设计

### 2.1 一个判断函数，读写共用

`server/memory.js` 新增：

```js
function ownerAllows(item, userId) {
  const owner = cleanText(userId);
  if (!owner) return true;                                  // 内部调用：不限制（保持既有行为）
  return cleanText(item && item.userId) === owner;          // 外部请求：必须一致
}
```

> 空 `userId` 不限制是「兼容内部调用」，**不是**「放行外部请求」。HTTP 层必须显式传 `resolveUserId(req)`，不得省略。

### 2.2 读：按归属过滤，无身份返回空

```js
getMemoriesForUser(userId, options)   // userId 为空 → []（fail-closed，绝不退回全库）
getPendingMemoriesForUser(userId)     // 同上
```

### 2.3 写：变更前预检，不匹配即拒绝

`checkMemoryOwnership(id, userId)` 返回 `{ ok, reason }`（`invalid` / `not-found` / `forbidden`），供接口与审批执行器在**执行动作之前**判断。

各变更函数新增可选 `userId` 参数（不传则保持既有行为，兼容测试与内部调用）：

| 函数 | 新增参数 | 归属不符时 |
|---|---|---|
| `deleteMemory({ id, createdAt, content, userId })` | `userId` | `{ removed: 0, reason: 'forbidden' }` |
| `archiveMemory(id, userId)` | `userId` | `{ updated: 0, reason: 'forbidden' }` |
| `confirmPending(id, userId)` | `userId` | `{ updated: 0, reason: 'forbidden' }` |
| `rejectPending(id, userId)` | `userId` | `{ removed: 0, reason: 'forbidden' }` |
| `clearMemories(userId)` | `userId` | 只清该用户名下条目，其余保留 |
| `clearSessionMemories(sessionId, userId)` | `userId` | 不属于该用户的条目原样保留 |

### 2.4 HTTP 层：全部传可信身份

9 个记忆接口中，7 个涉及用户数据，均已接 `resolveUserId(req)`：

| 接口 | 改动 |
|---|---|
| `GET /memory`（含 `?scope=all`） | 改用 `getMemoriesForUser(userId, options)` |
| `GET /memory/pending` | 改用 `getPendingMemoriesForUser(userId)` |
| `POST /memory/delete` | 传 `userId`；`forbidden` → **403** |
| `POST /memory/archive` / `confirm` / `reject` | 经 `lifecycleWriteResponse` 传 `userId`；`forbidden` → **403** |
| `POST /memory/clear` | 传 `userId`，只清本人 |
| `POST /memory/clear-session` | 传 `userId`，不越界摘他人贡献 |
| `GET /memory/write-attempts` | **未改**（见 §5 残留） |

### 2.5 审批执行器

`memory-service.execute(operation, payload, { userId })` 在执行前做归属预检；`agents/approvals.js` 调用时传 `getInstanceUserId()`。越权目标返回 `{ ok:false, reason:'forbidden' }`，审批记录落 `errorCode`。

预检覆盖载荷里**全部**被引用的记忆 id，不只是 `id`：`update/supersede/archive/withdraw/delete` 看 `id`，`merge` 额外逐个看 `targetId` 与 `sourceIds[]`。只校验 `id` 的话，一条合法目标配上他人的 `sourceIds` 就能把他人记忆吞并掉——所以 merge 是**整体拒绝**，不做「跳过他人那条、只合本人那几条」的部分执行；部分执行会让审批记录显示完成、库里却少了一条本不该动的记忆，比拒绝更难排查。

---

## 3. 为什么越权返回 403 而不是 404

两个选项都能防住泄漏，但语义不同：

- **404**：不暴露「这条记忆是否存在」，防枚举。
- **403**：明确告诉调用方「无权」，越权尝试在审计与日志里可识别。

这里选 **403**，理由：记忆 id 是 UUID（`mem_` / 内容哈希派生），不具备可枚举性；而「无权」与「不存在」在排查时是两类完全不同的问题，混成 404 会让前端反复重试、也让越权尝试看起来像普通失败。审计里已记录 `result: 'denied', reason: 'forbidden'`。

---

## 4. 验证

`node tests/memory-ownership.test.js`（新增，29 项）

做法：**不需要多用户认证**。单实例下 `resolveUserId(req)` 恒为 `local-owner`，只要在 `memory.json` 里种一条 `userId='user-other-ownership'` 的条目，就构造出了「他人记忆」。

```
A) 读接口：只返回本人记忆
  ✔ GET /memory 只返回本人的 active 记忆
  ✔ GET /memory 不包含他人记忆
  ✔ GET /memory?scope=all 仍只返回本人（active + pending）
  ✔ GET /memory/pending 只返回本人的待确认

B) 写接口：他人的 id 一律 403 且数据不变
  ✔ POST /memory/delete 他人记忆 → 403
  ✔ 删除被拒后磁盘条目数不变
  ✔ POST /memory/archive 他人记忆 → 403
  ✔ 归档被拒后该条仍是 active
  ✔ POST /memory/confirm 他人 pending → 403
  ✔ 确认被拒后该条仍是 pending
  ✔ POST /memory/reject 他人 pending → 403

C) 清空类接口：不越界删他人数据
  ✔ POST /memory/clear-session 他人会话 → 不删除他人记忆
  ✔ 他人记忆仍在库里
  ✔ POST /memory/clear 只清本人，返回删除条数
  ✔ 清空后他人记忆完好保留
  ✔ 清空后本人记忆一条不剩

D) 模块级契约（供非 HTTP 调用方使用）
  ✔ getMemoriesForUser(空身份) 返回空数组（fail-closed）
  ✔ getMemoriesForUser(本人) 不再包含他人记忆
  ✔ getPendingMemoriesForUser(空身份) 返回空数组
  ✔ checkMemoryOwnership 他人条目 → forbidden
  ✔ checkMemoryOwnership 不存在的 id → not-found
  ✔ checkMemoryOwnership 本人条目 → ok
  ✔ memoryService.execute 他人 id → 拒绝且原因明确
  ✔ 审批执行被拒后他人记忆仍在
  ✔ memoryService.execute merge 的 sourceIds 含他人条目 → 整体拒绝
  ✔ merge 被拒后他人记忆未被吞并

E) 本人操作仍然正常（没有把功能锁死）
  ✔ 本人删除自己的记忆 → 200 且真的删掉
  ✔ clear 已清掉原有本人记忆
  ✔ 他人记忆始终未被误删

通过 29 项，失败 0 项
```

全量回归（写侧与 merge 归属补齐后复跑）：

```
node scripts/verify-test-coverage.js
→ CI runner 覆盖：66/66 个测试文件
→ backend=1924/1924 nodeSuite=221/221 runner=1703/1703
→ frontend=181/181 suites=22/22 failed=0
→ ✔ 测试覆盖验证通过
```

---

## 5. 残留与边界（如实声明）

### 5.1 本次未改的接口

| 接口 | 为什么 |
|---|---|
| `GET /memory/write-attempts` | 进程级诊断流（短码 + sessionId + 条目 id），**不含记忆正文**。它不记录 userId，无法按用户过滤；要改需先给写入记录加 userId 维度。已在此登记，不作为"已解决"。 |

### 5.2 多用户上线仍缺的前置条件

归属校验是**必要**条件，不是充分条件。接入真实多用户认证时还必须处理：

1. **`resolveUserId` 要返回真实用户**。当前恒为 `local-owner`，所以本轮所有归属检查在运行时恒真——结构正确、但未被真实多用户验证过。
2. **会话本身没有 userId 维度**。✅ 已处理：主会话已补 `userId` 并在 HTTP 层强制（见 `docs/p0-blocker-session-ownership.md`）。Bot 会话（`agents/sessions.js`）仍无用户维度。
3. **审批记录需要携带请求者 userId**。当前 `approvals.js` 传的是实例用户；多用户下应从审批记录里带出真实请求者，否则会变成"用实例身份执行别人的申请"。

### 5.3 单用户行为不变

- `GET /memory` 返回集合与改动前完全一致（所有条目 `userId` 都是 `local-owner`）；
- 删除/归档/确认/拒绝/清空对本人条目的行为不变；
- 前端（记忆中心）无需改动。

---

## 6. 修改文件

| 文件 | 改动 |
|---|---|
| `server/memory.js` | 新增 `ownerAllows` / `getMemoriesForUser` / `getPendingMemoriesForUser` / `checkMemoryOwnership`；`deleteMemory` / `archiveMemory` / `confirmPending` / `rejectPending` / `clearMemories` / `clearSessionMemories` 增加可选 `userId` |
| `server/index.js` | 7 个记忆接口接入 `resolveUserId(req)`；`forbidden` → 403；导入改为 `*ForUser` 版本 |
| `server/memory-service.js` | `execute(operation, payload, { userId })` 增加归属预检，逐个校验 `id` / `targetId` / `sourceIds[]`；merge 命中他人条目时整体拒绝，不做部分执行 |
| `server/agents/approvals.js` | 审批执行时传 `getInstanceUserId()` |
| `tests/memory-ownership.test.js` | 新增（29 项） |
| `scripts/test-coverage-baseline.json` / `scripts/sync-doc-counts.js` | 登记新测试与说明 |
| `ARCHITECTURE.md` / `docs/p2-memory-observability.md` | 阻断项状态更新为「已处理」并指向本文 |
