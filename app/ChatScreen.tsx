// 蓝鸟 UI 移植 · 聊天整屏（原型 .pane 聊天侧的 RN 移植）
// 结构自上而下：线程消息流（用户黑泡 / blue 白泡 + 工具标签 + busy 打字三点）→
//   悬浮身份组 → 底部输入条（＋钮 / 输入框 / 发送钮）→ ＋号就地长成的选项面板。
// 三个弹层（资料编辑 / 默认模型 / 工具详情）由本屏挂载；全页透明底透出壁纸层，
// 颜色走 tokens，阴影走 V7_SHADOWS，动效只用 RN 内置 Animated。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Clipboard,
  Easing,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ScrollViewInstance,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useUi } from './ui-state';
import { V7_SHADOWS, type V7Tokens } from './ui-theme';
import { getTheme } from '../theme';
import { MarkdownMessage } from '../components/MarkdownMessage';
import { SheetScaffold } from '../components/SheetScaffold';
import { parseStickerMarkers } from '../lib/utils';
import { buildWelcomeMessages } from '../lib/chat-messages';
import { IdentityHeader } from '../components/IdentityHeader';
import { EditProfileSheet } from '../components/EditProfileSheet';
import { ModelPickerSheet } from '../components/ModelPickerSheet';
import { ToolDetailSheet } from '../components/ToolDetailSheet';
import type { ChatSessionApi } from '../hooks/useChatSession';
import type { AttachmentsApi } from '../hooks/useAttachments';
import {
  IMAGE_AUTH_HEADERS,
  imageUrl,
  listStickerRepo,
  stickerImageUrl,
} from '../lib/uploads';
import type {
  Attachment,
  ContentSegment,
  Message,
  ModelDefaults,
  ModelProvider,
} from '../lib/types';

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

// 任务书接法 a：待确认写入的模式文案（create/overwrite/append → 新建/覆盖/追加）
function wsModeLabel(mode: 'create' | 'overwrite' | 'append'): string {
  if (mode === 'append') return '追加';
  if (mode === 'overwrite') return '覆盖';
  return '新建';
}

