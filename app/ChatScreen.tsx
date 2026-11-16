// 蓝鸟 UI 移植 · 聊天整屏（原型 .pane 聊天侧的 RN 移植）
// 结构自上而下：线程消息流（用户黑泡 / blue 白泡 + 工具标签 + busy 打字三点）→
//   悬浮身份组 → 底部输入条（＋钮 / 输入框 / 发送钮）→ ＋号就地长成的选项面板。
// 三个弹层（资料编辑 / 默认模型 / 工具详情）由本屏挂载；全页透明底透出壁纸层，
// 颜色走 tokens，阴影走 V7_SHADOWS，动效只用 RN 内置 Animated。

import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ScrollViewInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useUi } from './ui-state';
import { V7_SHADOWS, type V7Tokens } from './ui-theme';
import { IdentityHeader } from '../components/IdentityHeader';
import { EditProfileSheet } from '../components/EditProfileSheet';
import { ModelPickerSheet } from '../components/ModelPickerSheet';
import { ToolDetailSheet } from '../components/ToolDetailSheet';
import type { ChatSessionApi } from '../hooks/useChatSession';
import type { AttachmentsApi } from '../hooks/useAttachments';
import { useKeyboardHeight } from '../hooks/useKeyboardHeight';
import type { ContentSegment, ModelDefaults, ModelProvider } from '../lib/types';

// 全屏绝对定位（与 app/ui-state.tsx 同款写法：本仓库 RN 版型里没有 absoluteFillObject）
const ABS_FILL = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
} as const;

// 消息时间戳（原型 .who）：ISO → HH:MM；无时间或解析失败给空串
function formatTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 原型 --spring：加号面板宽/高/圆角形变共用的弹簧曲线
const SPRING = Easing.bezier(0.3, 1.1, 0.45, 1);

// busy 打字三点（原型 .typing + @keyframes bl）：6px 圆 ink 底，透明度 0.25↔1 循环，
// 三点各延迟 150ms 相位错开、周期保持 1s；卸载时 stop 收掉。
function TypingDots() {
  const { tokens } = useUi();
  // 动画值用 useState 惰性初始化持有（渲染期读 ref.current 被 react-hooks/refs 禁止）
  const [dots] = useState(() => [0, 1, 2].map(() => new Animated.Value(0.25)));

  useEffect(() => {
    const anims = dots.map((v, i) =>
      // 先延迟 i*150ms 再进无限循环：相位错开且每点周期都是 1s（原型 animation-delay .15s/.3s）
      Animated.sequence([
        Animated.delay(i * 150),
        Animated.loop(
          Animated.sequence([
            Animated.timing(v, { toValue: 1, duration: 500, useNativeDriver: true }),
            Animated.timing(v, { toValue: 0.25, duration: 500, useNativeDriver: true }),
          ])
        ),
      ])
    );
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, [dots]);

  return (
    <View style={typingStyles.wrap}>
      {dots.map((v, i) => (
        <Animated.View
          key={i}
          style={[typingStyles.dot, { backgroundColor: tokens.ink, opacity: v }]}
        />
      ))}
    </View>
  );
}

// 打字三点的尺寸样式（颜色随主题，在组件里给）
const typingStyles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});

