/* global process */

// 数据文件相关事件（损坏 + 持久化异常）的统一记录器：每次写一行 JSON 到 stderr。
//
// 为什么单独抽这个模块：sessions.js / memory.js / emotion.js 三个模块都要记录
// 自己的损坏处理，但它们的"处理策略"是刻意保留差异的 —— sessions.json 原地
// 只读保护、memory.json / emotion-state.json 隔离重命名。这里只统一"日志长什么样"，
// 一行 JSON 便于 grep / 结构化采集，不碰任何策略。
//
// 除"损坏"外，也用于"发生异常但没损坏"的可观测性事件（孤儿消息、落盘失败、
// 写入队列失败），它们同样需要能定位。
//
// 安全约束：本模块绝不记录 error.message。Node 20+ 的 JSON.parse 在报错时会把
// 输入文件的开头片段夹进 message（例如 `Unexpected token '你', "...原文..."`），
// 直接落盘等于把用户聊天记录 / 记忆正文 / 情绪文件内容写进日志。故只记录
// error.name 与 error.code 这类受控字段，以及由它们推断出的原因短码。
//
// 输出走 console.error（即 stderr），适用于 Codespaces、无头运行与常规 Node，
// 不引入任何新依赖。

const EVENT_CORRUPTION = 'data_file_corruption';

// 由错误对象推断"错误原因"短码，只取受控字段（name / code），绝不读 message。
function classifyError(error) {
  if (!error) return 'unknown';

  // JSON.parse 抛的是 SyntaxError（Node 20+ 的 message 会夹带输入片段）。
  if (error.name === 'SyntaxError') return 'json_parse_error';

  // 文件不存在：正常首启路径不会走到这里（各模块先 existsSync），
  // 出现即说明存在竞态或权限/目录问题。
  if (error.code === 'ENOENT') return 'file_missing';

  // 其余 fs 错误（EACCES / EISDIR / EPERM / EBUSY ...）统一归为 IO 问题。
  if (error.code) return 'io_error';

  // 模块自己做了结构校验并主动 throw（如 memory.json 不是数组），
  // 这类错误没有 code，会走到这里。
  return 'invalid_shape';
}

/**
 * 记录一次数据文件事件（一行 JSON 到 stderr）。
 *
 * @param {object} info
 * @param {string}  info.module        模块名：sessions | memory | emotion
 * @param {string}  info.file          数据文件（或目录）绝对路径
 * @param {string} [info.event]        事件类型，默认 data_file_corruption
 * @param {string} [info.level]        日志级别，默认 error
 * @param {string} [info.reason]       受控错误原因短码；缺省时由 error 推断
 * @param {Error}  [info.error]        原始错误对象（只取 name / code）
 * @param {string}  info.action        采取的处理措施，例如：
 *                                     read_only_protection | isolated_file | isolation_failed
 *                                     | legacy_import_skipped | pruned_on_next_write
 *                                     | write_failed | continuing
 * @param {string} [info.isolatedPath] 隔离后的文件路径（仅 action=isolated_file 时）
 * @param {object} [info.extra]        附加上下文（如孤儿消息的 count），合并进记录
 */
function logDataEvent(info) {
  const {
    module,
    file,
    event = EVENT_CORRUPTION,
    level = 'error',
    reason,
    error,
    action,
    isolatedPath,
    extra,
  } = info || {};

  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    module,
    file,
    reason: reason || classifyError(error),
    errorName: (error && error.name) || null,
    errorCode: (error && error.code) || null,
    action,
  };

  if (isolatedPath) record.isolatedPath = isolatedPath;
  if (extra && typeof extra === 'object') Object.assign(record, extra);

  console.error(JSON.stringify(record));
}

/** 数据文件损坏事件的便捷封装（event 固定为 data_file_corruption）。 */
function logDataFileEvent(info) {
  logDataEvent({ ...info, event: EVENT_CORRUPTION });
}

module.exports = { logDataEvent, logDataFileEvent };
