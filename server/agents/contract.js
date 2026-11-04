/**
 * Task Contract 契约版本（S9：唯一定义处）。
 *
 * 这里只描述任务契约对象的形状版本：字段增删/语义变化才调整。
 * 它既不是 checkpoint 序号（`checkpointVersion`），也不是计划版本
 * （`planId`/`planVersion`），更不是 CAS 版本（`stateVersion`，属 ② 范围）。
 */
const CONTRACT_VERSION = 1;

module.exports = { CONTRACT_VERSION };
