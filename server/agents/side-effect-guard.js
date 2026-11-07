/* global module */
/**
 * 副作用工具的幂等闸门（Phase 1 / P2）。
 *
 * 只有「任务执行器 + 有副作用工具（readOnly === false）」才会构造这个闸门；
 * 无副作用工具、主控直聊路径都不接账本，不会平白多出账本行。
 *
 * 语义（三条不变量）：
 *  1. 执行前先 begin 并落盘；账本写不下去就**不执行**（fail-closed）。
 *  2. 命中 succeeded → 复用已有结果、不重新执行，并把 resultDigest/opKey 带回，
 *     让调用方知道复用的是哪一次。
 *  3. 命中 started / unknown → 副作用可能已经发生：绝不自动重试，闸门进入
 *     blocked（side_effect_*），任务由 runtime 收口为 recovery 等人工核对。
 *
 * 只有 failed 允许原地重试：同 opKey、attempt+1，不产生第二行同键记录。
 *
 * §20 第 349 步（FM-4）：传入 fencingToken 时，每次 before 先校验写入资格，
 * 过期/撤销/读不出代次一律 blocked，且**不写账本意图行**——被拦的调用副作用一次都没做，
 * 留一行 started 会让下次同键调用被误判成"可能已执行"。
 */
const ledger = require('./op-ledger');
const fencing = require('./fencing');

const SIDE_EFFECT_UNKNOWN = 'side_effect_unknown';
const LEDGER_UNAVAILABLE = 'side_effect_ledger_unavailable';
const ARGS_INVALID = 'side_effect_args_invalid';

// 逃生阀字段：显式要求「同参也再执行一次」时，带一个不同取值（如调用序号）。
// 它只参与幂等键，执行前会被剥离，不会进入工具参数或 handler 的语义。
const OVERRIDE_FIELD = 'dedupeKeyOverride';

function splitOverride(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { args, override: null };
  }
  if (!Object.prototype.hasOwnProperty.call(args, OVERRIDE_FIELD)) {
    return { args, override: null };
  }
  const rest = { ...args };
  delete rest[OVERRIDE_FIELD];
  const raw = args[OVERRIDE_FIELD];
  const override =
    raw === null || raw === undefined || raw === '' ? null : String(raw);
  return { args: rest, override };
}

function createSideEffectGuard({ agentId, taskId, fencingToken = null } = {}) {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new TypeError('[side-effect] agentId 必须是非空字符串');
  }
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new TypeError('[side-effect] taskId 必须是非空字符串');
  }

  // null 表示正常；一旦非空，本次运行已不可继续，必须转 recovery。
  let blockedCode = null;
  // §20 第 349 步：代次被取代/撤销是确定性拒绝（副作用一次都没做），
  // 与"结果不确定"分开记，调用方据此落审计并收口成终态而不是 recovery。
  let fencingDenial = null;

  function block(code) {
    if (!blockedCode) blockedCode = code;
    return { mode: 'blocked', code, opKey: null };
  }

  return {
    get status() {
      return blockedCode;
    },

    get denial() {
      return fencingDenial;
    },

    blocked() {
      return Boolean(blockedCode);
    },

    splitOverride,

    /** 返回 {mode:'execute'|'reuse'|'blocked', opKey, result?, resultDigest?} */
    before({ toolName, args, override = null } = {}) {
      if (blockedCode) return { mode: 'blocked', code: blockedCode, opKey: null };

      // 资格判定在账本 begin 之前：过期代次连"意图行"都不该留下，
      // 否则一次被拦的调用会在账本里变成 started，下次同键调用被误判成"可能已执行"。
      if (fencingToken) {
        const verdict = fencing.verify({ taskId, token: fencingToken });
        if (!verdict.ok) {
          fencingDenial = verdict;
          return block(verdict.code);
        }
      }

      let opKey = null;
      try {
        const stepId = ledger.deriveStepId({ toolName, args, override });
        const begun = ledger.begin({ agentId, taskId, stepId, toolName, args });
        opKey = begun.opKey;

        if (!begun.reused) return { mode: 'execute', opKey };

        const entry = begun.entry;

        if (entry.status === 'succeeded') {
          return {
            mode: 'reuse',
            opKey,
            result: entry.result,
            resultDigest: entry.resultDigest,
            resultOmitted: entry.resultOmitted === true,
            finishedAt: entry.finishedAt,
          };
        }

        if (entry.status === 'failed') {
          // 已确认失败且没有副作用残留，按既有重试策略原地重来。
          ledger.retry(opKey);
          return { mode: 'execute', opKey, retried: true };
        }

        // started：上次进程崩在中途；unknown：超时或已判不确定。
        // 两者都意味着副作用可能已经发生 —— 只标不确定，绝不重跑。
        if (entry.status === 'started') {
          try {
            ledger.markUnknown(opKey, { errorCode: 'recovery_side_effect_unknown' });
          } catch (_) {
            // 标 unknown 失败也不影响结论：不清账就是不重用。
          }
        }
        return block(SIDE_EFFECT_UNKNOWN);
      } catch (error) {
        const code = (error && error.code) || '';
        const reason =
          code === 'agent_op_args_invalid' || code === 'agent_op_key_invalid'
            ? ARGS_INVALID
            : LEDGER_UNAVAILABLE;
        console.error(`[side-effect] ledger begin failed tool=${toolName} code=${code || 'none'}`);
        return block(reason);
      }
    },

    /** 工具执行结束后补终态；写账失败不改变本次结果，只让下次命中 unknown。 */
    after({ opKey, status, result, errorCode = null } = {}) {
      if (!opKey) return;
      try {
        if (status === 'succeeded') {
          ledger.finish(opKey, { status: 'succeeded', result });
          return;
        }
        if (status === 'failed') {
          ledger.finish(opKey, { status: 'failed', errorCode });
          return;
        }
        // unknown：超时等「不知道有没有生效」，保留为待核对，并中止本次运行。
        ledger.markUnknown(opKey, { errorCode: errorCode || SIDE_EFFECT_UNKNOWN });
        block(SIDE_EFFECT_UNKNOWN);
      } catch (error) {
        const code = (error && error.code) || 'ledger_write_failed';
        console.error(`[side-effect] ledger finish failed code=${code}`);
      }
    },
  };
}

module.exports = {
  SIDE_EFFECT_UNKNOWN,
  LEDGER_UNAVAILABLE,
  ARGS_INVALID,
  createSideEffectGuard,
};
