// 分段实现已移到 lib/split-reply.js（前端流式期与服务端 done 共用同一份规则）。
// 这里保留入口，避免改动所有既有 require('./split-reply') 的调用点。
module.exports = require('../lib/split-reply');