// 行内表情包图片（旧壳 InlineSticker 同源：/sticker-repo/:id/image + 鉴权头）。
// 模块级组件：定义在 ChatScreen 函数体内会因父组件每次渲染重挂（failed 状态被
// 重置、图片反复请求），必须提出来。
function InlineStickerImage({
  id,
  valid,
  styles,
}: {
  id: string;
  valid: boolean;
  styles: ReturnType<typeof createStyles>;
}) {
  const [failed, setFailed] = useState(!valid);
  if (failed) {
    return (
      <View style={styles.stchip}>
        <Text numberOfLines={1} style={styles.stchipTxt}>
          表情包已失效
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.stchip}>
      <ExpoImage
        source={{ uri: stickerImageUrl(id), headers: IMAGE_AUTH_HEADERS }}
        style={styles.inlineSticker}
        contentFit="contain"
        onError={() => setFailed(true)}
        accessibilityLabel="表情包"
      />
    </View>
  );
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
    // 提示条（modelNote/agentNotice/memoryNote，旧壳 ChatBubble 同语义）与收藏标记
    noteTxt: { fontSize: 11, color: t.mut, lineHeight: 16 },
    favStar: { fontSize: 11, color: t.warn },
    // 历史分页头 + 加载提示（旧壳 MessageList listHeader 同语义）
    loadOlder: {
      alignSelf: 'center',
      borderRadius: 999,
      backgroundColor: t.soft,
      paddingVertical: 7,
      paddingHorizontal: 14,
      marginBottom: 8,
    },
    loadOlderTxt: { fontSize: 12, color: t.sec },
    loadingTxt: { alignSelf: 'center', fontSize: 12, color: t.mut, marginBottom: 8 },
    // 消息操作弹层（SheetScaffold children）
    actWrap: { gap: 8, paddingBottom: 12 },
    actTitle: { fontSize: 12, fontWeight: '700', color: t.sec, paddingTop: 4 },
    actRow: {
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderRadius: 12,
      backgroundColor: t.soft,
    },
    actRowTxt: { fontSize: 14, color: t.ink },
    // 消息附件媒体（旧壳 BubbleAttachments）
    mediaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, maxWidth: '86%' },
    mediaRowEnd: { alignSelf: 'flex-end', justifyContent: 'flex-end' },
    mediaImage: { width: 160, height: 120, borderRadius: 12, ...V7_SHADOWS.md },
    mediaSticker: { width: 110, height: 110, borderRadius: 10, ...V7_SHADOWS.md },
    mediaBox: { borderRadius: 10, backgroundColor: t.soft },
    mediaExpired: { width: 110, height: 80, alignItems: 'center', justifyContent: 'center' },
    mediaExpiredTxt: { fontSize: 11, color: t.mut },
    // 行内表情（旧壳 InlineSticker）
    inlineSticker: { width: 64, height: 64, borderRadius: 8 },
    // 表情包选择器网格
    stkGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
      paddingBottom: 12,
    },
    stkThumb: { width: 72, height: 72, borderRadius: 10, backgroundColor: t.soft },
    stkAdd: {
      width: 72,
      height: 72,
      borderRadius: 10,
      borderWidth: 1.5,
      borderColor: t.mut,
      borderStyle: 'dashed',
      alignItems: 'center',
      justifyContent: 'center',
    },
    stkAddTxt: { fontSize: 22, color: t.mut },
    // 返回底部箭头
    jumpBtn: {
      position: 'absolute',
      right: 18,
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: t.surface,
      alignItems: 'center',
      justifyContent: 'center',
      ...V7_SHADOWS.md,
    },
    jumpTxt: { fontSize: 16, color: t.ink },
    // 工具标签（原型 .tool：行 gap 8，✓ ink w700 + 文案 sec；按下开工具详情）
    tool: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    toolCk: { fontSize: 12, fontWeight: '700', color: t.ink },
    toolTxt: { fontSize: 12, color: t.sec },
    // 任务书接法 a：待确认写入行（surface 卡 + 确认/取消；颜色全走 tokens）
    wsPending: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderRadius: 12,
      backgroundColor: t.surface,
      paddingHorizontal: 10,
      paddingVertical: 8,
      ...V7_SHADOWS.md,
    },
    wsPendingTxt: { flex: 1, fontSize: 12, color: t.sec },
    wsPendingBtns: { flexDirection: 'row', gap: 12 },
    wsPendingOk: { fontSize: 12, fontWeight: '700', color: t.ink },
    wsPendingNo: { fontSize: 12, color: t.down },

    // 悬浮身份组外壳（原型 .chatbrand：top 由安全区+4 在 JSX 给；点击穿透交给 box-none）
    headerWrap: { position: 'absolute', left: 0, right: 0 },

    // v7 屏根：常规流列布局（键盘避让走壳层 KAV padding）
    screen: { flex: 1 },
    // 悬浮输入坞：脱离常规流贴在消息流上方，bottom 由 JSX 按安全区/键盘给
    compDock: { position: 'absolute', left: 0, right: 0 },
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
    input: {
      flex: 1,
      minWidth: 0,
      fontSize: 14,
      color: t.ink,
      paddingVertical: 0,
      // multiline：内容高由 onContentSizeChange 驱动（上限 120，见 TextInput style）
    },
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
    ppxRow: { flexDirection: 'row', justifyContent: 'flex-end' },
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
    // 面板高度按内容给足（见 ppHeight），行不再收缩，避免文字叠在一起。
    prow: {
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
    pl: { flexShrink: 0, fontSize: 13, fontWeight: '500', color: t.ink },
    pv: { flexShrink: 1, fontSize: 12, color: t.mut },
  });

