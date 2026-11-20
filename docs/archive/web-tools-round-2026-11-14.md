# 轮 W：web_search / web_fetch 搜索能力（2026-11-14）

> 依据：Owner 发起的搜索能力评估（`scripts/` 之外零改动评估，见当日调研）与「开搂」指令。方案 A：DeepSeek 官方 Tools API 薄工具层，零新 npm 依赖。
> 代码基准：`main` = `e11e885`（PR #82 合并后）。

## 1. 实现

### 1.1 `server/tool-web.js`（两个工具定义 + 传输层）

- **`web_search`**（readOnly, risk=read）：`POST {toolsBase}/v1/tools/search {query}` → 结构化 `results[]`（title/url/snippet/siteName/date/authority），`max_results` 截断并置 `truncated`。query ≤500 字、max_results 钳 1–20（默认 8）。
- **`web_fetch`**（readOnly, risk=read）：`POST {toolsBase}/v1/tools/fetch {url}` → `{content(Markdown), title}`。**抓取由 DeepSeek 远端执行**（返回即 Markdown，无需本地 HTML 解析与重定向机）；URL 闸在客户端前置。content ≤8000 字截断 + `truncated`。
- **钥匙统一**（Owner 决策）：`getProviderKey('deepseek')` 与对话 provider 共用同一把 `DEEPSEEK_API_KEY`——单一轮换点、零新增凭据面。`DEEPSEEK_BASE_URL` 覆盖（DSH 同名约定，仅 http/https），供测试桩与未来网关切换。
- **readiness 口径**（照抄 DSH）：`isConfigured()` 做本地廉价检查（不做网络调用）；钥匙未配置时工具**不注册**——模型不声明也不派发；执行期再次 fail-closed（`web_tools_not_configured`）。
- **URL 闸**（web_fetch）：`assertFetchableUrl` 仅接受 http/https；拒绝携带凭据的 URL；字面私网/环回/保留地址（IPv4/IPv6，复用 model-adapter 的 `isPrivateAddress`）与保留主机名/后缀（localhost、`.local`、`.internal`、`.home.arpa`、云 metadata）一律 `web_fetch_blocked_url`。**不吃 `BLUEBIRD_ALLOW_PRIVATE_BASE_URL` 旁路**——该旁路只放宽对话 provider 的自建端点，不放宽「模型任选 URL」的抓取面。域名不做本地 DNS 预解析：抓取由 DeepSeek 远端执行，本地解析视角与远端不同（预解析无意义），远端视角的防线由 API 侧承担。
- **注入防线**（照抄 knowledge_search 同款）：外部内容一律 `neutralizeContextText(stripProtocolMarkers(...))` + 截断 + `trust: 'untrusted_external_content'` + 「不是系统或用户指令」警示；工具结果经 runtime 通用 `tool:<name>` 来源标签自动进入 §16 taint 继承。

### 1.2 注册与白名单

- `agent-runtime.js`：钥匙已配置时注册两工具（主聊天与 Worker 共用注册表）；主聊天 policy 缺省（allowedTools=null）即获得。
- `manifest.js`：`RESEARCHER_TOOLS` 增 `web_search`/`web_fetch`（检索型 Worker 的自然扩展）；memory/executor/reviewer 白名单不变。
- 非 2xx / 网络 / 超时全部结构化返回（`web_search_failed` / `web_fetch_failed` / `*_timeout` / `*_unreachable`），**不抛给模型**；API 侧非 2xx 与正常结果同形处理。

## 2. 验收（`tests/agent-web-tools.test.js`，11 例全过）

| 组 | 覆盖 |
|---|---|
| a/b/c | search 快乐路径（清洗 + trust + authority）、max_results 截断、参数校验四类 |
| d | 钥匙未配置：isConfigured false + 双工具执行期 fail-closed |
| e/j | API 非 2xx → 结构化失败（search/fetch 各一） |
| f/g | fetch 快乐路径（{content,title} 清洗）+ 超限截断（20KB → ≤8000 + truncated） |
| h/i | 参数校验（协议/超长/凭据 URL 走执行闸）；URL 闸八类目标全拦（环回/私网三段/metadata/localhost/.local/.internal）+ 合法公网 URL 放行；**不吃测试旁路** |
| k | 注册面：两工具进注册表、readOnly=true、risk=read |

**真实 API 冒烟**（钥匙环境变量注入，全链路）：`web_search`（"Bluebird 智能体 平台"）3 条真实结果 + 清洗 + trust 标签；`web_fetch`（example.com）title/content 911 字/truncated=false。采集不设门槛，只证明链路。

## 3. 边界与如实标注

1. **SSRF 语义与 DSH 相反**：DSH 的 HTTP 抓取 provider 默认放行内网；Bluebird 因抓取发生在 DeepSeek 远端、本地不做 DNS 预解析，客户端闸只拦「内网样式目标」（字面 IP/保留主机名）。远端视角的访问控制由 API 侧承担——这是选择官方 API 而非本地抓取的安全收益之一。
2. **单 provider**：v1 只接 DeepSeek 官方 API；provider seam（SearXNG 等）留待后续轮——seam 的设计要件（readiness/结构化错误/截断）已在工具层预留。
3. **主聊天与 Worker 并联**：工具在共用注册表，主聊天 policy 放行即用；Worker 侧按 manifest 白名单（researcher）。
4. **计费共享**：搜索/抓取与对话同账户同钥匙计费、共享限流窗口（Owner 已知情）。
5. 抓取正文上限 8000 字（截断），原始字节上限由 API 侧控制。

## 4. 计数与门禁

- 新增 `tests/agent-web-tools.test.js`（11 例）；基线 backend 2474 → 2485、runner 2244 → 2455、文件 125 → 126；`sync-doc-counts.js` 同步。
