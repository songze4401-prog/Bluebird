// 「只认最后一次」的请求闸门（阶段 3）。
//
// 场景：用户快速点 A → B 两个会话，两个 /history 请求并发。
// 若 A 的响应后到，就会把 B 的消息覆盖掉、并把当前会话切回 A。
//
// 规则（两件事同时做，缺一不可）：
//   1. begin() 会中止上一个在途请求 —— 尽早止损，不浪费流量
//   2. isCurrent(id) 用请求令牌兜底 —— 即使 abort 没来得及生效
//      （响应已在路上、或运行时不支持 abort），旧响应也一律丢弃
//
// 抽成独立模块的原因：这是可以脱离 React 验证的纯逻辑，
// 放在 hook 里只能靠人读代码，放在这里能直接跑用例。

export type RequestTicket = {
  id: number;
  signal: AbortSignal;
};

export type RequestGate = {
  // 开始一次新请求：返回本次令牌，并中止上一次
  begin: () => RequestTicket;
  // 本次令牌是否仍是最新（false = 已被更新的请求取代，结果必须丢弃）
  isCurrent: (id: number) => boolean;
  // 主动中止（卸载时调用）
  abort: () => void;
};

export function createRequestGate(): RequestGate {
  let current = 0;
  let controller: AbortController | null = null;

  return {
    begin() {
      controller?.abort();

      controller = new AbortController();
      current += 1;

      return { id: current, signal: controller.signal };
    },
    isCurrent(id: number) {
      return id === current;
    },
    abort() {
      controller?.abort();
    },
  };
}
