// 记忆核心状态唯一注入容器（健康度审计 state-holder 统一设计，2026-11-21）。
//
// 背景：memory.js 的迁移模块（memory-extraction/memory-retrieval/
// memory-feedback 及后续生命周期簇）各自造容器函数与键名，键面随刀数
// 漂移，wrong-source import 与 TDZ 复发面线性上升（R3a 一枪双中实证）。
// 本模块把它们收拢为唯一容器与键名约定：
// - memory.js 是唯一注入方（全部消费方都模块经 memory.js 加载）；
// - 键分三域：状态读写（getMemoryList/setMemoryList/getMemories/
//   getPendingMemories/memoryEnabled）、写基础设施（enqueueWrite/
//   saveMemories/commitWithTombstones/refreshDerivedMemoryIndex/
//   trimToCapacity/maintenanceKeywords）、圈依赖与观测（logDataEvent/
//   monitoring/memoryFile/logLifecycleEvent/logLifecycleRejection）。
// - 本模块零依赖、零状态（容器本体只有一个引用槽），不参与加载圈。
let core = null;
function injectMemoryCore(deps) {
  core = deps;
}
function memoryCore() {
  if (!core) {
    throw new Error(
      'memory-core: 依赖未注入（injectMemoryCore）——本模块须在 memory.js 加载后使用'
    );
  }
  return core;
}
module.exports = { injectMemoryCore, memoryCore };
