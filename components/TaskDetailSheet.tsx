// 蓝鸟 UI 移植 · 弹层「任务详情」（原型 openTask：阶段/结果/失败原因/Worker 产物 + 动作）
// 对照后端 DAG 阶段与审校门：run=取消/重试/继续（等宽三键），done=重新发起（单键）。
// R5 起支持真实任务模式（realTask：/agent-tasks 的任务，可取消状态给「取消任务」）。
// 本组件只负责 sh-body 内容：scrim / 把手 / 标题 / ✕ 由弹层壳 SheetScaffold 统一承担。

import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { SheetScaffold } from './SheetScaffold';
import { useUi } from '../app/ui-state';
import { apiFetch } from '../lib/api/client';
import { API_PATHS } from '../lib/api/endpoints';
import type { V7Tokens } from '../app/ui-theme';
import type { DoneTask, RunningTask, StageMark } from '../data/ui-contract';

// 阶段标记 / 配色 token / 状态词（原型 smark/scol/slabel）
const STAGE_MARK: Record<StageMark, string> = { done: '✓', active: '●', wait: '○', fail: '✕' };
const STAGE_TOKEN: Record<StageMark, 'up' | 'info' | 'mut' | 'down'> = {
  done: 'up',
  active: 'info',
  wait: 'mut',
  fail: 'down',
};
const STAGE_LABEL: Record<StageMark, string> = {
  done: '完成',
  active: '进行中',
  wait: '待执行',
  fail: '失败',
};

