# Agent Runtime 四期：独立 Watchdog 与受控自愈

状态：已实现（2026-11-01），分支 `qoder/agent-runtime-stage4-2026-11-01`（基于三期，未合并）。
范围：Notion《Bluebird 下一代 Agent Runtime》「阶段 4：独立 Watchdog 与受控自愈」。
配套代码：`server/agents/watchdog-policy.js`、`server/agents/intake-control.js`、`scripts/bluebird-watchdog.js`、`scripts/bluebird-supervisor.js`、`server/agents/router.js`。

## 1. 目标与非目标

**目标**：建立不依赖业务进程存活的监督与受控恢复：Watchdog 由外部进程周期运行，Supervisor 负责拉起/重启主服务；动作限定在白名单内，有次数上限、冷却与熔断，失败升级人工；所有动作可审计。

**本期不做**：不在仓库里安装操作系统计划任务/NSSM/systemd（部署方接入，模板见 §6）；不做模型驱动的自愈；不做进程内 Worker 级强杀（Worker 与服务同进程，终止失效 Worker 等价于重启服务）。

## 2. 架构决策记录（ADR）

### ADR-01：Watchdog 与 Supervisor 都是进程外组件

- `scripts/bluebird-watchdog.js`：单次执行的 CLI（`node scripts/bluebird-watchdog.js [--dry-run]`），由计划任务/外部调度每分钟拉起；退出码 `2` 表示出现人工升级。
- `scripts/bluebird-supervisor.js`：长期运行的外部 Supervisor，`spawn` 主服务；子进程退出后按退避重启；窗口内超过 `BLUEBIRD_SUPERVISOR_MAX_RESTARTS` 次即升级人工并退出码 `3`，不会无限重启。
- 二者都不依赖业务进程内的 `setInterval`，也不导入模型 SDK。

### ADR-02：监控项与判定

`watchdog-policy.evaluate(snapshot)` 的输入全部来自数据目录与进程信息，不调用业务 API：

| 监控项 | 数据源 | 判定 |
| --- | --- | --- |
| Worker 心跳 / 租约 | `agent-tasks.json` 的 `heartbeatAt` / `lease.expiresAt` | 超过阈值或租约过期 → critical |
| 服务存活 | `<DATA_DIR>/.bluebird.lock` 的 pid + `process.kill(pid,0)` | 锁缺失/pid 不存在 → `service_down` |
| 队列积压 / 最老排队 | 任务 `status=queued` | 数量或最老 `createdAt` 超阈值 → critical |
| 存储健康 | Task Store 能否读取 | 解析/结构失败 → `store_unreadable` |
| 磁盘压力 | `fs.statfsSync(DATA_DIR)` | 可用空间低于阈值 → `disk_low` |
| 结果投递失败 | `deliveryStatus=failed` 且有父会话 | warn（告警，不暂停接单） |

### ADR-03：确定性动作、白名单、冷却与熔断

- 动作白名单：`alert`、`pause_intake`、`resume_intake`、`recover_interrupted`、`restart_service`、`escalate_manual`。
- 每个动作在 `windowMs`（默认 10 分钟）内最多执行 `maxAttempts`（默认 3）次，且两次之间至少间隔 `cooldownMs`（默认 60 秒）。达到上限 → `escalate_manual`（写 `escalations.jsonl`），不继续重试。
- `restart_service` 默认关闭，且只在部署方显式配置 `BLUEBIRD_WATCHDOG_RESTART_CMD` 时执行；命令来自部署配置，**不接受模型生成的任何命令**。
- `store_unreadable` / `disk_low` 属于不可安全恢复：只告警并升级人工，不写任务文件。
- 熔断状态持久化在 `agents/watchdog/state.json`，跨进程重启仍生效。

### ADR-04：暂停接单是写入数据目录的信号

- Watchdog 在 critical 时写 `<DATA_DIR>/agents/intake-pause.json`；恢复健康后删除。
- Router 每次 `dispatch` 前读取该文件，暂停时返回 `agent_intake_paused`（503），并提示原因；已在运行的任务不受影响。
- 文件不存在或损坏按“未暂停”处理，避免监督组件故障导致永久停摆。

### ADR-05：离线恢复只在服务确认停机时执行

- Watchdog 只在 `.bluebird.lock` 缺失或 pid 已不存在时才调用 `tasks.recoverInterrupted` 与 `resultDelivery.recoverPending`，确保同一时刻只有一个写者。
- 恢复语义沿用三期：只读任务重排队；含 `memory_remember` 的任务标记 `uncertain`；`waiting_approval` 保持暂停。无法安全恢复的任务进入人工处理，不伪装成功。
- 服务存活时只告警/暂停接单，绝不跨进程改任务状态。

