#!/usr/bin/env node
/* global require, module, process, console */
/**
 * 循环依赖冻结门禁（健康度审计 R1 配套，2026-11-20）。
 *
 * 背景：server 核心是一个 46 文件的加载期循环结（SCC，顶层 require 为主）。
 * 审计判定：它不阻塞功能，但「新模块自动入圈」是真实的分层摩擦
 * （tool-workspace 已实证入圈）。本门禁把 SCC 成员清单冻结在
 * scripts/scc-baseline.json——成员变化必须是有意识的决策：
 *
 *   - 新增成员（入圈）  = 分层违规。修法：改函数内惰性 require、事件/回调解耦、
 *     或拆接口；确需入圈必须经 oracle 放行后 `--write` 再生基线并在提交里说明。
 *   - 减少成员（解环）  = 进展。同样要 `--write` 再生基线（台账纪律：基线
 *     变化必须显式，不允许静默漂移）。
 *
 * 算法：扫描 server 目录下全部 .js 的相对 require 边（含函数内惰性 require——
 * 惰性桥接也是入圈形态，入圈即需有意识决策）→ Tarjan SCC → 与基线比对。
 *
 * 用法：
 *   node scripts/verify-dependency-baseline.js            # 校验
 *   node scripts/verify-dependency-baseline.js --write    # 再生基线
 *   node scripts/verify-dependency-baseline.js --json     # 追加输出当前 SCC 明细
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const BASELINE_FILE = path.join(__dirname, 'scc-baseline.json');
const JSON_OUT_ARG = process.argv.find(arg => arg.startsWith('--json-out='));
const WRITE = process.argv.includes('--write');
const JSON_MODE = process.argv.includes('--json');

// ---- 1. 收集 server 模块 ----
function listServerModules() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.endsWith('.js')) out.push(full);
    }
  })(SERVER_DIR);
  return out;
}

// ---- 2. 相对 require 边解析（仅 server 内部）----
function resolveRequire(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    base + '.js',
    path.join(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const rel = path.relative(SERVER_DIR, candidate);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return candidate;
    }
  }
  return null;
}

const REQUIRE_RE = /\brequire\(\s*(['"])(\.[^'"]+?)\1\s*\)/g;

function buildGraph() {
  const files = listServerModules();
  const byPath = new Map(files.map(f => [path.normalize(f), f]));
  const graph = new Map();
  const external = new Map();

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const L = text.split(/\r?\n/);
    const edges = [];
    REQUIRE_RE.lastIndex = 0;
    let match;
    while ((match = REQUIRE_RE.exec(text))) {
      const resolved = resolveRequire(file, match[2]);
      if (resolved) {
        const target = path.normalize(resolved);
        if (target !== path.normalize(file)) {
          // 记录顶层性：跨行解构 const { ... } = require(...) 的 require 词虽
          // 在缩进行，但语句头（const/let/var 行）才是加载期判定点——回溯
          // 语句头，语句头零缩进 = 加载期执行；语句头缩进 = 函数内惰性。
          const lineNo = text.slice(0, match.index).split('\n').length - 1;
          let s = lineNo;
          while (s > 0 && /^[ \t\}.,\]]/.test(L[s])) s -= 1;
          const top = /^[^\s]/.test(L[s]);
          edges.push({ to: target, top, line: lineNo + 1 });
        }
      } else {
        // 指向 server 外的相对引用（如 ../package.json）——记录不计边
        const raw = path.resolve(path.dirname(file), match[2]);
        external.set(file, raw);
      }
    }
    const seen = new Set();
    const deduped = edges.filter(e => {
      const key = e.to + (e.top ? '#top' : '#lazy') + ':' + e.line;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    graph.set(path.normalize(file), deduped);
  }
  return { files, graph, external };
}

// ---- 3. Tarjan SCC（迭代式，防爆栈）----
function tarjanSCC(graph) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let counter = 0;

  for (const start of graph.keys()) {
    if (index.has(start)) continue;
    const work = [[start, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const node = frame[0];
      const edges = graph.get(node) || [];

      if (frame[1] === 0) {
        index.set(node, counter);
        low.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);
      }

      let advanced = false;
      while (frame[1] < edges.length) {
        const next = edges[frame[1]].to;
        frame[1] += 1;
        if (!index.has(next)) {
          work.push([next, 0]);
          advanced = true;
          break;
        }
        if (onStack.has(next)) {
          low.set(node, Math.min(low.get(node), index.get(next)));
        }
      }
      if (advanced) continue;

      if (low.get(node) === index.get(node)) {
        const component = [];
        let popped;
        do {
          popped = stack.pop();
          onStack.delete(popped);
          component.push(popped);
        } while (popped !== node);
        sccs.push(component);
      }

      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
    }
  }
  return sccs;
}

// ---- 4. 基线比对 ----
function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function main() {
  const { files, graph } = buildGraph();
  const sccs = tarjanSCC(graph).filter(c => c.length > 1);
  const current = sccs.flat().map(rel).sort();

  // 双层口径之层 1（硬闸）：加载期圈 = 仅顶层 require 边的图上的 SCC。
  // 加载期循环会让模块初始化顺序不确定——必须恒为 0，任何非零直接失败。
  const topGraph = new Map(
    [...graph.entries()].map(([f, edges]) => [
      f,
      edges.filter(e => e.top).map(e => ({ to: e.to })),
    ])
  );
  const loadCycles = tarjanSCC(topGraph).filter(c => c.length > 1);
  const loadMembers = loadCycles.flat().map(rel).sort();

  // 双层口径之层 2（影子圈台账）：静态圈（含惰性边）。惰性 require 是
  // AGENTS.md 认可的第一修法的成果——顶层边子图无环（加载期 DAG）意味着
  // 每条静态环闭合路径都至少含一条惰性边，静态圈全部由惰性边闭合。
  const lazyEdges = [];
  const staticMembers = new Set(sccs.flat());
  for (const [from, edges] of graph) {
    if (!staticMembers.has(from)) continue;
    for (const e of edges) {
      if (!e.top && staticMembers.has(e.to)) {
        lazyEdges.push(rel(from) + ':' + e.line + ' -> ' + rel(e.to));
      }
    }
  }
  lazyEdges.sort();

  if (WRITE) {
    const baseline = {
      version: 2,
      updatedAt: new Date().toISOString().slice(0, 10),
      updateRule:
        '双层口径。层 1（硬闸）：加载期圈（仅顶层 require 边的 SCC）必须恒为 0，' +
        '非零即失败——加载期循环会让模块初始化顺序不确定。层 2（影子圈台账）：' +
        '静态圈（含惰性边）成员清单冻结，惰性 require 是认可的第一修法的成果，' +
        '静态圈全部由惰性边闭合（影子圈）。成员/个数/惰性边清单变化必须在同一提交里' +
        '用 --write 再生本文件并说明理由：新增成员 = 分层违规；新增惰性边 = 需说明' +
        '为何不能注入/回调；减少 = 解环进展。禁止只改总数或静默漂移。',
      loadCycleCount: loadCycles.length,
      loadCycleMembers: loadMembers,
      sccCount: sccs.length,
      memberCount: current.length,
      edgeCount: [...graph.values()].reduce((sum, e) => sum + e.length, 0),
      lazyEdgeCount: lazyEdges.length,
      lazyEdges,
      moduleCount: files.length,
      sccFiles: current,
    };
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
    console.log(
      `已再生基线：SCC ${sccs.length} 个 / 成员 ${current.length} / 边 ` +
        `${baseline.edgeCount} / 模块 ${files.length}`
    );
    return;
  }

  if (!fs.existsSync(BASELINE_FILE)) {
    console.error('✖ 基线不存在：node scripts/verify-dependency-baseline.js --write 生成');
    process.exit(1);
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  const frozen = new Set(baseline.sccFiles);
  const currentSet = new Set(current);

  const problems = [];

  // 层 1（加载期圈）台账冻结：加载期环是真实债（模块初始化半初始化风险），
  // 新增成员 = 违规直接拦；存量台账化，解环按批次递减（每批 --write 显式化）。
  const frozenLoad = new Set(baseline.loadCycleMembers || []);
  const loadNow = new Set(loadMembers);
  const loadEntered = loadMembers.filter(f => !frozenLoad.has(f)).sort();
  const loadExited = (baseline.loadCycleMembers || []).filter(f => !loadNow.has(f)).sort();
  if (loadEntered.length) {
    problems.push(
      '新模块进入加载期循环依赖（顶层 require 环——初始化顺序安全违规）：\n  ' +
        loadEntered.join('\n  ') +
        '\n  修法：顶层 require 惰性化（函数内 require）/ 事件回调解耦 / 容器注入'
    );
  }
  if (loadExited.length) {
    problems.push(
      '加载期圈成员已解出（解环进展——台账纪律要求显式化）：\n  ' +
        loadExited.join('\n  ') +
        '\n  处理：node scripts/verify-dependency-baseline.js --write 再生基线'
    );
  }
  if (baseline.loadCycleCount !== undefined && baseline.loadCycleCount !== loadCycles.length && !loadEntered.length && !loadExited.length) {
    problems.push(
      `加载期圈数与基线不符：基线 ${baseline.loadCycleCount}，当前 ${loadCycles.length}` +
        '（拓扑形态变化——node scripts/verify-dependency-baseline.js --write 再生并说明理由）'
    );
  }

  const entered = current.filter(f => !frozen.has(f)).sort();
  const exited = baseline.sccFiles.filter(f => !currentSet.has(f)).sort();
  // 层 2：圈的「个数」也冻结——46 成员影子圈被拆成多个小圈而成员并集不变时，
  // 成员清单比对发现不了——拓扑形态变化同样必须显式再生基线。
  if (baseline.sccCount !== sccs.length) {
    problems.push(
      `SCC 个数与基线不符：基线 ${baseline.sccCount} 个，当前 ${sccs.length} 个` +
        '（拓扑形态变化——node scripts/verify-dependency-baseline.js --write 再生并说明理由）'
    );
  }

  if (entered.length) {
    problems.push(
      '新模块进入循环依赖圈（分层违规——健康度审计 R1）：\n  ' +
        entered.join('\n  ') +
        '\n  修法：函数内惰性 require / 事件回调解耦 / 拆接口；' +
        '确需入圈必须经 oracle 放行后 --write 再生基线并在提交里说明'
    );
  }
  if (exited.length) {
    problems.push(
      '基线成员已不在循环圈里（解环进展——台账纪律要求显式化）：\n  ' +
        exited.join('\n  ') +
        '\n  处理：node scripts/verify-dependency-baseline.js --write 再生基线'
    );
  }
  if (baseline.memberCount !== current.length && !problems.length) {
    problems.push('memberCount 与基线不符但成员清单一致——请核对基线文件');
  }

  // 层 2 惰性边清单冻结：新增/删除惰性边都要显式化（影子圈的构成变化）。
  const frozenLazy = new Set(baseline.lazyEdges || []);
  const lazyNow = new Set(lazyEdges);
  const lazyAdded = lazyEdges.filter(e => !frozenLazy.has(e)).sort();
  const lazyRemoved = (baseline.lazyEdges || []).filter(e => !lazyNow.has(e)).sort();
  if (lazyAdded.length) {
    problems.push(
      '新增惰性 require 边（影子圈构成变化——须说明为何不能注入/回调）：\n  ' +
        lazyAdded.join('\n  ') +
        '\n  处理：node scripts/verify-dependency-baseline.js --write 再生基线并说明理由'
    );
  }
  if (lazyRemoved.length) {
    problems.push(
      '惰性 require 边已消失（解环进展——台账纪律要求显式化）：\n  ' +
        lazyRemoved.join('\n  ') +
        '\n  处理：node scripts/verify-dependency-baseline.js --write 再生基线'
    );
  }

  const report = {
    loadCycleCount: loadCycles.length,
    sccCount: sccs.length,
    memberCount: current.length,
    moduleCount: files.length,
    edgeCount: [...graph.values()].reduce((sum, e) => sum + e.length, 0),
    lazyEdgeCount: lazyEdges.length,
    entered,
    exited,
    lazyAdded,
    lazyRemoved,
  };

  if (JSON_OUT_ARG) {
    const outPath = JSON_OUT_ARG.slice('--json-out='.length);
    fs.writeFileSync(
      path.resolve(outPath),
      JSON.stringify({ sccs: sccs.map(c => c.map(rel).sort()), report }, null, 2),
      'utf8'
    );
  }

  const summary =
    `加载期圈 ${report.loadCycleCount} / SCC ${report.sccCount} 个 / 成员 ${report.memberCount} / 惰性边 ${report.lazyEdgeCount} / 边 ${report.edgeCount} / 模块 ${report.moduleCount}`;

  if (problems.length) {
    console.error(`✖ 循环依赖冻结校验失败：${summary}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(`✔ 循环依赖冻结校验通过：${summary}`);
  if (JSON_MODE) {
    console.log(JSON.stringify({ sccs: sccs.map(c => c.map(rel).sort()), report }, null, 2));
  }
}

main();