export function TaskDetailSheet(props: {
  visible: boolean;
  onClose: () => void;
  kind?: 'run' | 'done';
  task?: RunningTask | DoneTask | null;
  // 真实任务模式（/agent-tasks）：给 goal/状态标签 + 可取消入口 + 结果/错误码
  realTask?: {
    taskId: string;
    goal: string;
    botId: string;
    statusLabel: string;
    cancellable: boolean;
    cancelRequested?: boolean;
    resultSummary?: string;
    errorCode?: string;
  } | null;
  onRealCancelled?: () => void;
}) {
  const ui = useUi();
  const t = ui.tokens;
  const styles = createStyles(t);
  const [cancelBusy, setCancelBusy] = useState(false);

  // 真实任务分支：goal + Bot/状态 chip + 结果/失败原因 + 取消任务（POST /agent-tasks/:id/cancel）。
  // 取消成功必须校验服务端真的收口（data.task.status==='cancelled'）——终态 no-op 200
  // 不能提示「已取消」（oracle 复查：假成功反馈）。
  if (props.realTask) {
    const real = props.realTask;
    const cancelTask = async () => {
      if (cancelBusy) return;
      setCancelBusy(true);
      try {
        const response = await apiFetch(
          API_PATHS.agentTaskCancel(real.taskId),
          { method: 'POST' }
        );
        if (!response.ok) {
          ui.toast('取消失败，请稍后再试');
          return;
        }
        const data = (await response.json()) as { task?: { status?: string } };
        if (data.task?.status && data.task.status !== 'cancelled') {
          ui.toast('取消未生效，请稍后再试');
          return;
        }
        ui.toast('已取消');
        props.onRealCancelled?.();
        props.onClose();
      } catch {
        ui.toast('取消失败，请稍后再试');
      } finally {
        setCancelBusy(false);
      }
    };
    return (
      <SheetScaffold visible={props.visible} onClose={props.onClose} title="任务详情">
        <View>
          <View style={styles.wtop}>
            <Text style={styles.wname} numberOfLines={1} ellipsizeMode="tail">
              {real.goal}
            </Text>
            <Text style={styles.wchip}>{real.botId}</Text>
            <Text style={styles.wchip}>{real.statusLabel}</Text>
          </View>
          {!!real.resultSummary && (
            <View>
              <Text style={styles.pglabel}>结果</Text>
              <Text style={styles.wres}>{real.resultSummary}</Text>
            </View>
          )}
          {!!real.errorCode && (
            <View>
              <Text style={styles.pglabel}>失败原因</Text>
              <Text style={styles.wfail}>{real.errorCode}</Text>
            </View>
          )}
          <View style={styles.wacts}>
            {real.cancelRequested || !real.cancellable ? (
              <View style={styles.wact}>
                <Text style={styles.wactTxt}>
                  {real.cancelRequested ? '已请求取消' : '该状态无法取消'}
                </Text>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.wact}
                disabled={cancelBusy}
                onPress={() => void cancelTask()}
              >
                <Text style={styles.wactTxt}>{cancelBusy ? '取消中…' : '取消任务'}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </SheetScaffold>
    );
  }

  // task 为 null：壳照常渲染，内容给空 View
  if (!props.task) {
    return (
      <SheetScaffold visible={props.visible} onClose={props.onClose} title="任务详情">
        <View />
      </SheetScaffold>
    );
  }
  const task = props.task;
  const kind = props.kind ?? 'run';

  // 联合收窄：RunningTask 独有 p 字段（kind 与 task 由调用方保证一致）
  const runTask: RunningTask | null = kind === 'run' && 'p' in task ? task : null;
  const doneTask: DoneTask | null = kind === 'done' && !('p' in task) ? task : null;

  // 状态 chip：run 失败→「失败」down 色；run→p%；done→「完成」up 色
  const statusChip = (): { text: string; color: string } => {
    if (runTask) {
      if (runTask.status === 'failed') return { text: '失败', color: t.down };
      return { text: runTask.p + '%', color: t.ink };
    }
    return { text: '完成', color: t.up };
  };
  const status = statusChip();

  return (
    <SheetScaffold visible={props.visible} onClose={props.onClose} title="任务详情">
      <View>
        {/* 顶行：任务名 + 机器人 chip（c 叠 1a = 12% 透明度底）+ 状态 chip */}
        <View style={styles.wtop}>
          <Text style={styles.wname} numberOfLines={1} ellipsizeMode="tail">
            {task.n}
          </Text>
          <Text style={[styles.wchip, { backgroundColor: `${task.c}1a`, color: task.c }]}>
            {task.bot}
          </Text>
          <Text style={[styles.wchip, { color: status.color }]}>{status.text}</Text>
        </View>

        {/* 阶段：标记（✓●○✕）+ 阶段名 + 状态词 */}
        {task.stages.length > 0 && (
          <View>
            <Text style={styles.pglabel}>阶段</Text>
            {task.stages.map((st, i) => (
              <View key={i} style={styles.wstage}>
                <Text style={[styles.wm, { color: t[STAGE_TOKEN[st[1]]] }]}>{STAGE_MARK[st[1]]}</Text>
                <Text style={styles.wn}>{st[0]}</Text>
                <Text style={styles.ws}>{STAGE_LABEL[st[1]]}</Text>
              </View>
            ))}
          </View>
        )}

        {/* 结果（result 非空） */}
        {task.result !== '' && (
          <View>
            <Text style={styles.pglabel}>结果</Text>
            <Text style={styles.wres}>{task.result}</Text>
          </View>
        )}

        {/* 失败原因（仅运行中且 fail 非空） */}
        {runTask?.fail ? (
          <View>
            <Text style={styles.pglabel}>失败原因</Text>
            <Text style={styles.wfail}>{runTask.fail}</Text>
          </View>
        ) : null}

        {/* Worker 产物 */}
        {task.arts.length > 0 && (
          <View>
            <Text style={styles.pglabel}>Worker 产物</Text>
            {task.arts.map(a => (
              <View key={a} style={styles.wart}>
                <Text style={styles.wf}>📄</Text>
                <Text style={styles.wn}>{a}</Text>
              </View>
            ))}
          </View>
        )}

        {/* 动作行：run=取消/重试/继续 等宽三键；done=重新发起 */}
        <View style={styles.wacts}>
          {runTask && (
            <>
              <TouchableOpacity
                style={styles.wact}
                onPress={() => {
                  ui.cancelTask(runTask);
                  props.onClose();
                }}
              >
                <Text style={styles.wactTxt}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.wact}
                onPress={() => {
                  ui.retryTask(runTask);
                  props.onClose();
                }}
              >
                <Text style={styles.wactTxt}>重试</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.wact}
                onPress={() => {
                  ui.resumeTask(runTask);
                  props.onClose();
                }}
              >
                <Text style={styles.wactTxt}>继续</Text>
              </TouchableOpacity>
            </>
          )}
          {doneTask && (
            <TouchableOpacity
              style={styles.wact}
              onPress={() => {
                ui.redoDone(doneTask);
                props.onClose();
              }}
            >
              <Text style={styles.wactTxt}>重新发起</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </SheetScaffold>
  );
}

// 原型 .wtop/.wname/.wchip/.pglabel/.wstage/.wres/.wfail/.wart/.wacts/.wact 的 RN 移植
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    // 原型 .wtop：顶行 gap8 mb10
    wtop: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
    // 原型 .wname：15 w800 flex1 省略号
    wname: { flex: 1, fontSize: 15, fontWeight: '800', color: t.ink },
    // 原型 .wchip：10 w700 r999 p3/9（底色默认 soft，文字色由调用处给）
    wchip: {
      backgroundColor: t.soft,
      fontSize: 10,
      fontWeight: '700',
      paddingVertical: 3,
      paddingHorizontal: 9,
      borderRadius: 999,
      overflow: 'hidden',
    },
    // 原型 .pglabel：10 w700 mut，margin 12/0/6，letterSpacing 1
    pglabel: {
      fontSize: 10,
      fontWeight: '700',
      color: t.mut,
      marginTop: 12,
      marginBottom: 6,
      letterSpacing: 1,
    },
    // 原型 .wstage：行 p5/0 gap12
    wstage: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 5 },
    // 原型 .wm：宽 16 居中 12 w700（颜色按阶段）
    wm: { width: 16, textAlign: 'center', fontSize: 12, fontWeight: '700' },
    wn: { flex: 1, fontSize: 12, color: t.ink },
    ws: { fontSize: 10, color: t.mut },
    // 原型 .wres：soft 底 r10 p9/12 12 ink
    wres: {
      backgroundColor: t.soft,
      borderRadius: 10,
      paddingVertical: 9,
      paddingHorizontal: 12,
      fontSize: 12,
      lineHeight: 19,
      color: t.ink,
    },
    // 原型 .wfail：红 12% 底 r10 p9/12 12 down
    wfail: {
      backgroundColor: 'rgba(229,72,77,0.12)',
      borderRadius: 10,
      paddingVertical: 9,
      paddingHorizontal: 12,
      fontSize: 12,
      lineHeight: 19,
      color: t.down,
    },
    // 原型 .wart：soft 底 r10 p7/10 mb6 gap8
    wart: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: t.soft,
      borderRadius: 10,
      paddingVertical: 7,
      paddingHorizontal: 10,
      marginBottom: 6,
    },
    wf: { fontSize: 12 },
    // 原型 .wacts：mt14 gap8
    wacts: { flexDirection: 'row', gap: 8, marginTop: 14 },
    // 原型 .wact：等宽 soft 底 r12 p10/0 12 w700 ink
    wact: {
      flex: 1,
      backgroundColor: t.soft,
      borderRadius: 12,
      paddingVertical: 10,
      alignItems: 'center',
    },
    wactTxt: { fontSize: 12, fontWeight: '700', color: t.ink },
  });