## 3. 审计

每个动作写一行 JSONL 到 `agents/watchdog/watchdog.jsonl`，Supervisor 写 `agents/watchdog/supervisor.jsonl`，人工升级额外写 `escalations.jsonl`：

```
{ ts, release, watchdog|supervisor:{pid,startedAt}, action, reason, code,
  taskIds, runIds, result, breaker:{attempts,cooldownActive,open} }
```

`release` 读取 `package.json` 版本；`taskIds/runIds` 只记录稳定 ID，不记录 task 正文。

## 4. 演练与测试证据（2026-11-01 实跑）

`node tests/agent-watchdog.test.js`：26 项通过，覆盖：

- 健康分类：心跳/租约过期、队列积压与最老排队、存储不可读、磁盘不足、服务停机（无锁/残留锁）、投递失败（warn）。
- 动作计划：critical → 告警 + 暂停接单；健康 → 恢复接单；服务停机 → 恢复；服务存活 → 不跨进程恢复；重启仅在命令配置且动作开启时；冷却与熔断；不可恢复项直接升级人工。
- 实跑：服务停机 + 租约过期 → 只读任务重排队并写审计；写任务 → `uncertain`；服务存活 → 只告警与暂停、任务状态不变；暂停后 `router.dispatch` 返回 503；队列积压暂停→恢复；存储损坏升级且不改文件；投递失败告警；dry-run 无副作用；重复运行不重复恢复。
- Supervisor 演练：拉起一个长驻 stub 服务，杀掉其进程后 Supervisor 在退避后重新拉起（pid 变化），再次杀掉后达到重启上限，Supervisor 以退出码 3 升级人工，审计含 `restart_scheduled` 与 `escalate_manual`。

**未自动化**：用真实 `server/index.js` 跑杀进程/重启演练（Supervisor 的启动命令与真实服务相同，但测试用 stub 服务验证机制；真实服务演练需在目标机器上执行 §6 的手动命令并记录审计）。

全量门禁（2026-11-01 实跑）：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 55 个测试文件，全部通过 |
| `node scripts/verify-test-coverage.js` | `backend=1748/1748 nodeSuite=221/221 runner=1527/1527`；`frontend=179/179 suites=22/22 failed=0`；`CI runner 覆盖 55/55` |
| `node scripts/sync-doc-counts.js --check` | 文档计数与基线一致（55 文件 / 1748 项） |
| `node scripts/verify-api-capabilities.js` | 93 条路由、19 个路由族、9 个仅 API 能力，登记一致 |
| `npx tsc --noEmit` | 通过 |
| `npm run lint` | 通过 |

## 5. 迁移与回滚

- Watchdog 只追加 `agents/watchdog/`、`agents/intake-pause.json`，不改变任务 schema。
- 回滚：停止调度 Watchdog/Supervisor，删除 `agents/intake-pause.json` 即恢复接单；任务数据无需迁移。

## 6. 部署接入（仓库不自动安装）

```bash
# 每分钟运行一次 Watchdog；退出码 2 表示需要人工处理
node scripts/bluebird-watchdog.js

# 外部 Supervisor（示例命令；Windows 可用 NSSM/schtasks 托管，systemd 用 ExecStart）
BLUEBIRD_SUPERVISOR_CMD="node server/index.js" node scripts/bluebird-supervisor.js

# 允许 Watchdog 在服务停机时按配置重启（命令只来自部署配置）
BLUEBIRD_WATCHDOG_RESTART_CMD="cmd /c start-service.bat" node scripts/bluebird-watchdog.js
```

systemd 示例：

```ini
[Service]
WorkingDirectory=/opt/bluebird
Environment=BLUEBIRD_DATA_DIR=/var/lib/bluebird
ExecStart=/usr/bin/node scripts/bluebird-supervisor.js
Restart=on-failure
RestartSec=5
```

定时 Watchdog（systemd timer / Windows 计划任务）每分钟执行一次，并在退出码非 0 时通知运维。

## 7. 未做与限制

- 操作系统调度与告警通道需部署方接入；仓库只提供脚本与模板，不安装计划任务。
- 真实 Bluebird 服务的杀进程/重启仅提供手动演练命令，测试使用 stub 服务。
- 资源压力目前只检查磁盘可用空间；内存/CPU 阈值需要部署方监控系统补齐。
- 阈值是代码内默认值（policy 模块），没有 HTTP 配置接口；调整需要改代码或传参。
- “终止失效 Worker”没有独立动作：Worker 与服务同进程，失效 Worker 通过租约过期 + 服务重启收敛；“重启 Worker”等同重启服务。
- 无法安全恢复的任务只做 `uncertain` + 人工升级，没有自动复核工具。
