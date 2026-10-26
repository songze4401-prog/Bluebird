/// <reference types="jest" />
// RequestGate：竞态防护的核心规则（阶段 3）。
//
// 这是"只认最后一次"语义的可执行定义。它保证两件事同时成立：
//   1. begin() 中止上一个在途请求（尽早止损）
//   2. isCurrent(id) 兜底丢弃旧响应（abort 来不及生效时也安全）

import { createRequestGate } from '../../lib/api/latest-request';

describe('createRequestGate', () => {
  it('首次 begin 的令牌即最新，signal 未被中止', () => {
    const gate = createRequestGate();
    const ticket = gate.begin();

    expect(gate.isCurrent(ticket.id)).toBe(true);
    expect(ticket.signal.aborted).toBe(false);
  });

  it('begin 会中止上一个在途请求，并让旧令牌失效', () => {
    const gate = createRequestGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(first.signal.aborted).toBe(true);
    expect(gate.isCurrent(first.id)).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(gate.isCurrent(second.id)).toBe(true);
  });

  it('令牌单调递增，三次 begin 只保留最后一次有效', () => {
    const gate = createRequestGate();
    const a = gate.begin();
    const b = gate.begin();
    const c = gate.begin();

    expect(b.id).toBeGreaterThan(a.id);
    expect(c.id).toBeGreaterThan(b.id);
    expect(gate.isCurrent(a.id)).toBe(false);
    expect(gate.isCurrent(b.id)).toBe(false);
    expect(gate.isCurrent(c.id)).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(c.signal.aborted).toBe(false);
  });

  it('abort() 中止当前请求但不改变令牌有效性判定', () => {
    const gate = createRequestGate();
    const ticket = gate.begin();

    gate.abort();

    expect(ticket.signal.aborted).toBe(true);
    // 令牌仍是最新：调用方据此判断"这不是被更新的请求取代"，只是被动中止
    expect(gate.isCurrent(ticket.id)).toBe(true);
  });

  it('abort 之后可以重新发起', () => {
    const gate = createRequestGate();
    gate.begin();
    gate.abort();

    const next = gate.begin();

    expect(next.signal.aborted).toBe(false);
    expect(gate.isCurrent(next.id)).toBe(true);
  });

  it('两个 gate 互不影响（历史加载与会话列表各自独立）', () => {
    const historyGate = createRequestGate();
    const listGate = createRequestGate();

    const historyTicket = historyGate.begin();
    listGate.begin();

    expect(historyTicket.signal.aborted).toBe(false);
    expect(historyGate.isCurrent(historyTicket.id)).toBe(true);
  });
});

describe('模拟 A→B 快速切换的两条响应时序', () => {
  it('A 后到：A 的令牌已失效，结果必须丢弃', () => {
    const gate = createRequestGate();

    const a = gate.begin();
    const b = gate.begin();

    // 模拟：A 的响应"绕过 abort 已经到达"
    expect(gate.isCurrent(a.id)).toBe(false);
    // 模拟：B 的响应到达
    expect(gate.isCurrent(b.id)).toBe(true);
  });

  it('B 先完成、A 后完成：两次判定都不会让 A 生效', () => {
    const gate = createRequestGate();
    const order: string[] = [];

    const a = gate.begin();
    const b = gate.begin();

    // B 先回
    if (gate.isCurrent(b.id)) order.push('B 生效');

    // A 后回
    if (gate.isCurrent(a.id)) order.push('A 生效');

    expect(order).toEqual(['B 生效']);
  });
});