// 原型 .thread/.m/.who/.txt/.bub/.tool/.atchip/.chatbrand/.comp/.bar/.plus/.send/
// .pp/.ppi/.prow 的 RN 移植；fd=fontDelta：blue 白泡字号随字号设置（原型 13/15/17 三档）
const createStyles = (t: V7Tokens, fd: number) =>
  StyleSheet.create({
    // 原型 .thread：flex1 透明底透出壁纸层；paddingTop 由安全区+76 在 JSX 给（给悬浮身份组让位）
    thread: { flex: 1, backgroundColor: 'transparent' },
    threadContent: { paddingHorizontal: 18, paddingBottom: 12, gap: 20 },

    // 消息列（原型 .m：maxWidth 86%、列 gap 8；user 右对齐、blue 左对齐）
    mUser: { maxWidth: '86%', alignSelf: 'flex-end', alignItems: 'flex-end', gap: 8 },
    mBlue: { maxWidth: '86%', alignSelf: 'flex-start', alignItems: 'flex-start', gap: 8 },
    who: { fontSize: 10, color: t.ink },

    // 用户黑泡（原型 .bub：card 底，圆角 14/4/14/14，p12/15，阴影 card）
    bub: {
      backgroundColor: t.card,
      borderTopLeftRadius: 14,
      borderTopRightRadius: 4,
      borderBottomRightRadius: 14,
      borderBottomLeftRadius: 14,
      paddingVertical: 12,
      paddingHorizontal: 15,
      ...V7_SHADOWS.card,
    },
    bubTxt: { fontSize: 14, lineHeight: 23, color: t.on },
    // 附件 chip（原型 .atchip：白系 22% 底 r10 p6/10，单行省略；收在黑泡内）
    atchip: {
      alignSelf: 'flex-start',
      maxWidth: '100%',
      marginTop: 6,
      borderRadius: 10,
      backgroundColor: 'rgba(255,255,255,0.22)',
      paddingVertical: 6,
      paddingHorizontal: 10,
    },
    atchipTxt: { fontSize: 12, fontWeight: '600', color: t.on },

    // blue 白泡（原型 .txt：surface 底，圆角 4/14/14/14，p9/12，阴影 md）
    txt: {
      backgroundColor: t.surface,
      borderTopLeftRadius: 4,
      borderTopRightRadius: 14,
      borderBottomRightRadius: 14,
      borderBottomLeftRadius: 14,
      paddingVertical: 9,
      paddingHorizontal: 12,
      ...V7_SHADOWS.md,
    },
    txtTxt: { fontSize: 15 + fd, lineHeight: Math.round((15 + fd) * 1.7), color: t.ink },
    // 表情包分段 chip（历史消息可能含 sticker 段；white 泡侧用 soft 底 mut 字）
    stchip: {
      alignSelf: 'flex-start',
      maxWidth: '100%',
      borderRadius: 10,
      backgroundColor: t.soft,
      paddingVertical: 6,
      paddingHorizontal: 10,
    },
    stchipTxt: { fontSize: 12, color: t.mut },
    // 发送失败重试行（用户消息下方，红字可点）
    failTxt: { fontSize: 11, color: t.down },
    // 用户主动停止后的部分回复提示
    stoppedTxt: { fontSize: 11, color: t.mut },
    // 工具标签（原型 .tool：行 gap 8，✓ ink w700 + 文案 sec；按下开工具详情）
    tool: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    toolCk: { fontSize: 12, fontWeight: '700', color: t.ink },
    toolTxt: { fontSize: 12, color: t.sec },

    // 悬浮身份组外壳（原型 .chatbrand：top 由安全区+4 在 JSX 给；点击穿透交给 box-none）
    headerWrap: { position: 'absolute', left: 0, right: 0 },

    // 底部输入容器（原型 .comp：bottom 由安全区+12 在 JSX 给；加号面板绝对定位在其中）
    comp: { position: 'absolute', left: 0, right: 0 },
    // 待发送图片预览行（浮在输入条上方，与旧壳 ChatInput 同语义）
    pendingRow: {
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 18,
      paddingBottom: 8,
    },
    pendingItem: {
      width: 48,
      height: 48,
      borderRadius: 12,
      backgroundColor: t.surface,
      ...V7_SHADOWS.md,
    },
    pendingThumb: { width: 48, height: 48, borderRadius: 12 },
    pendingRemove: {
      position: 'absolute',
      top: -6,
      right: -6,
      width: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: t.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pendingRemoveTxt: { fontSize: 12, lineHeight: 14, color: t.on },
    pendingUploading: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    pendingUploadingTxt: { fontSize: 16, color: t.mut },
    // 输入条（原型 .bar：surface 底 r999 p6/6/6/8 阴影 lg，左右 18）
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: t.surface,
      borderRadius: 999,
      paddingTop: 6,
      paddingRight: 6,
      paddingBottom: 6,
      paddingLeft: 8,
      marginHorizontal: 18,
      ...V7_SHADOWS.lg,
    },
    // ＋钮（原型 .plus：34 圆 surface 底阴影 md；面板开着时整钮 opacity 0）
    plus: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: t.surface,
      alignItems: 'center',
      justifyContent: 'center',
      ...V7_SHADOWS.md,
    },
    plusTxt: { fontSize: 17, color: t.ink },
    input: { flex: 1, minWidth: 0, fontSize: 14, color: t.ink, paddingVertical: 0 },
    // 发送钮（原型 .send：36 圆 card 底阴影 card；disabled 时 opacity .35）
    send: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: t.card,
      alignItems: 'center',
      justifyContent: 'center',
      ...V7_SHADOWS.card,
    },
    sendTxt: { fontSize: 15, color: t.on },

    // 加号面板（原型 .pp：从＋钮位置就地长成；尺寸/圆角/透明度由动画值驱动）
    pp: {
      position: 'absolute',
      left: 18,
      bottom: 0,
      backgroundColor: t.surface,
      overflow: 'hidden',
      ...V7_SHADOWS.lg,
    },
    // 面板内容（原型 .ppi：列 gap 4 p10；透明度延迟淡入由动画值驱动）
    ppi: { flex: 1, gap: 4, padding: 10 },
    ppxRow: { flexShrink: 1, flexDirection: 'row', justifyContent: 'flex-end' },
    // 右上 ✕（原型 .ppx：30 圆 surface 底阴影 md）
    ppx: {
      width: 30,
      height: 30,
      borderRadius: 15,
      backgroundColor: t.surface,
      alignItems: 'center',
      justifyContent: 'center',
      ...V7_SHADOWS.md,
    },
    ppxTxt: { fontSize: 14, color: t.ink },
    // 面板选项行（原型 .prow：行 gap 12 p11/10 r14，按下泛 soft 底）。
    // 原型 .ppi 高 190 装不下 30+3×54 的内容，靠 CSS flex 默认收缩把行压紧；
    // RN 默认 flexShrink 0，这里显式给 1 复刻同款压缩。
    prow: {
      flexShrink: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 11,
      paddingHorizontal: 10,
      borderRadius: 14,
    },
    prowPressed: { backgroundColor: t.soft },
    pi: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: t.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    piTxt: { fontSize: 14, color: t.on },
    pl: { flex: 1, fontSize: 13, fontWeight: '500', color: t.ink },
    pv: { fontSize: 12, color: t.mut },
  });

