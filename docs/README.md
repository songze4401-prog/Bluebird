# docs/ 目录约定：现行文档 vs 历史快照

2026-11-21 收尾条 6 之后，docs/ 顶层只放**现行**文档；带日期的一次性报告、
交接、审计、分轮记录一律进 `docs/archive/`（运行 JSON 也在这里，2026-11-19
归档轮已先行）。这样做的原因很直接：顶层混着 30 多份带日期的历史文档时，
按文件名无法判断「哪份还是现状」，误引旧数字的成本比多一次跳转高得多。

## 判定规则

- **留在顶层 = 现行**：规则、契约、机制说明、仍然在被引用的活台账。
  判定标准是「现在还有人按它办事或按它取数」，不是「最近改过」。
- **进 docs/archive/ = 历史快照**：一次性的审计、交接、分轮报告、e2e 留档、
  已封版的裁决记录。它们的价值是留痕，不是现状。
- 文件名里的日期不决定归属，但**带日期且叙述的是已结束的某一轮**，默认归档；
  活台账（如 `notion-delivery-ledger-2026-11-04.md`）虽带日期，仍留顶层，
  因为 `scripts/scan-notion-ledger.js` 与 CI 直接读它。

## 现行文档（顶层）

`agent-policy.md`、`agent-runtime-stage1..4.md`、`architecture-map.md`、
`memory-*.md`（semantic / audit / bot / link-audit / round2 / confidence-candidates）、
`observability.md`、`p0..p6`、`persona-custom-prompt.md`、`phase5a-eval-tiers-and-comparators.md`、
`unified-retrieval.md`、`notion-proposal-phase-mapping.md`、`notion-delivery-ledger-2026-11-04.md`、
`adr/`。

## 历史快照（docs/archive/）

带日期的审计、交接、分轮报告、影子 e2e 记录，以及机器产出的运行 JSON。
引用归档文档时写全路径（`docs/archive/<name>.md`），并在上下文里说明它是历史口径，
不要用它的数字评价现状。

## 维护

- 新写的一次性报告直接落 `docs/archive/`，别再堆顶层。
- 顶层文档退役时 `git mv` 进 `docs/archive/`，同时改掉引用它的地方；
  `tests/frozen-snapshot-banners.test.js` 与 `tests/doc-layout.test.js` 会盯住
  顶层的「快照混入」与横幅声明。
