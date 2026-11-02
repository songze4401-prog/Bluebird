# 阻断项处理：会话归属维度

> 来源：`docs/p0-blocker-memory-ownership.md` §5.2「多用户上线仍缺的前置条件」第 2 条
> 关联：`ARCHITECTURE.md` §6「用户边界」

- 处理日期：2026-11-02
- 范围：给主会话补 `userId` 维度并在 HTTP 层强制。**不**引入多用户认证。

---

## 1. 问题原状

会话存储只有 `{ id, title, createdAt, updatedAt }`，**没有归属**。因此：

```
GET /history?sessionId=X     # 知道 id 就能读别人的聊天记录
GET /sessions                # 列出所有人的会话
DELETE /sessions/:id         # 知道 id 就能删
```

`ARCHITECTURE.md` §6 早就记录了「任意 Bearer 可访问任意 sessionId」，但在记忆接口补齐归属后，会话成了最后一块没有归属维度的用户数据。

---

## 2. 修复设计

### 2.1 会话元数据加 `userId`

`server/sessions.js`：

- `sanitizeStore`：读盘时为缺失 `userId` 的会话补实例用户（幂等迁移，旧数据不丢）；
- `createSession({ title, userId })`：新会话盖章，不传则归实例用户；
- `ensureDefaultSession` / 旧历史迁移：默认会话也带 `userId`。

### 2.2 两个判断函数

```js
sessionOwnerAllows(meta, userId)      // 空 userId 不限制（内部调用），否则必须一致
checkSessionOwnership(sessionId, userId)  // { ok, reason: 'invalid'|'not-found'|'forbidden' }
getSessionForUser(sessionId, userId)      // 无权与不存在同形，都返回 null
```

`listSessions(userId)` 也加了可选参数：传了就只列本人的，不传保持旧行为（内部索引/兼容调用）。

> 空 `userId` 不限制是「兼容内部调用」，不是「放行外部请求」。HTTP 层必须显式传 `resolveUserId(req)`。

### 2.3 接口逐条

| 接口 | 处理 |
|---|---|
| `GET /sessions` | `listSessions(resolveUserId(req))`，只列本人 |
| `POST /sessions` | 新建时写入归属用户 |
| `GET /sessions/:id` | `getSessionForUser`，他人 → 404 |
| `DELETE /sessions/:id` | `checkSessionOwnership` 前置，他人 → 404 且不删；审计记 `denied` |
| `GET /history` | `getSessionForUser`，他人 → 404 |
| `POST /history/clear` | 同上，他人 → 404 且消息不动 |
| `POST /history/recall` | 同上，他人 → 404 且消息不动 |
| `GET /presence` | 同上 |
| `POST /presence/report` | 只有本人会话才接受上报，否则 `sessionId` 置空 |
| `POST /chat` / `/chat/stream` | `prepareChatRequest` 前置校验，他人 → 404 |
| `POST /retrieval/search` | 他人会话 → 404 `session_missing` |
| `POST /memory/clear-session` | **不**要求会话存在（见 §4），靠 `clearSessionMemories(sessionId, userId)` 只摘本人贡献 |

---

## 3. 为什么会话用 404，而记忆用 403

两个面刻意不同：

| | 记忆接口 | 会话接口 |
|---|---|---|
| 越权响应 | **403** `forbidden` | **404** `会话不存在` |
| 理由 | 记忆是管理面，越权应在审计与日志里可识别；id 是 UUID，不可枚举 | 会话是客户端状态面，前端已有「404 → 会话不存在」的处理分支；返回 404 不泄露「这个 id 存在但不属于你」 |

两者都在审计里记录了 `result: 'denied'`，只是对外响应不同。

---

## 4. 一个刻意的例外：`clear-session` 不要求会话存在

长期记忆比会话活得久——删了会话，它沉淀的记忆仍在库里。如果 `clear-session` 要求会话必须存在，用户就再也清理不掉这些记忆。

真正的边界是「只摘本人名下的贡献」，由 `clearSessionMemories(sessionId, userId)` 保证：不属于该用户的条目原样保留。所以这里不做会话存在性校验，只做归属过滤。

---

## 5. 验证