export function ChatScreen(props: {
  chat: ChatSessionApi;
  sessionId?: string;
  modelLabel: string;
  models: ModelProvider[];
  currentModel: ModelDefaults | null;
  modelLoading?: boolean;
  modelError?: string;
  onSelectModel: (providerId: string, modelId: string) => Promise<boolean>;
  attachments: Pick<
    AttachmentsApi,
    'pendingAttachments' | 'uploadingImage' | 'pickImage' | 'pickSticker' | 'removeAttachment'
  >;
  // 表情包点按直发（旧壳 App.sendSticker 同语义：附件即消息，无正文）
  onSendSticker?: (attachment: Attachment) => void;
  // 消息长按操作（旧壳 MessageActionSheet 语义）：收藏/隐藏为可选（桩测试可不传）
  isFavorite?: (message: Message) => boolean;
  onToggleFavorite?: (message: Message) => void;
  // 弹层打开/关闭通知：壳层的悬浮导航在 pane 之上，弹层需要它临时收起
  onSheetOpenChange?: (open: boolean) => void;
  onHideMessage?: (message: Message) => void;
}) {
  const ui = useUi();
  const chat = props.chat;
  const attachments = props.attachments;
  const t = ui.tokens;
  const styles = createStyles(t, ui.fontDelta);
  const insets = useSafeAreaInsets();
  // 键盘避让改走壳层 KeyboardAvoidingView padding（旧壳同款机制，真机实证可用）：
  // 输入条回到常规流，键盘弹出时 KAV 收缩容器 → 输入条原生上移，不依赖键盘高度事件
  // （WorkBuddy 的 keyboardH 事件方案在部分安卓 edge-to-edge 设备上不触发，实测踩坑）
  // 助手气泡的 markdown 渲染用旧壳主题桥（MarkdownMessage 吃 theme.ts 的 Theme）
  const legacyTheme = useMemo(
    () => getTheme(t.isDark ? 'dark' : 'light'),
    [t.isDark]
  );

  // 本屏挂载的弹层开关（资料编辑 / 默认模型 / 工具详情 / 消息操作 / 表情包选择）
  const [editOpen, setEditOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [toolOpen, setToolOpen] = useState(false);
  // 任务书接法 a：工作区写入确认行的忙态（按 confirmationId 防双击）
  const [wsBusyId, setWsBusyId] = useState<string | null>(null);
  const handleWorkspacePending = async (id: string, confirm: boolean) => {
    setWsBusyId(id);
    try {
      if (confirm) await chat.confirmWorkspaceWrite(id);
      else await chat.rejectWorkspaceWrite(id);
    } catch (error) {
      Alert.alert(
        '操作失败',
        error instanceof Error && error.message ? error.message : '请稍后再试。'
      );
    } finally {
      setWsBusyId(null);
    }
  };
  const [tool, setTool] = useState<string | null>(null);
  const [stickersOpen, setStickersOpen] = useState(false);
  // 表情包仓库列表（GET /sticker-repo，打开选择器时拉取）
  const [stickers, setStickers] = useState<Attachment[] | null>(null);

  // 输入框本地草稿（发送后清空）
  const [input, setInput] = useState('');
  // 多行输入的实时内容高（onContentSizeChange 驱动，1~120px 自动增高）
  const [inputH, setInputH] = useState(22);
  // 键盘实测高度：Expo Go 里 adjustResize 不生效（app.json 是原生清单属性），
  // 只能按键盘高度把输入条顶上去，否则键盘会直接盖住输入框（真机复现）。
  // 底部导航由壳层在键盘弹出时收起（悬浮层，避免被顶到输入条上方）。
  const [keyboardH, setKeyboardH] = useState(0);
  // 返回底部箭头（用户上滑阅读后出现）
  const [showJump, setShowJump] = useState(false);
  // 长按操作：open 控制弹层显隐（关闭动画期间保留目标消息，避免滑出动画里空白）
  const [actionOpen, setActionOpen] = useState(false);
  const [actionMsg, setActionMsg] = useState<Message | null>(null);

  // 任一弹层打开时通知壳层收起悬浮导航：弹层在聊天 pane 内，层级上盖不过壳层导航，
  // 不收起会把弹层底部（如「人设」字数）压在导航下面。
  const onSheetOpenChange = props.onSheetOpenChange;
  useEffect(() => {
    onSheetOpenChange?.(
      editOpen || modelOpen || toolOpen || actionOpen || stickersOpen
    );
  }, [editOpen, modelOpen, toolOpen, actionOpen, stickersOpen, onSheetOpenChange]);

  // 线程滚动引用：内容撑高后「仅在用户本就停留在底部附近」才跟随滚到底——
  // 流式增量期间用户上滑阅读不被逐帧拽回（旧壳 follow 三态机的轻量版）。
  const scrollRef = useRef<ScrollViewInstance>(null);
  const followRef = useRef(true);
  // 向上翻页的一次性闸门：到顶自动触发后关闭，加载结束才重开（防滚动事件连发刷请求）
  const olderGuard = useRef(true);
  const scrollToBottom = () => {
    if (followRef.current) scrollRef.current?.scrollToEnd({ animated: false });
  };

  // 会话切换时清掉长按目标：跨会话的撤回/隐藏会打错目标（oracle 建议）。
  // 用 React 官方「渲染期对比 prev props 调整 state」模式（effect 内同步 setState 会被禁）。
  const [prevSessionId, setPrevSessionId] = useState(props.sessionId);
  if (prevSessionId !== props.sessionId) {
    setPrevSessionId(props.sessionId);
    setActionMsg(null);
    setActionOpen(false);
    setShowJump(false);
  }

  // 切会话/首次载入历史后必须跟到底部：沿用上一个会话的上滑状态会把新会话停在中间。
  // ref 不能在渲染期写，放到会话变化后的 effect 里复位。
  useEffect(() => {
    followRef.current = true;
  }, [props.sessionId]);

  // 长按入口：记录目标消息并打开弹层
  const openMsgActions = (m: Message) => {
    setActionMsg(m);
    setActionOpen(true);
  };

  // 加号面板：panelOpen 驱动交互（垫层/pointerEvents/＋钮透明）；progress 形变、
  // ppFade 面板整体淡入淡出（原型 .pp opacity .18s）、fade 内容延迟淡入（.ppi .16s delay .1s）
  const [panelOpen, setPanelOpen] = useState(false);
  const [progress] = useState(() => new Animated.Value(0));
  const [ppFade] = useState(() => new Animated.Value(0));
  const [fade] = useState(() => new Animated.Value(0));

  // 消息附件媒体（旧壳 BubbleAttachments 同源：uploads / 表情包仓库路由 + 鉴权头；
  // 仓库条目被物理删除时 GET /history 标注 expired → 占位）
  const renderMedia = (m: Message, fromUser: boolean) => {
    const atts = m.attachments ?? [];
    if (atts.length === 0) return null;
    return (
      <View style={[styles.mediaRow, fromUser && styles.mediaRowEnd]}>
        {atts.map(att =>
          att.expired ? (
            <View key={att.id} style={[styles.mediaBox, styles.mediaExpired]}>
              <Text style={styles.mediaExpiredTxt}>表情已删除</Text>
            </View>
          ) : (
            <ExpoImage
              key={att.id}
              source={{
                uri:
                  att.kind === 'sticker'
                    ? stickerImageUrl(att.id)
                    : imageUrl(att.id),
                headers: IMAGE_AUTH_HEADERS,
              }}
              style={att.kind === 'sticker' ? styles.mediaSticker : styles.mediaImage}
              contentFit={att.kind === 'sticker' ? 'contain' : 'cover'}
              transition={120}
              accessibilityLabel={att.name || '图片'}
            />
          )
        )}
      </View>
    );
  };

  // 助手正文渲染（旧壳 ChatBubble 同款语义分流）：
  //   含 sticker 段 → 分段渲染（text 段走 markdown / sticker 段走失效占位 chip）；
  //   纯文本 → 整段 MarkdownMessage。
  const renderAssistantContent = (m: Message) => {
    const hasSticker =
      m.segments?.some(s => s.type === 'sticker') ||
      (!m.segments && /\[sticker:[^\]]+\]/.test(m.content));
    if (!m.content && !hasSticker) return null;
    if (!hasSticker) {
      return (
        <View style={styles.txt}>
          <MarkdownMessage content={m.content} theme={legacyTheme} />
        </View>
      );
    }
    const segs: ContentSegment[] =
      m.segments ?? parseStickerMarkers(m.content);
    return segs.map((seg, si) =>
      seg.type === 'text' && seg.text ? (
        <View key={si} style={styles.txt}>
          <MarkdownMessage content={seg.text} theme={legacyTheme} />
        </View>
      ) : seg.type === 'sticker' ? (
        // 行内表情：真图（仓库路由 + 鉴权头）；加载失败/已失效 → 灰字占位（BUG-03）
        <InlineStickerImage key={si} id={seg.id} valid={seg.valid} styles={styles} />
      ) : null
    );
  };

  // 键盘高度：Expo Go 的窗口不随键盘 resize，输入条必须按实测高度抬起来
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', e => {
      setKeyboardH(e.endCoordinates?.height ?? 0);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardH(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // 「模型切换」的延迟打开定时器（关面板 260ms 后开抽屉），卸载时清掉
  const modelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (modelTimer.current) clearTimeout(modelTimer.current);
    };
  }, []);

  // 悬浮输入坞的实际高度：输入条（上下 6 + 内容行高）+ 可选待发送预览行，
  // 消息流底部预留必须按它算，否则键盘弹起后最后一条会被输入坞压住（真机复现）。
  const inputClampedH = Math.min(Math.max(inputH, 22), 120);
  const barH = 12 + Math.max(34, inputClampedH, 36);
  const pendingH =
    attachments.pendingAttachments.length > 0 || attachments.uploadingImage ? 56 : 0;
  const dockH = barH + pendingH;
  // 无键盘时让出悬浮导航（44+12+8）＋输入坞＋间距；键盘弹起时让出键盘实测高度＋输入坞＋间距
  const threadPadBottom =
    keyboardH > 0 ? keyboardH + 8 + dockH + 16 : insets.bottom + 64 + dockH + 16;

  // 键盘弹起会改变底部预留高度：若用户本就停在底部，等布局稳定后再贴一次底，
  // 避免输入条上移后最后一条气泡被盖住。
  useEffect(() => {
    if (keyboardH <= 0 || !followRef.current) return undefined;
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
    }, 60);
    return () => clearTimeout(timer);
  }, [keyboardH]);

  // 面板形变三值：宽 34↔248、高 34↔190、圆角 17↔20（原型 openPlus/closePlus）
  const ppWidth = progress.interpolate({ inputRange: [0, 1], outputRange: [34, 248] });
  // 内容实际高度：padding 20 + 关闭行 30 + 4 行（32 图标 + 22 内边距）= 282，
  // 原来固定 190 会把四行压扁、文字互相叠住（真机复现）。
  const ppHeight = progress.interpolate({ inputRange: [0, 1], outputRange: [34, 284] });
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

  // 表情包选择器：每次打开都重拉仓库（瞬时网络失败不能把选择器打瘫到重启——
  // 旧壳 PlusPanel 每次打开都重拉同语义）
  const openStickerPicker = () => {
    closePanel();
    setStickers(null);
    setStickersOpen(true);
    listStickerRepo()
      .then(setStickers)
      .catch(() => {
        ui.toast('读取表情包仓库失败');
        setStickers([]);
      });
  };

  // 表情包点按直发：附件即消息，无正文（旧壳 App.sendSticker 同语义）。
  // 回复生成中/历史加载中不发也不关面板（旧壳 PlusPanel busy 时 disabled 同语义）
  const sendStickerNow = (att: Attachment) => {
    if (chat.sending || chat.loadingHistory) {
      ui.toast('正在回复中，请稍后再试');
      return;
    }
    props.onSendSticker?.(att);
    setStickersOpen(false);
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

  // 空会话占位：v7 壳启动会复用 0 消息草稿会话（markHistoryLoaded 后 messages 恒为空），
  // 没有空态时整屏空白；这里与旧壳 loadHistory(空) 同款，用欢迎语顶上。
  const displayMessages =
    !chat.loadingHistory && chat.messages.length === 0
      ? buildWelcomeMessages()
      : chat.messages;

  return (
    /* 根改常规流列布局：键盘避让走壳层 KAV padding（收缩容器→常规流的输入条原生上移），
       不再用绝对定位 + keyboardH 手动偏移（部分安卓 edge-to-edge 设备键盘事件不触发） */
    <View style={styles.screen}>
      {/* 1. 线程：透明底消息流 */}
      <ScrollView
        ref={scrollRef}
        style={styles.thread}
        contentContainerStyle={[
          styles.threadContent,
          // 顶部给悬浮身份组让位；底部预留按输入坞实测高度 + 键盘高度动态算，
          // 输入坞与导航都是悬浮层，消息滚到底时停在它们上方，不被遮挡。
          { paddingTop: insets.top + 76, paddingBottom: threadPadBottom },
        ]}
        showsVerticalScrollIndicator={false}
        onScroll={e => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          followRef.current =
            contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
          // 滚回底部时收起「返回底部」箭头（旧壳箭头纯由距底距离驱动）
          if (followRef.current && showJump) setShowJump(false);
          // 到顶自动加载更早消息（一次性闸门防滚动连发；hook 内部另有并发守卫）
          if (
            olderGuard.current &&
            contentOffset.y < 60 &&
            chat.hasMoreHistory &&
            !chat.loadingOlder
          ) {
            olderGuard.current = false;
            void chat
              .loadOlderHistory()
              .then(() => {
                olderGuard.current = true;
              })
              .catch(() => {
                olderGuard.current = true;
              });
          }
        }}
        scrollEventThrottle={100}
        onLayout={() => scrollToBottom()}
        onContentSizeChange={() => {
          if (followRef.current) {
            scrollToBottom();
            // 消息 + 底部预留 padding 量高会跨一帧：下一帧再贴一次底，
            // 避免首屏历史停在中间、最后一条被悬浮输入条压住
            requestAnimationFrame(() => scrollToBottom());
          } else {
            setShowJump(true);
          }
        }}
      >
        {/* 历史分页头：有更早消息时的手动入口（滚动到顶也会自动触发，旧壳 MessageList 同语义） */}
        {chat.hasMoreHistory && (
          <Pressable
            style={styles.loadOlder}
            disabled={chat.loadingOlder}
            onPress={() => void chat.loadOlderHistory()}
            accessibilityRole="button"
            accessibilityLabel="加载更早消息"
          >
            <Text style={styles.loadOlderTxt}>
              {chat.loadingOlder ? '正在加载更早消息…' : '加载更早消息'}
            </Text>
          </Pressable>
        )}
        {chat.loadingHistory && <Text style={styles.loadingTxt}>正在读取对话…</Text>}
        {displayMessages.map(m =>
          m.role === 'user' ? (
            /* 用户消息：右对齐列 = 时间 → 黑泡（附件 chip 收在泡内）；长按开消息操作 */
            <Pressable
              key={m.id}
              style={styles.mUser}
              onLongPress={() => openMsgActions(m)}
              delayLongPress={350}
            >
              <Text style={styles.who}>
                {formatTime(m.createdAt)}
                {props.isFavorite?.(m) ? ' ★' : ''}
              </Text>
              {renderMedia(m, true)}
              <View style={styles.bub}>
                <Text style={styles.bubTxt}>{m.content}</Text>
              </View>
            </Pressable>
          ) : (
            /* blue 消息：左对齐列 = 时间 → 白泡（markdown/sticker 分流）→ 停止/提示条 →
               工具 pill → 收藏标记；长按任意处开消息操作（旧壳 MessageActionSheet 语义） */
            <Pressable
              key={m.id}
              style={styles.mBlue}
              onLongPress={() => openMsgActions(m)}
              delayLongPress={350}
            >
              <Text style={styles.who}>{formatTime(m.createdAt)}</Text>
              {renderAssistantContent(m)}
              {renderMedia(m, false)}
              {m.stopped && <Text style={styles.stoppedTxt}>已停止生成 · 本机保留的部分回复</Text>}
              {!!m.modelNote && <Text style={styles.noteTxt}>{m.modelNote}</Text>}
              {!!m.agentNotice && <Text style={styles.noteTxt}>{m.agentNotice}</Text>}
              {!!m.memoryNote && <Text style={styles.noteTxt}>{m.memoryNote}</Text>}
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
              {(m.toolSteps ?? []).map((step, ti) => {
                const pending = step.pendingConfirmation;
                if (!pending || step.resolved) {
                  return (
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
                  );
                }
                return (
                  // 任务书接法 a：待确认写入行——确认后由 /workspace/pending/:id/confirm
                  // 重查沙箱并落盘；取消只删除服务端 pending 记录。
                  <View key={ti} style={styles.wsPending}>
                    <Text numberOfLines={1} style={styles.wsPendingTxt}>
                      {`待确认写入：${pending.path}（${wsModeLabel(pending.mode)} · ${pending.bytes} 字节）`}
                    </Text>
                    <View style={styles.wsPendingBtns}>
                      <Pressable
                        onPress={() => void handleWorkspacePending(pending.id, true)}
                        disabled={wsBusyId === pending.id}
                        accessibilityRole="button"
                        accessibilityLabel={`确认写入 ${pending.path}`}
                      >
                        <Text style={styles.wsPendingOk}>
                          {wsBusyId === pending.id ? '…' : '确认写入'}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => void handleWorkspacePending(pending.id, false)}
                        disabled={wsBusyId === pending.id}
                        accessibilityRole="button"
                        accessibilityLabel={`取消写入 ${pending.path}`}
                      >
                        <Text style={styles.wsPendingNo}>取消</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
              {props.isFavorite?.(m) && <Text style={styles.favStar}>★ 已收藏</Text>}
            </Pressable>
          )
        )}
        {/* sending：在途工具 pill + 打字三点（旧壳 AgentRunBlock footer 的 v7 版） */}
        {chat.sending &&
          chat.liveToolSteps.map((step, ti) => (
            <View key={`live-${ti}`} style={styles.tool}>
              <Text style={[styles.toolCk, { color: step.ok ? t.ink : t.mut }]}>
                {step.running ? '●' : step.ok ? '✓' : '✕'}
              </Text>
              <Text numberOfLines={1} style={styles.toolTxt}>
                {step.name + (step.summary ? ' · ' + step.summary : '')}
              </Text>
            </View>
          ))}
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

        {/* 返回底部：用户上滑阅读、新内容到达时出现（旧壳「返回底部」箭头的轻量版） */}
        {showJump && !panelOpen && (
          <Pressable
            style={[styles.jumpBtn, { bottom: keyboardH > 0 ? keyboardH + 8 + dockH + 12 : insets.bottom + 120 }]}
            onPress={() => {
              followRef.current = true;
              setShowJump(false);
              scrollRef.current?.scrollToEnd({ animated: true });
            }}
            accessibilityRole="button"
            accessibilityLabel="回到底部"
          >
            <Text style={styles.jumpTxt}>↓</Text>
          </Pressable>
        )}

      {/* 4. 底部输入条 + 加号面板：悬浮在消息流之上（原型 .comp 绝对定位），
             底部让出导航 pill（44+12）；消息的 paddingBottom 已预留同等高度，
             滚到底时最后一条气泡停在输入条上方。键盘弹出时按实测高度整体上移。 */}
      <View
        style={[
          styles.compDock,
          {
            bottom:
              keyboardH > 0
                ? keyboardH + 8
                : insets.bottom + 64,
          },
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
            style={[styles.input, { height: inputClampedH }]}
            value={input}
            onChangeText={setInput}
            placeholder="与 Bluebird 对话…"
            placeholderTextColor={t.mut}
            multiline
            textAlignVertical="center"
            blurOnSubmit={false}
            onSubmitEditing={doSend}
            onContentSizeChange={e =>
              setInputH(e.nativeEvent.contentSize.height)
            }
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
              onPress={openStickerPicker}
              accessibilityRole="button"
              accessibilityLabel="表情包"
            >
              <View style={styles.pi}>
                <Text style={styles.piTxt}>🙂</Text>
              </View>
              <Text style={styles.pl}>表情包</Text>
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
              {/* 模型名可能很长（含服务商前缀），单行省略，不能把标签挤掉 */}
              <Text numberOfLines={1} style={styles.pv}>
                {props.modelLabel}
              </Text>
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

      {/* 6. 消息长按操作（旧壳 MessageActionSheet 的 v7 版：复制/收藏/撤回/隐藏） */}
      <SheetScaffold
        visible={actionOpen}
        onClose={() => setActionOpen(false)}
        title="消息操作"
      >
        {actionMsg && (
          <View style={styles.actWrap}>
            <Text style={styles.actTitle}>
              {actionMsg.role === 'user' ? '这条消息' : '这条回复'}
            </Text>
            {!!actionMsg.content?.trim() && (
              <Pressable
                style={({ pressed }) => [styles.actRow, pressed && styles.prowPressed]}
                onPress={() => {
                  try {
                    Clipboard.setString(actionMsg.content);
                    ui.toast('已复制');
                  } catch {
                    ui.toast('复制失败，当前设备无法访问剪贴板');
                  }
                  setActionOpen(false);
                }}
                accessibilityRole="button"
                accessibilityLabel="复制文字"
              >
                <Text style={styles.actRowTxt}>复制文字</Text>
              </Pressable>
            )}
            {actionMsg.role === 'user' ? (
              <>
                <Pressable
                  style={({ pressed }) => [styles.actRow, pressed && styles.prowPressed]}
                  onPress={() => {
                    props.onToggleFavorite?.(actionMsg);
                    setActionOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={
                    props.isFavorite?.(actionMsg) ? '取消收藏' : '收藏这条消息'
                  }
                >
                  <Text style={styles.actRowTxt}>
                    {props.isFavorite?.(actionMsg) ? '★ 取消收藏' : '收藏这条消息'}
                  </Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.actRow, pressed && styles.prowPressed]}
                  onPress={() => {
                    // recallMessage 内部有「撤回确认」Alert——不在此处预报成功
                    // （旧壳无 toast；用户取消或服务端失败时不能虚假反馈，oracle 阻断①）
                    chat.recallMessage(actionMsg);
                    setActionOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="撤回这条消息"
                >
                  <Text style={[styles.actRowTxt, { color: t.down }]}>撤回这条消息</Text>
                </Pressable>
              </>
            ) : (
              <>
                {/* 分享需有正文（旧壳 MessageActionSheet hasText 同守卫） */}
                {!!actionMsg.content?.trim() && (
                  <Pressable
                    style={({ pressed }) => [styles.actRow, pressed && styles.prowPressed]}
                    onPress={() => {
                      void Share.share({ message: actionMsg.content });
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="分享这条回复"
                  >
                    <Text style={styles.actRowTxt}>分享这条回复</Text>
                  </Pressable>
                )}
                <Pressable
                  style={({ pressed }) => [styles.actRow, pressed && styles.prowPressed]}
                  onPress={() => {
                    props.onToggleFavorite?.(actionMsg);
                    setActionOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={
                    props.isFavorite?.(actionMsg) ? '取消收藏' : '收藏这条回复'
                  }
                >
                  <Text style={styles.actRowTxt}>
                    {props.isFavorite?.(actionMsg) ? '★ 取消收藏' : '收藏这条回复'}
                  </Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.actRow, pressed && styles.prowPressed]}
                  onPress={() => {
                    props.onHideMessage?.(actionMsg);
                    setActionOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="隐藏这条回复"
                >
                  <Text style={styles.actRowTxt}>隐藏这条回复</Text>
                </Pressable>
              </>
            )}
          </View>
        )}
      </SheetScaffold>

      {/* 7. 表情包选择器：仓库网格点按直发；「添加」把相册图登记入库（sha256 去重） */}
      <SheetScaffold
        visible={stickersOpen}
        onClose={() => setStickersOpen(false)}
        title="表情包"
      >
        <View style={styles.stkGrid}>
          {(stickers ?? []).map(att => (
            <Pressable
              key={att.id}
              onPress={() => sendStickerNow(att)}
              accessibilityRole="button"
              accessibilityLabel={'发送表情包 ' + (att.name || '')}
            >
              <ExpoImage
                source={{ uri: stickerImageUrl(att.id), headers: IMAGE_AUTH_HEADERS }}
                style={styles.stkThumb}
                contentFit="contain"
                transition={100}
                accessibilityLabel={att.name || '表情包'}
              />
            </Pressable>
          ))}
          <Pressable
            style={styles.stkAdd}
            onPress={() =>
              void attachments.pickSticker().then(att => {
                if (att) setStickers(prev => [...(prev ?? []), att]);
              })
            }
            accessibilityRole="button"
            accessibilityLabel="添加表情包"
          >
            <Text style={styles.stkAddTxt}>＋</Text>
          </Pressable>
        </View>
        {stickers === null && (
          <Text style={styles.loadingTxt}>正在读取表情包仓库…</Text>
        )}
      </SheetScaffold>
      </View>
  );
}