export function ChatScreen(props: {
  chat: ChatSessionApi;
  modelLabel: string;
  models: ModelProvider[];
  currentModel: ModelDefaults | null;
  modelLoading?: boolean;
  modelError?: string;
  onSelectModel: (providerId: string, modelId: string) => Promise<boolean>;
  attachments: Pick<
    AttachmentsApi,
    'pendingAttachments' | 'uploadingImage' | 'pickImage' | 'removeAttachment'
  >;
}) {
  const ui = useUi();
  const chat = props.chat;
  const attachments = props.attachments;
  const t = ui.tokens;
  const styles = createStyles(t, ui.fontDelta);
  const insets = useSafeAreaInsets();
  // 键盘高度：输入条/线程让位都按它上移（绝对定位悬浮层不会自动避让键盘）
  const keyboardH = useKeyboardHeight();

  // 本屏挂载的弹层开关（资料编辑 / 默认模型 / 工具详情）
  const [editOpen, setEditOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [toolOpen, setToolOpen] = useState(false);
  const [tool, setTool] = useState<string | null>(null);

  // 输入框本地草稿（发送后清空）
  const [input, setInput] = useState('');

  // 加号面板：panelOpen 驱动交互（垫层/pointerEvents/＋钮透明）；progress 形变、
  // ppFade 面板整体淡入淡出（原型 .pp opacity .18s）、fade 内容延迟淡入（.ppi .16s delay .1s）
  const [panelOpen, setPanelOpen] = useState(false);
  const [progress] = useState(() => new Animated.Value(0));
  const [ppFade] = useState(() => new Animated.Value(0));
  const [fade] = useState(() => new Animated.Value(0));

  // 线程滚动引用：内容撑高后「仅在用户本就停留在底部附近」才跟随滚到底——
  // 流式增量期间用户上滑阅读不被逐帧拽回（旧壳 follow 三态机的轻量版）。
  const scrollRef = useRef<ScrollViewInstance>(null);
  const followRef = useRef(true);
  const scrollToBottom = () => {
    if (followRef.current) scrollRef.current?.scrollToEnd({ animated: false });
  };

  // 键盘弹出后把最新一条消息顶到输入条上方（等键盘动画落定再滚）
  useEffect(() => {
    if (keyboardH <= 0) return undefined;

    const timer = setTimeout(() => {
      if (followRef.current) scrollRef.current?.scrollToEnd({ animated: true });
    }, 80);

    return () => clearTimeout(timer);
  }, [keyboardH]);

  // 「模型切换」的延迟打开定时器（关面板 260ms 后开抽屉），卸载时清掉
  const modelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (modelTimer.current) clearTimeout(modelTimer.current);
    };
  }, []);

  // 面板形变三值：宽 34↔248、高 34↔190、圆角 17↔20（原型 openPlus/closePlus）
  const ppWidth = progress.interpolate({ inputRange: [0, 1], outputRange: [34, 248] });
  const ppHeight = progress.interpolate({ inputRange: [0, 1], outputRange: [34, 190] });
  const ppRadius = progress.interpolate({ inputRange: [0, 1], outputRange: [17, 20] });

  const openPanel = () => {
    setPanelOpen(true);
    progress.setValue(0);
    ppFade.setValue(0);
    fade.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: 300,
      easing: SPRING,
      useNativeDriver: false,
    }).start();
    Animated.timing(ppFade, { toValue: 1, duration: 180, useNativeDriver: false }).start();
    Animated.timing(fade, {
      toValue: 1,
      duration: 160,
      delay: 100,
      useNativeDriver: true,
    }).start();
  };

  const closePanel = () => {
    setPanelOpen(false);
    Animated.timing(progress, {
      toValue: 0,
      duration: 300,
      easing: SPRING,
      useNativeDriver: false,
    }).start();
    Animated.timing(ppFade, { toValue: 0, duration: 180, useNativeDriver: false }).start();
    Animated.timing(fade, { toValue: 0, duration: 160, useNativeDriver: true }).start();
  };

  // 加号面板：图片走真实相册选图 → 上传 → 进入待发送预览行；
  // 文件上传目前没有后端能力，保留明确的演示占位（不假装成功）。
  const pickPhoto = () => {
    if (chat.sending || chat.loadingHistory || attachments.uploadingImage) return;

    closePanel();
    void attachments.pickImage('album');
  };

  const demoFile = () => {
    ui.toast('演示版：文件上传暂未接入');
    closePanel();
  };

  // 模型切换：先收面板，260ms 后再开默认模型抽屉（原型 data-opt=model 的时序）
  const openModelPicker = () => {
    closePanel();
    if (modelTimer.current) clearTimeout(modelTimer.current);
    modelTimer.current = setTimeout(() => setModelOpen(true), 260);
  };

  // 发送：sending/loadingHistory/上传中任一拦下；有待发送图片时允许空文本发送。
  // sendMessage(undefined, undefined, { overrideText: text })：首参在契约里是
  // retryText——新发送绝不能走首参，否则用户气泡不上屏、历史上下文被截、
  // 服务端 id 改写到上一轮（oracle 复查阻断①）。
  const hasPending = attachments.pendingAttachments.length > 0;
  const canSend = !!input.trim() || hasPending;
  // 历史加载中 / 上传中都禁用发送（与旧壳 ChatInput 的 sendDisabled 同语义）
  const sendDisabled =
    !chat.sending &&
    (chat.loadingHistory || attachments.uploadingImage || !canSend);

  const doSend = () => {
    const text = input.trim();
    if (chat.sending || chat.loadingHistory || attachments.uploadingImage) return;
    if (!text && !hasPending) return;
    void chat.sendMessage(undefined, undefined, { overrideText: text });
    setInput('');
    Keyboard.dismiss();
  };

  return (
    <>
      {/* 1. 线程：透明底消息流 */}
      <ScrollView
        ref={scrollRef}
        style={styles.thread}
        contentContainerStyle={[
          styles.threadContent,
          // 底部让位 = 输入条(≈48) + 输入条底距 + 余量 12；
          // 键盘弹出时输入条上移到键盘上方，线程同步让位
          {
            paddingTop: insets.top + 76,
            paddingBottom:
              keyboardH > 0 ? keyboardH + 68 : insets.bottom + 120,
          },
        ]}
        showsVerticalScrollIndicator={false}
        onScroll={e => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          followRef.current =
            contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
        }}
        scrollEventThrottle={100}
        onContentSizeChange={scrollToBottom}
      >
        {chat.messages.map(m =>
          m.role === 'user' ? (
            /* 用户消息：右对齐列 = 时间 → 黑泡（附件 chip 收在泡内）→ 失败重试行 */
            <View key={m.id} style={styles.mUser}>
              <Text style={styles.who}>{formatTime(m.createdAt)}</Text>
              <View style={styles.bub}>
                <Text style={styles.bubTxt}>{m.content}</Text>
                {(m.attachments ?? []).map(a => (
                  <View key={a.id} style={styles.atchip}>
                    <Text numberOfLines={1} style={styles.atchipTxt}>
                      {(a.kind === 'image' ? '🖼' : '📎') + ' ' + (a.name ?? '附件')}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          ) : (
            /* blue 消息：左对齐列 = 时间 → 白泡（分段各一泡）→ 工具 pill（按下开工具详情） */
            <View key={m.id} style={styles.mBlue}>
              <Text style={styles.who}>{formatTime(m.createdAt)}</Text>
              {(m.segments ?? [{ type: 'text', text: m.content }]).map(
                (seg: ContentSegment, si: number) =>
                  seg.type === 'text' ? (
                    seg.text ? (
                      <View key={si} style={styles.txt}>
                        <Text style={styles.txtTxt}>{seg.text}</Text>
                      </View>
                    ) : null
                  ) : (
                    <View key={si} style={styles.stchip}>
                      <Text numberOfLines={1} style={styles.stchipTxt}>
                        {/* BUG-03 纪律：绝不把原始 sticker 标记透回给用户 */}
                        {seg.valid ? '🖼 表情包' : '表情已失效'}
                      </Text>
                    </View>
                  )
              )}
              {m.stopped && <Text style={styles.stoppedTxt}>已停止，以上为部分回复</Text>}
              {/* 发送失败的错误气泡是 assistant 角色 + retryText（旧壳 ChatBubble 同款语义）：
                  重试入口必须在这里，放用户分支永远不会出现（oracle 复查阻断②） */}
              {m.retryText !== undefined && (
                <Pressable
                  onPress={() => void chat.sendMessage(m.retryText, m.retryAttachments)}
                  disabled={chat.sending}
                  accessibilityRole="button"
                  accessibilityLabel="重试发送"
                >
                  <Text style={styles.failTxt}>发送失败 · 点击重试</Text>
                </Pressable>
              )}
              {(m.toolSteps ?? []).map((step, ti) => (
                <Pressable
                  key={ti}
                  style={styles.tool}
                  onPress={() => {
                    setTool(step.name + ' · ' + step.summary);
                    setToolOpen(true);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={'工具调用详情：' + step.name}
                >
                  <Text style={[styles.toolCk, { color: step.ok ? t.ink : t.down }]}>
                    {step.running ? '●' : step.ok ? '✓' : '✕'}
                  </Text>
                  <Text numberOfLines={1} style={styles.toolTxt}>
                    {step.name + (step.summary ? ' · ' + step.summary : '')}
                  </Text>
                </Pressable>
              ))}
            </View>
          )
        )}
        {/* sending：线程尾打字三点 */}
        {chat.sending && <TypingDots />}
      </ScrollView>

      {/* 2. 悬浮身份组：点身份 pill 开资料弹层（外壳 box-none 不吃两侧点击） */}
      <View pointerEvents="box-none" style={[styles.headerWrap, { top: insets.top + 4 }]}>
        <IdentityHeader onOpenProfile={() => setEditOpen(true)} />
      </View>

      {/* 3. 加号面板开着时垫全屏透明垫层：点面板外任意处收面板 */}
      {panelOpen && (
        <Pressable
          style={ABS_FILL}
          onPress={closePanel}
          accessibilityRole="button"
          accessibilityLabel="关闭加号面板"
        />
      )}

      {/* 4. 底部输入条 + 加号面板：输入条悬在底部导航（44+12）之上，
          与原型 .pane padding-bottom 60 同款让位 */}
      <View
        style={[
          styles.comp,
          { bottom: keyboardH > 0 ? keyboardH + 8 : insets.bottom + 60 },
        ]}
      >
        {/* 待发送图片预览行：缩略图 + × 移除；上传中显示占位 */}
        {(attachments.pendingAttachments.length > 0 || attachments.uploadingImage) && (
          <View style={styles.pendingRow}>
            {attachments.pendingAttachments.map(item => (
              <View key={item.attachment.id} style={styles.pendingItem}>
                <Image source={{ uri: item.previewUri }} style={styles.pendingThumb} />
                <Pressable
                  style={styles.pendingRemove}
                  onPress={() => attachments.removeAttachment(item.attachment.id)}
                  accessibilityRole="button"
                  accessibilityLabel="移除图片"
                  hitSlop={6}
                >
                  <Text style={styles.pendingRemoveTxt}>×</Text>
                </Pressable>
              </View>
            ))}
            {attachments.uploadingImage && (
              <View style={[styles.pendingItem, styles.pendingUploading]}>
                <Text style={styles.pendingUploadingTxt}>…</Text>
              </View>
            )}
          </View>
        )}

        <View style={styles.bar}>
          <Pressable
            style={[styles.plus, { opacity: panelOpen ? 0 : 1 }]}
            onPress={openPanel}
            accessibilityRole="button"
            accessibilityLabel="更多选项"
          >
            <Text style={styles.plusTxt}>＋</Text>
          </Pressable>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="与 Bluebird 对话…"
            placeholderTextColor={t.mut}
            blurOnSubmit={false}
            onSubmitEditing={doSend}
          />
          <Pressable
            style={[styles.send, { opacity: chat.sending ? 1 : sendDisabled ? 0.35 : 1 }]}
            disabled={sendDisabled}
            onPress={() => {
              if (chat.sending) {
                chat.stopGeneration();
                return;
              }
              doSend();
            }}
            accessibilityRole="button"
            accessibilityLabel={chat.sending ? '停止生成' : '发送'}
          >
            <Text style={styles.sendTxt}>{chat.sending ? '■' : '↑'}</Text>
          </Pressable>
        </View>

        {/* 加号面板（原型 .pp 就地长成）：宽/高/圆角 300ms 弹簧形变，内容延迟淡入 */}
        <Animated.View
          pointerEvents={panelOpen ? 'auto' : 'none'}
          style={[
            styles.pp,
            { width: ppWidth, height: ppHeight, borderRadius: ppRadius, opacity: ppFade },
          ]}
        >
          <Animated.View style={[styles.ppi, { opacity: fade }]}>
            <View style={styles.ppxRow}>
              <Pressable
                style={styles.ppx}
                onPress={closePanel}
                accessibilityRole="button"
                accessibilityLabel="关闭面板"
              >
                <Text style={styles.ppxTxt}>✕</Text>
              </Pressable>
            </View>
            <Pressable
              style={({ pressed }) => [styles.prow, pressed && styles.prowPressed]}
              onPress={pickPhoto}
              accessibilityRole="button"
              accessibilityLabel="图片"
            >
              <View style={styles.pi}>
                <Text style={styles.piTxt}>🖼</Text>
              </View>
              <Text style={styles.pl}>图片</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.prow, pressed && styles.prowPressed]}
              onPress={demoFile}
              accessibilityRole="button"
              accessibilityLabel="文件"
            >
              <View style={styles.pi}>
                <Text style={styles.piTxt}>📎</Text>
              </View>
              <Text style={styles.pl}>文件</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.prow, pressed && styles.prowPressed]}
              onPress={openModelPicker}
              accessibilityRole="button"
              accessibilityLabel="模型切换"
            >
              <View style={styles.pi}>
                <Text style={styles.piTxt}>◉</Text>
              </View>
              <Text style={styles.pl}>模型切换</Text>
              <Text style={styles.pv}>{props.modelLabel}</Text>
            </Pressable>
          </Animated.View>
        </Animated.View>
      </View>

      {/* 5. 本屏弹层：资料编辑 / 默认模型 / 工具详情 */}
      <EditProfileSheet
        visible={editOpen}
        onClose={() => setEditOpen(false)}
        providers={props.models}
        currentModel={props.currentModel}
        onSelectModel={props.onSelectModel}
      />
      <ModelPickerSheet
        visible={modelOpen}
        onClose={() => setModelOpen(false)}
        providers={props.models}
        current={props.currentModel}
        loading={props.modelLoading}
        error={props.modelError}
        onSelect={props.onSelectModel}
      />
      <ToolDetailSheet visible={toolOpen} onClose={() => setToolOpen(false)} tool={tool} />
    </>
  );
}
