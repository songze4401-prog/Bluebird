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
 */
const ledger = require('./op-ledger');

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

function createSideEffectGuard({ agentId, taskId } = {}) {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new TypeError('[side-effect] agentId 必须是非空字符串');
  }
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new TypeError('[side-effect] taskId 必须是非空字符串');
  }

  // null 表示正常；一旦非空，本次运行已不可继续，必须转 recovery。
  let blockedCode = null;

  function block(code) {
    if (!blockedCode) blockedCode = code;
    return { mode: 'blocked', code, opKey: null };
  }

  return {
    get status() {
      return blockedCode;
    },

    blocked() {
      return Boolean(blockedCode);
    },

    splitOverride,

    /** 返回 {mode:'execute'|'reuse'|'blocked', opKey, result?, resultDigest?} */
    before({ toolName, args, override = null } = {}) {
      if (blockedCode) return { mode: 'blocked', code: blockedCode, opKey: null };

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
