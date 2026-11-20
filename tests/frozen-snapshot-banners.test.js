/**
 * 历史快照横幅守卫（2026-11-21 收尾条 5，可选清理项）。
 *
 * DEPENDENCY_MAP.md / HEALTH_DASHBOARD.html 是冻结在 a3569e34 的静态快照，
 * 数字与行号早已漂移。#113 的处置不是更新数字，而是把「不随主干更新」写在
 * 文件里，避免有人把它当现状引用。本测试守住这条声明本身：横幅一旦被删或
 * 被改回「实时数据」，就会红——那时要么补声明，要么真的重建快照。
 *
 * 运行：node tests/frozen-snapshot-banners.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASELINE = 'a3569e34';

test('DEPENDENCY_MAP.md 声明自己是冻结快照且不随主干更新', () => {
  const text = fs.readFileSync(path.join(ROOT, 'DEPENDENCY_MAP.md'), 'utf8');
  const head = text.split('\n').slice(0, 12).join('\n');

  assert.ok(head.includes(BASELINE), 'DEPENDENCY_MAP 头部丢了基线提交指针');
  assert.match(head, /快照文档|不随主干更新/, 'DEPENDENCY_MAP 丢了「快照/不随主干更新」声明');
  assert.match(head, /过时/, 'DEPENDENCY_MAP 丢了「数字已过时」的提醒，容易被当现状引用');
});

test('HEALTH_DASHBOARD.html 标题与注释都标明历史快照', () => {
  const text = fs.readFileSync(path.join(ROOT, 'HEALTH_DASHBOARD.html'), 'utf8');

  assert.match(text, /<title>[^<]*历史快照[^<]*<\/title>/, '页面标题不再标明历史快照');
  assert.ok(text.includes(BASELINE), '页面里丢了基线提交指针');
  assert.match(text, /不随主干(刷新|更新)/, '页面丢了「不随主干刷新」声明');
});
