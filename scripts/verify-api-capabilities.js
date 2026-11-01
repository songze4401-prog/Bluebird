#!/usr/bin/env node
/*
 * 后端能力 ↔ 前端消费者登记册的校验器（P3-04）。
 *
 * 审计 P3-04 记录的问题是「部分后端能力没有 UI 消费者」，但没有任何地方写清楚
 * 到底哪些没有。本脚本把这件事变成可核对的登记册：
 *   - 后端每条路由都必须落在某个登记的路由族里（新加路由必须登记）；
 *   - 登记的路由族必须真的存在于后端（登记不能悬空）；
 *   - 标 ui 的能力必须真的有前端消费者，且消费者文件确实引用了它；
 *   - 标 api-only 的能力必须确实没有前端消费者（不能一边说没有一边在用）。
 *
 * api-only 的能力不会被下线：它们是对外可用的 API，只是本仓库没做界面。
 * 这里只保证「文档说的和代码做的」一致。
 *
 * 用法：
 *   node scripts/verify-api-capabilities.js          # 校验
 *   node scripts/verify-api-capabilities.js --write  # 同时刷新 AGENTS.md 的登记块
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REGISTRY_FILE = path.join(__dirname, 'api-capability-registry.json');
const AGENTS_FILE = path.join(ROOT, 'AGENTS.md');

const REGION_START = '<!-- sync:api-capabilities -->';
const REGION_END = '<!-- /sync:api-capabilities -->';

const FRONTEND_ROOTS = ['lib', 'components', 'hooks'];
// endpoints.ts 只定义路径，不消费路径；它不算前端消费者。
const FRONTEND_EXCLUDE = new Set(['lib/api/endpoints.ts']);

const ROUTE_RE = /\b(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*'([^']+)'/g;

function readRegistry(file = REGISTRY_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listFrontendFiles(root = ROOT) {
  const files = [];
  for (const dir of FRONTEND_ROOTS) {
    const absolute = path.join(root, dir);
    if (!fs.existsSync(absolute)) continue;
    const walk = current => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          files.push(path.relative(root, full).split(path.sep).join('/'));
        }
      }
    };
    walk(absolute);
  }
  const appFile = path.join(root, 'App.tsx');
  if (fs.existsSync(appFile)) files.push('App.tsx');
  return files.sort();
}

function extractRoutes(registry, root = ROOT) {
  const routes = [];
  for (const router of registry.routers) {
    const text = fs.readFileSync(path.join(root, router.file), 'utf8');
    ROUTE_RE.lastIndex = 0;
    let match = ROUTE_RE.exec(text);
    while (match) {
      const method = match[1].toUpperCase();
      const route = `${router.mount}${match[2]}`;
      routes.push({ method, route, file: router.file });
      match = ROUTE_RE.exec(text);
    }
  }
  return routes;
}

function matchFamily(families, route) {
  let best = null;
  for (const family of families) {
    if (family.exact) {
      if (route === family.prefix) return family;
      continue;
    }
    if (route === family.prefix || route.startsWith(`${family.prefix}/`)) {
      if (!best || family.prefix.length > best.prefix.length) best = family;
    }
  }
  return best;
}

function buildRegion(registry) {
  const rows = registry.families.flatMap(family =>
    family.capabilities
      .filter(capability => capability.ui === false)
      .map(capability => {
        const consumer = capability.consumers.length
          ? capability.consumers.join('、')
          : '无';
        return `| \`${capability.name}\` | ${family.title} | ${consumer} | ${capability.note || '—'} |`;
      })
  );

  return [
    REGION_START,
    '<!-- 本块由 scripts/verify-api-capabilities.js --write 生成，不要手工编辑。 -->',
    '| 仅 API 的后端能力（界面没有入口，但接口可用） | 路由族 | 前端消费者 | 说明 |',
    '| --- | --- | --- | --- |',
    ...rows,
    REGION_END,
  ].join('\n');
}

// AGENTS.md 里的登记块。比对与写入都要沿用文件自身的换行符（仓库是 CRLF），
// 否则刚写完就会判定为不一致。
function regionFor(agentsText, registry) {
  const eol = agentsText.includes('\r\n') ? '\r\n' : '\n';
  return buildRegion(registry).replace(/\n/g, eol);
}

function verify({ root = ROOT, ignoreAgentsBlock = false } = {}) {
  const registry = readRegistry(path.join(root, 'scripts', 'api-capability-registry.json'));
  const errors = [];
  const warnings = [];

  // 1) 路由挂载点必须与 server/index.js 里写的一致。
  const entryText = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  for (const router of registry.routers) {
    if (!entryText.includes(router.mountExpr)) {
      errors.push(
        `挂载点漂移：${router.file} 期望在 server/index.js 里看到 ${router.mountExpr}`
      );
    }
  }

  // 2) 后端每条路由都要登记；登记的路由族也要真的存在。
  const routes = extractRoutes(registry, root);
  const usedFamilies = new Set();
  for (const item of routes) {
    const family = matchFamily(registry.families, item.route);
    if (!family) {
      errors.push(`未登记的路由：${item.method} ${item.route}（${item.file}）`);
      continue;
    }
    usedFamilies.add(family.id);
  }
  for (const family of registry.families) {
    if (!usedFamilies.has(family.id)) {
      errors.push(`登记的路由族在后端不存在：${family.id}（${family.prefix}）`);
    }
  }

  // 3) 能力声明与前端实际引用一致。
  const frontendFiles = listFrontendFiles(root);
  const bodies = new Map(
    frontendFiles.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')])
  );
  const consumers = frontendFiles.filter(file => !FRONTEND_EXCLUDE.has(file));

  for (const family of registry.families) {
    for (const capability of family.capabilities) {
      const users = consumers.filter(file => bodies.get(file).includes(capability.probe));

      if (capability.ui === true) {
        if (!capability.consumers.length) {
          errors.push(`${family.id} / ${capability.name}：标了 ui 却没有列出消费者`);
          continue;
        }
        for (const file of capability.consumers) {
          if (!bodies.has(file)) {
            errors.push(`${family.id} / ${capability.name}：消费者文件不存在 ${file}`);
            continue;
          }
          if (!bodies.get(file).includes(capability.probe)) {
            errors.push(
              `${family.id} / ${capability.name}：${file} 没有引用 ${capability.probe}`
            );
          }
        }
        if (users.length === 0) {
          errors.push(`${family.id} / ${capability.name}：标了 ui，但前端没有任何文件引用 ${capability.probe}`);
        }
      } else if (capability.ui === false) {
        if (users.length) {
          errors.push(
            `${family.id} / ${capability.name}：标了 api-only，但 ${users.join('、')} 引用了 ${capability.probe}`
          );
        }
        if (capability.consumers.length) {
          errors.push(
            `${family.id} / ${capability.name}：标了 api-only，却列了消费者 ${capability.consumers.join('、')}`
          );
        }
      } else {
        errors.push(`${family.id} / ${capability.name}：ui 字段必须是 true 或 false`);
      }
    }
  }

  // 4) AGENTS.md 的登记块必须与登记册一致。
  const agentsText = fs.readFileSync(AGENTS_FILE, 'utf8');
  const start = agentsText.indexOf(REGION_START);
  const end = agentsText.indexOf(REGION_END);
  if (start === -1 || end === -1) {
    errors.push(`AGENTS.md 缺少登记块标记（${REGION_START} / ${REGION_END}）`);
  } else if (!ignoreAgentsBlock) {
    const current = agentsText.slice(start, end + REGION_END.length);
    const expected = regionFor(agentsText, registry);
    if (current !== expected) {
      errors.push('AGENTS.md 的 API 能力登记块与登记册不一致（跑 --write 刷新）');
    }
  }

  return { errors, warnings, routes, registry };
}

function main() {
  const write = process.argv.includes('--write');

  if (write) {
    // 写模式：登记块本身的不一致是要被修掉的，不算错误。
    const first = verify({ ignoreAgentsBlock: true });
    if (first.errors.length) {
      first.errors.forEach(error => console.error(`  - ${error}`));
      console.error('✖ API 能力登记校验失败：未写任何文件');
      process.exit(1);
    }

    const registry = first.registry;
    const agentsText = fs.readFileSync(AGENTS_FILE, 'utf8');
    const start = agentsText.indexOf(REGION_START);
    const end = agentsText.indexOf(REGION_END);
    if (start !== -1 && end !== -1) {
      const region = regionFor(agentsText, registry);
      const next =
        agentsText.slice(0, start) +
        region +
        agentsText.slice(end + REGION_END.length);
      if (next !== agentsText) {
        fs.writeFileSync(AGENTS_FILE, next);
        console.log('已刷新 AGENTS.md 的 API 能力登记块');
      }
    }
  }

  const { errors, warnings, routes, registry } = verify();

  warnings.forEach(warning => console.warn(`  ! ${warning}`));

  if (errors.length) {
    console.error(`✖ API 能力登记校验失败（${errors.length} 项）：`);
    errors.forEach(error => console.error(`  - ${error}`));
    process.exit(1);
  }

  const apiOnly = registry.families.reduce(
    (sum, family) =>
      sum + family.capabilities.filter(capability => capability.ui === false).length,
    0
  );
  console.log(
    `✔ API 能力登记一致：后端路由 ${routes.length} 条、路由族 ${registry.families.length} 个、` +
      `仅 API 的能力 ${apiOnly} 个`
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  readRegistry,
  listFrontendFiles,
  extractRoutes,
  matchFamily,
  buildRegion,
  verify,
};
