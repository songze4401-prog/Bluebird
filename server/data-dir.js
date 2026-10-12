/* global __dirname */
const path = require('path');

/**
 * 数据目录的统一入口。
 *
 * 背景：原先 memory.js / emotion.js / index.js(chat-history) 各自硬编码
 * path.join(__dirname, 'data', ...)，导致测试无法把落盘目标挪出真实数据目录，
 * 只能直接读写 server/data/ 下的真实记忆与聊天记录。
 *
 * 约定：设置 BLUEBIRD_DATA_DIR 时优先采用（用于测试隔离、多实例隔离）；
 * 未设置时保持与历史完全一致的行为，仍落在 server/data/。
 *
 * 注意：该值在模块首次 require 时求值，调用方必须在 require 任何数据模块
 * 之前设置好环境变量。
 */
const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, 'data');

module.exports = { DATA_DIR };
