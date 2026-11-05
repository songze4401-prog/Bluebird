# §16 真实模型传播覆盖率补验（2026-11-05）

> **真实模型环境。**
> Provider：LongCat `https://api.longcat.chat/openai`，模型 `LongCat-2.5`。
> 凭据仅在运行期间从 `server/.env`（`.gitignore` 覆盖）读取，运行结束即删除；本记录不含凭据明文或片段。
> 本记录只写实跑命中/未命中，不使用「应该会传播」这类推断。

- 运行脚本：`node scripts/run-taint-propagation-realmodel.js --out docs/e2e-taint-propagation-2026-11-05.json`
- 机器可读记录：`docs/e2e-taint-propagation-2026-11-05.json`
- 运行时间：`2026-11-05T16:09:21.402Z` 起，`2026-11-05T16:09:59.732Z` 止，整轮 **38,330 ms**
- 结果：`outcome=passed`，五项检查全部命中

## 链路

1. **上游任务**（`researcher`，真实模型）：产出带 `sourceLabels: ['web:vendor-a.example']` 的 `note` 产物。
2. **下游任务**（`memory`，真实模型）：通过 Worker Scope `readSharedArtifact` 读取上游共享产物 → `provenanceRefs` 追加到任务 → 模型基于该结论产出 `summary` 派生产物。
3. **生产者清除尝试**：以 `writer: 'producer'` 清除派生产物 `taintLabels`。
4. **Gateway 断裂**：新建任务，来源引用指向不存在的 `note`，允许工具 `memory_search`；真实模型发起工具调用。

## 命中 / 未命中

| 检查点 | 期望 | 实跑结果 | 判定 |
| --- | --- | --- | --- |
| `provenanceRefs` 真实生成 | 读取上游产物后，下游任务 `provenanceRefs` 出现钉住 version 的引用 | `beforeRead=[]` → `afterRead=[{kind:note,id:art_4acda03175c5d255608533d8cfc5ab28,version:1}]`；追加事件 `evt_023f80fc-c04f-402d-b729-9160dc219e3b`（`worker.readSharedArtifact`，`added=1`） | **命中** |
| 任务级 taint 继承 | 下游任务 taint 包含上游 `web:vendor-a.example` | `['unverified','web:vendor-a.example']` | **命中** |
| 派生产物 taint 并集 | 上游 ∪ `agent:derived` ∪ `unverified` | `['agent:derived','unverified','web:vendor-a.example']`，上游 `['unverified','web:vendor-a.example']` | **命中** |
| Producer 清除被拒 | 403 `not_authorized`、标签不变、写审计 | `403 / not_authorized`；清除前后标签完全一致；审计 `artifact.taint_write_rejected`，`reason=not_authorized\|writer:producer` | **命中** |
| Gateway 断裂 fail-closed（真实模型调用路径） | 真实模型发起 `memory_search`，Gateway 以 `taint_provenance_broken` 拒绝 | 模型第 1 轮 `finishReason=tool_calls`（`memory_search`）；`tool.denied`：`tool=memory_search, errorCode=taint_provenance_broken, detail=artifact_chain_broken`；任务 `completed` | **命中** |

## 产物与来源链

| 产物 | 引用 | taintLabels |
| --- | --- | --- |
| 上游 note | `art_4acda03175c5d255608533d8cfc5ab28@1` | `unverified`, `web:vendor-a.example` |
| 派生 summary | `art_615f7b9c7e58352946a5e923c4a1f0e0@1` | `agent:derived`, `unverified`, `web:vendor-a.example` |

- 上游任务：`task_03838430-e8a3-4960-aa16-b553b20e5f74`（completed）
- 下游任务：`task_701b6e83-32f8-4a2d-9c2b-6e340a96b6ab`（completed）
- Gateway 任务：`task_0dac8b42-17db-4cd4-9720-e6b9a3aa2837`（completed）

## Token / 延迟 / 成本

| 阶段 | prompt_tokens | completion_tokens | total_tokens | 延迟 |
| --- | --- | --- | --- | --- |
| 上游 | 327 | 316 | 643 | 7,429 ms |
| 下游 | 326 | 729 | 1,055 | 13,601 ms |
| Gateway | 1,760 | 928 | 2,688 | 17,171 ms |
| **合计** | — | — | **4,386** | 38,201 ms（任务级合计）；整轮 38,330 ms |

- Token 口径：provider 返回的 `usage`，未做字符估算。
- 成本：LongCat 响应未返回计价字段，记「provider 未返回」，不估算。

## 仍未覆盖（继续按未验证处理）

- **跨进程隔离**：本次在同一进程内验证传播与断裂；跨进程锁不在 §16 本轮范围。
- **Verification Engine 改写 taint（`markTaintVerified`）**：本次只验证生产者清除被拒；验证路径的解除/降级未在真实模型链路中触发。
- **Gateway 断裂的其它断链形态**：本次命中 `invalid_ref` 类（不存在 id → `artifact_chain_broken`）；`version_mismatch` / `invalidated` / `stale` / `cycle` 未逐项在真实模型路径上触发。
- **`resolveProvenance` 深度上限（>3）**：本次来源链深度为 1，未触达深度拒绝分支。

## 可复核方式

1. 打开 `docs/e2e-taint-propagation-2026-11-05.json`，按 `checks.*` 核对 `beforeRead/afterRead`、taint 数组、审计条目、`tool.denied` 事件。
2. 复跑（需本机 `server/.env` 中有 LongCat 凭据；跑完删除）：
   `node scripts/run-taint-propagation-realmodel.js --out <临时路径>`
3. 不依赖模型的既有回归：
   `node --test tests/agent-taint-policy.test.js`
