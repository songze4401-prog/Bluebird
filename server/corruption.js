"use strict";

// 损坏处理契约：三个模块共用同一套入口，但内部"检测 / 恢复"逻辑刻意保持各异
// （sessions.json 原地只读保护、memory.json / emotion-state.json 隔离重命名、
// chat-history.json 跳过迁移）。这里统一的是"长什么样 + 谁来调度"，
// 不是"策略变得一样"。
//
// 契约（各模块注册一个 handler）：
//   handler.detect(data)  ->  { corrupt: boolean, reason?, error?, parsed? }
//     - data = { text: string|null, error: Error|null }（已读到的原始文本 / 读取错误）
//     - 只做判定，不改任何状态；未损坏时把解析结果放进 parsed 返回给调用方。
//   handler.recover(context) -> { action, isolatedPath?, file? }
//     - 真正执行恢复动作，context 至少含 file，另带 reason / error（由 detect 结果注入）。
//     - 返回 action（写进结构化日志）与可选的 isolatedPath。
//
// handleCorruption(moduleName, data, context) 是唯一入口：
//   1) 交给对应 handler.detect 判定；
//   2) 未损坏 -> 返回 { corrupt:false, parsed }，不写日志；
//   3) 损坏 -> 调用 recover，并统一记录一行结构化损坏事件（见 data-events），
//      返回 { corrupt:true, ...recoverResult }。
//
// 事件日志只在这里发一次，调用方不再各自记录。

const { logDataFileEvent } = require('./data-events');

const handlers = new Map();

function registerCorruptionHandler(moduleName, handler) {
  if (
    !handler ||
    typeof handler.detect !== 'function' ||
    typeof handler.recover !== 'function'
  ) {
    throw new TypeError(
      `corruption handler "${moduleName}" 必须同时实现 detect 与 recover`
    );
  }

  handlers.set(moduleName, handler);
}

function handleCorruption(moduleName, data, context) {
  const handler = handlers.get(moduleName);

  if (!handler) {
    throw new Error(`no corruption handler registered for "${moduleName}"`);
  }

  const verdict = handler.detect(data || {}) || { corrupt: false };

  if (!verdict.corrupt) {
    return { corrupt: false, parsed: verdict.parsed };
  }

  const ctx = context || {};
  const outcome = handler.recover({
    ...ctx,
    reason: verdict.reason,
    error: verdict.error,
  }) || {};

  logDataFileEvent({
    module: ctx.module || moduleName,
    file: ctx.file || outcome.file,
    event: 'data_file_corruption',
    reason: verdict.reason,
    error: verdict.error,
    action: outcome.action,
    isolatedPath: outcome.isolatedPath,
  });

  return { corrupt: true, ...outcome };
}

module.exports = { registerCorruptionHandler, handleCorruption };