`node tests/session-ownership.test.js`（新增，28 项）

做法：种一个 `userId='user-other-session'` 的会话 + 消息，然后用实例身份访问。

```
A) 读接口：只返回本人会话
  ✔ GET /sessions 只列本人会话
  ✔ GET /sessions 不泄露他人会话标题
  ✔ GET /sessions/:id 本人 → 200
  ✔ GET /sessions/:id 他人 → 404（不泄露存在性）
  ✔ GET /history 本人 → 200 且含本人内容
  ✔ GET /history 他人 → 404
  ✔ 他人会话内容不出现在任何响应里
  ✔ GET /presence 本人 → 200
  ✔ GET /presence 他人 → 404

B) 写接口：他人会话一律拒绝且数据不变
  ✔ POST /history/clear 他人会话 → 404
  ✔ 他人会话消息未被清空
  ✔ POST /history/recall 他人会话 → 404
  ✔ 他人会话消息未被撤回
  ✔ POST /chat 他人会话 → 404
  ✔ POST /chat/stream 他人会话 → 404
  ✔ POST /retrieval/search 他人会话 → 404 session_missing
  ✔ DELETE /sessions/:id 他人会话 → 404
  ✔ 他人会话未被删除

C) 本人操作仍然正常（没有把功能锁死）
  ✔ POST /history/clear 本人会话 → 200 且清空
  ✔ POST /sessions 成功且返回 id
  ✔ 新建会话带上归属用户
  ✔ DELETE 本人会话 → 200

D) 模块级契约
  ✔ listSessions(本人) 只返回本人会话
  ✔ listSessions() 不传身份时保持旧行为（内部索引用）
  ✔ checkSessionOwnership 他人会话 → forbidden
  ✔ checkSessionOwnership 不存在 → not-found
  ✔ checkSessionOwnership 本人会话 → ok
  ✔ 旧数据没有 userId 的会话迁移为实例用户

通过 28 项，失败 0 项
```

全量回归：`verify-test-coverage.js` → 66/66 文件、1916 项通过。

---

## 6. 残留与边界

### 6.1 本轮未处理

| 项 | 说明 |
|---|---|
| **Bot 会话（`agents/sessions.js`）没有用户维度** | 它有 `scope`（direct/worker）与 worker 的 `owner.taskId`，但没有 `userId`。多用户下两个用户和同一个 Bot 聊天会共享会话列表。这是独立子系统（牵动 agent runtime / task store / approvals），未纳入本轮。 |
| **`DEFAULT_SESSION_ID` 是实例级** | 不传 `sessionId` 时落到 `default`，它属于实例用户。多用户下需要「每用户一个默认会话」，否则会变成共享桶。 |
| **retrieval 内部索引仍是全量** | `syncConversations` 遍历所有会话建索引（服务端内部行为，不对外返回）；检索入口已按归属校验。 |

### 6.2 多用户上线仍缺

1. `resolveUserId` 要返回真实用户（当前恒为 `local-owner`，所有归属检查运行时恒真）；
2. 上面 6.1 的三项；
3. 审批记录携带请求者 `userId`（见 `docs/p0-blocker-memory-ownership.md` §5.2）。

### 6.3 单用户行为不变

- `GET /sessions` 返回集合与改动前一致（所有会话 `userId` 都是 `local-owner`）；
- 所有会话操作的响应码与行为不变（本人永远通过）；
- 前端无需改动。

---

## 7. 修改文件

| 文件 | 改动 |
|---|---|
| `server/sessions.js` | 元数据加 `userId`（读盘迁移 + 新建盖章 + 默认会话）；新增 `sessionOwnerAllows` / `checkSessionOwnership` / `getSessionForUser`；`listSessions(userId)` |
| `server/index.js` | 11 个会话相关入口接入归属校验 |
| `server/retrieval/routes.js` | `POST /retrieval/search` 的 sessionId 改归属感知 |
| `tests/session-ownership.test.js` | 新增（28 项） |
| `scripts/test-coverage-baseline.json` / `scripts/sync-doc-counts.js` | 登记新测试 |
| `ARCHITECTURE.md` | §6 用户边界更新 |
