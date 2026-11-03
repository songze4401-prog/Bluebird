# P5 可追溯画像与反馈

日期：2026-11-03
模块：`server/profile.js`、`server/memory.js`、`GET /profile`、`POST /profile/feedback`

## 1. 画像是什么

画像不是第二份存储，而是 `memory.json` 的派生视图：每次 `GET /profile` 都从
长期记忆重新计算，**没有独立的画像缓存**，因此不存在“画像与记忆不一致”的
漂移状态。响应里的 `digest`（`sha256-profile-v1`）覆盖全部条目的身份、状态、
正文、类型、置信度、有效期、来源贡献、反馈历史与生命周期；重启后重新计算
digest 不变，任何一次反馈成功后 digest 改变。

每个条目返回：

- `memoryId` / `content` / `type` / `category` / `status` / `confidence`；
- `sources`：每条来源贡献的 `sessionId`、`messageId`、原话 `sourceQuote`、
  时间与来源类型；`sourceCount` / `independentSessions`；
- `provenance` / `policyVersion` / `decisionVersion` / `evidence`；
- `feedback`：确认次数、最近确认时间、`lastDecision`、最多 20 条
  `feedbackHistory`（只含动作/原因短码/时间/feedbackId，不含正文）；
- `supersedes` / `supersededBy`、`withdrawnAt` / `withdrawnReason`。

按类型分为 `identity`（身份）、`preferences`（偏好）、`goals`（目标）、
`relationships`（关系）、`facts`（事实）与 `other`。pending 与 contested
不混入当前分节，分别在 `pending` / `contested` 中展示；`includeInactive=1`
时再返回 superseded / archived / expired 的 `inactive` 列表与原因。

## 2. API

### GET /profile

- Bearer 鉴权；用户身份来自服务端 `BLUEBIRD_USER_ID`，不接受客户端 userId。
- `?includeInactive=1|true` 返回历史条目；`0|false`/缺省只看当前。
- `Cache-Control: no-store`；返回 `{ profile }`。

### POST /profile/feedback

请求体：

```json
{
  "action": "confirm | deny | correct",
  "id": "mem-...",
  "feedbackId": "可选，幂等键，最多 120 字符的安全字符",
  "reason": "可选，安全短码，最多 80 字符",
  "content": "correct 必填，最多 100 字",
  "type": "可选，identity/preference/fact/goal/relationship",
  "keywords": ["可选，最多 5 个字符串"],
  "confidence": 0.95
}
```

成功返回 `{ ok: true, action, feedbackId, result, profile }`，其中 `profile`
是反馈后的当前画像。`feedbackId` 缺省会生成并返回；同一 `feedbackId` 重复提交
返回 `duplicate: true`，不会重复写入。

`reason` 只接受安全短码（字母/数字/`._:-`），默认 `user_denied`；它用于审计
与画像展示，不作为新的用户正文存储。

## 3. 三个动作的真实语义

### confirm

- pending：走 `confirmPending`，晋升 active；若候选带 `pendingTargetId` /
  `pendingMutation`，复用既有更新/替代逻辑；`confirmationCount` +1，
  `feedbackId` 写入 `lastDecision` 与 `feedbackHistory`。
- active：只增加确认证据（`confirmationCount`、`lastConfirmedAt`、
  `feedbackHistory`），不改正文、不新建条目。
- contested：用户选择旧条目为正确一方：该条目转为 active，挑战它的 pending
  候选归档；同一 pending 的 `contestedIds` 中其余 contested 条目也归档。

### deny

- pending / active / contested → archived，写 `withdrawnAt`、
  `withdrawnReason`、`lastDecision` 与 `feedbackHistory`。
- 保留贡献与历史（不物理删除），因此 `includeInactive` 能追溯“被否认过”。
- 为旧来源写墓碑；异步抽取使用同一 `messageId` 时返回 `deleted_source`，
  不能把被否认的事实复活。
- 重复同一 `feedbackId` 返回 `duplicate: true`。

### correct

- 新建一条 active 条目，旧条目 active/contested → superseded，
  pending → archived（`archivedReason=corrected_by_profile_feedback`）。
- 新条目保留旧条目的全部来源贡献，并追加一条
  `messageId=feedback:<feedbackId>`、`sourceQuote=更正后内容` 的贡献；因此
  “改前是什么、谁说的、改后是什么”都可追溯。
- 旧来源写墓碑；异步抽取不能复活被纠正掉的旧事实。
- 重复同一 `feedbackId` 返回已创建的新条目，不重复写入。
- `content` 为空、超过 100 字、命中敏感模式、类型非法、置信度越界或与原内容
  完全相同，分别返回稳定短码（400/409），不修改记忆。

## 4. 隐私与边界

- 画像响应只返回给已认证的实例用户；来源原话属于用户自己的数据。
- 反馈历史/审计只记录动作、原因短码、feedbackId、时间与条目 ID，不记录
  正文；`feedbackHistory` 不含 `sourceQuote`。
- 画像没有独立文件，也不生成“模型总结画像”；它只展示可追溯的结构化记忆。
  画像不改变现有 Context Runtime 的记忆注入路径，本轮不把画像作为新的
  system block 注入；它是可审计的读取视图与反馈入口。
- 旧条目可能没有 `messageId`，此时来源只能追到 `sessionId` + 原话；墓碑仍按
  短窗口的来源哈希保护。
- 过期但仍 active 的条目不计入当前分节；`includeInactive=1` 以 `expired` 展示。
- 单用户部署：`userId` 来自服务端可信身份；跨用户反馈返回 403，画像不包含
  他人条目。
- 当前 `/profile` 是 API-only，没有前端画像页面；界面入口属于 P6。

## 5. 验证

```bash
node tests/profile-p5.test.js
```

44 项检查覆盖：五类分节、来源贡献、digest 重建、pending/contested 分离、
confirm（pending/active/contested）、deny（active/pending、墓碑、重启）、
correct（active/pending、来源追加、旧来源防复活、幂等）、输入校验、用户隔离、
反馈历史隐私与 HTTP 鉴权/错误码。测试使用独立临时目录，不读写 `server/data`。
