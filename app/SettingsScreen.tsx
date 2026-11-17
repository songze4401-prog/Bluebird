// 蓝鸟 UI 移植 · 设置弹层（原型 #aSheet+#dSheet 的 RN 移植）
// 主面板（原型 .setbody 的八块）：3D 倾斜用户卡 → 账号/监控/通知 → 系统外观分段 →
//   壁纸 → 强调色 → 语言/字号 → 关于/退出登录 → 版本脚注。
// 二级面板（切换账号 / 系统监控 / 语言 / 字号 / 关于）用独立 SheetScaffold 实例承载，
// 与主面板并存、后渲染者自然在上层（原型 #dSheet 的 openSub 一组分支）；
// 更换头像走公共 AvatarSheet。颜色走 tokens，唯一例外是倾斜卡面——
// 原型刻意的浅暖白卡面（白卡上高光才可见），不随主题翻转。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableInstance,
  type ViewInstance,
} from 'react-native';

import { AvatarSheet } from '../components/AvatarSheet';
import { MemoryCenterSheet } from '../components/MemoryCenterSheet';
import { ModelManageSheet } from '../components/ModelManageSheet';
import { MonitoringSheet } from '../components/MonitoringSheet';
import { SheetScaffold } from '../components/SheetScaffold';
import { WallpaperPicker } from '../components/WallpaperPicker';
import { ACCENT_LIST, APP_VERSION, type FontPref, type ThemePref } from '../data/mock';

import { useUi } from './ui-state';
import { V7_SHADOWS, type V7Tokens } from './ui-theme';

// 主题圆形扩散的圆心（与 app/ui-state.tsx 的 Origin 同形：窗口绝对坐标）
type Origin = { x: number; y: number };

// 原型 --spring：knob 位移等共用的弹簧曲线
const SPRING = Easing.bezier(0.3, 1.1, 0.45, 1);
// 原型 tgStretch 回程的 cubic-bezier(.3,1.08,.5,1)
const STRETCH_OUT_EASE = Easing.bezier(0.3, 1.08, 0.5, 1);
// tgStretch 0.36s 在 38% 处到达顶点 1.18
const STRETCH_IN_MS = 137;
const STRETCH_OUT_MS = 223;
// 3D 倾斜卡的最大倾角（原型 MAX=9）
const TILT_MAX = 9;

// 系统外观三分段（原型 #setTheme 的三个 span）
const THEME_SEGS: { v: ThemePref; label: string }[] = [
  { v: 'system', label: '跟随系统' },
  { v: 'light', label: '浅色' },
  { v: 'dark', label: '深色' },
];

// 语言 / 字号二级面板的选项（原型 optionsBody 的两份清单）
const LANGUAGE_OPTIONS = ['简体中文', 'English', '日本語'];
const FONT_OPTIONS: FontPref[] = ['小', '标准', '大'];

// 二级面板种类（原型 #dSheet 的 openSub 分支；kind 记最后一次打开的种类，关闭动画期间内容不闪空）。
// 系统监控/模型与 API/记忆中心改为独立真数据弹层（R6），不再走 mock 二级面板。
type SubKind = 'accounts' | 'language' | 'font' | 'about';
const SUB_TITLES: Record<SubKind, string> = {
  accounts: '切换账号',
  language: '语言',
  font: '字号',
  about: '关于',
};

// ---- 3D 倾斜用户卡（原型 .ucard/.tcard + pointermove 脚本的 RN 移植）----
// 外容器接管拖动手势，内白卡 rotateX/Y 跟手（±9°，perspective 620），松手弹簧回正。
// 卡面固定浅暖白（原型刻意的浅色卡面），名字/账号固定 #141414；头像底色走强调色。
function TiltUserCard(props: { onAvatarPress: () => void }) {
  const { user, tokens: t } = useUi();
  const styles = createStyles(t);

  // 倾角动画值（单位：度）：move 时 setValue 跟手，release/terminate 弹簧回 0。
  // 动画值用 useState 惰性初始化持有（渲染期读 ref.current 被 react-hooks/refs 禁止）
  const [rx] = useState(() => new Animated.Value(0));
  const [ry] = useState(() => new Animated.Value(0));
  // 外容器在窗口中的矩形：grant 时实测（measureInWindow 与 pageX/pageY 同一坐标系）
  const rectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const wrapRef = useRef<ViewInstance>(null);

  // PanResponder 只需创建一次；用 useMemo 持有实例（渲染期不再读 ref.current）。
  // 回调只在手势事件里读 ref；该规则无法区分「渲染期调用」与「事件期回调」，
  // 对 PanResponder 属已知假阳性，这里定点抑制（与 components/ControlPanelScreen.tsx 同款）。
  const panResponder = useMemo(
    () => {
      // 手指位置 → 容器内归一化 px/py → 倾角（原型 onMove：ax=(py-.5)*2*MAX, ay=(px-.5)*2*MAX）
      const tiltTo = (pageX: number, pageY: number) => {
        const r = rectRef.current;
        if (!r || r.width <= 0 || r.height <= 0) {
          // 还没有矩形（grant 首帧）：实测后用同一坐标补算
          wrapRef.current?.measureInWindow((x, y, width, height) => {
            rectRef.current = { x, y, width, height };
            tiltTo(pageX, pageY);
          });
          return;
        }
        const px = Math.min(1, Math.max(0, (pageX - r.x) / r.width));
        const py = Math.min(1, Math.max(0, (pageY - r.y) / r.height));
        const ax = (py - 0.5) * 2 * TILT_MAX;
        const ay = (px - 0.5) * 2 * TILT_MAX;
        rx.setValue(-ax);
        ry.setValue(ay);
      };
      // 松手 / 被打断：弹簧回正（原型 pointerleave 交给 transition 弹回）
      const resetTilt = () => {
        Animated.spring(rx, { toValue: 0, friction: 5, useNativeDriver: false }).start();
        Animated.spring(ry, { toValue: 0, friction: 5, useNativeDriver: false }).start();
      };
      // eslint-disable-next-line react-hooks/refs -- 手势回调仅在事件阶段读 ref，渲染期不读
      return PanResponder.create({
        // onStart 不抢手势：轻点头像仍走内层 Pressable；横向意图明显才接管做倾斜，
        // 竖向拖动让给弹层滚动（原型 pointermove 不阻塞页面滚动）
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_evt, g) =>
          Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy) * 1.2,
        onPanResponderGrant: evt => {
          // 实测卡面矩形（原型每次 pointer 事件都取 getBoundingClientRect，这里 grant 记一次）
          wrapRef.current?.measureInWindow((x, y, width, height) => {
            rectRef.current = { x, y, width, height };
            tiltTo(evt.nativeEvent.pageX, evt.nativeEvent.pageY);
          });
        },
        onPanResponderMove: evt => tiltTo(evt.nativeEvent.pageX, evt.nativeEvent.pageY),
        onPanResponderRelease: resetTilt,
        onPanResponderTerminate: resetTilt,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return (
    <View ref={wrapRef} style={styles.ucard} {...panResponder.panHandlers}>
      <Animated.View
        style={[
          styles.tcard,
          {
            // 度数走 interpolate 到 'deg' 字符串（RN 的 rotate* 数值单位是弧度）
            transform: [
              { perspective: 620 },
              { rotateX: rx.interpolate({ inputRange: [-TILT_MAX, TILT_MAX], outputRange: ['-9deg', '9deg'] }) },
              { rotateY: ry.interpolate({ inputRange: [-TILT_MAX, TILT_MAX], outputRange: ['-9deg', '9deg'] }) },
            ],
          },
        ]}
      >
        <View style={styles.trow}>
          {/* 头像钮：图片头像铺满按钮，字符/emoji 头像居中显示 → 开更换头像弹层 */}
          <Pressable
            style={styles.savatar}
            onPress={props.onAvatarPress}
            accessibilityRole="button"
            accessibilityLabel="更换头像"
          >
            {user.avatar.type === 'image' ? (
              <Image source={{ uri: user.avatar.value }} style={styles.savatarImg} />
            ) : (
              <Text style={styles.savatarTxt}>{user.avatar.value}</Text>
            )}
          </Pressable>
          <View style={styles.tinfo}>
            <Text style={styles.sname}>{user.name}</Text>
            <Text style={styles.uacct}>{user.account}</Text>
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

// ---- 通知开关（原型 .tg 的 RN 移植）----
// knob left 2↔14 260ms 弹簧位移；按下整条 scaleX 1→1.18→1 弹一下（原型 tgStretch）。
function NotifyToggle(props: { on: boolean; onToggle: () => void }) {
  const { tokens: t } = useUi();
  // 动画值用 useState 惰性初始化持有（渲染期读 ref.current 被 react-hooks/refs 禁止）
  const [knob] = useState(() => new Animated.Value(props.on ? 14 : 2));
  const [stretch] = useState(() => new Animated.Value(1));

  // on 翻转（本行按下或 store 侧 setNotify）→ knob 260ms 弹簧位移
  useEffect(() => {
    Animated.timing(knob, {
      toValue: props.on ? 14 : 2,
      duration: 260,
      easing: SPRING,
      useNativeDriver: false,
    }).start();
  }, [props.on, knob]);

  const press = () => {
    stretch.setValue(1);
    Animated.sequence([
      Animated.timing(stretch, {
        toValue: 1.18,
        duration: STRETCH_IN_MS,
        easing: SPRING,
        useNativeDriver: false,
      }),
      Animated.timing(stretch, {
        toValue: 1,
        duration: STRETCH_OUT_MS,
        easing: STRETCH_OUT_EASE,
        useNativeDriver: false,
      }),
    ]).start();
    props.onToggle();
  };

  return (
    <Pressable
      onPress={press}
      accessibilityRole="switch"
      accessibilityState={{ checked: props.on }}
      accessibilityLabel="通知"
      style={toggleStyles.hit}
      hitSlop={6}
    >
      <Animated.View
        style={[
          toggleStyles.track,
          { backgroundColor: props.on ? t.up : t.soft },
          { transform: [{ scaleX: stretch }] },
        ]}
      >
        <Animated.View style={[toggleStyles.knob, { left: knob }]} />
      </Animated.View>
    </Pressable>
  );
}

// 开关的尺寸样式（不随主题，颜色在组件里按 on 状态给）
const toggleStyles = StyleSheet.create({
  hit: { width: 30, height: 18, flexShrink: 0 },
  track: { width: 30, height: 18, borderRadius: 9 },
  knob: {
    position: 'absolute',
    top: 2,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#ffffff',
  },
});

// ---- 设置行（原型 .setrow）----
// 左标签 + 右值 + ›；通知行右侧放开关（right 位置）；危险行（退出登录）左字 down 色且无 ›；
// 无 onPress 时渲染为纯展示行（通知行）。
function SetRow(props: {
  label: string;
  value?: string;
  right?: React.ReactNode;
  danger?: boolean;
  showChev?: boolean;
  onPress?: () => void;
}) {
  const { tokens: t } = useUi();
  const styles = createStyles(t);
  const body = (
    <>
      <Text style={props.danger ? [styles.sl, { color: t.down }] : styles.sl}>{props.label}</Text>
      {props.right !== undefined ? (
        props.right
      ) : (
        <>
          {props.value !== undefined ? <Text style={styles.sv}>{props.value}</Text> : null}
          {props.showChev === false ? null : <Text style={styles.chev}>›</Text>}
        </>
      )}
    </>
  );
  if (!props.onPress) {
    return <View style={styles.setrow}>{body}</View>;
  }
  return (
    <Pressable
      style={styles.setrow}
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={props.label}
    >
      {body}
    </Pressable>
  );
}

// ---- 系统外观三分段（原型 .seg）----
function ThemeSeg(props: { value: ThemePref; onPick: (v: ThemePref, origin: Origin) => void }) {
  const { tokens: t } = useUi();
  const styles = createStyles(t);
  return (
    <View style={styles.seg}>
      {THEME_SEGS.map(s => (
        <SegOption
          key={s.v}
          on={s.v === props.value}
          label={s.label}
          onPress={origin => props.onPick(s.v, origin)}
        />
      ))}
    </View>
  );
}

// 分段选项：按下时 measureInWindow 取选项中心（窗口绝对坐标）作为主题扩散圆心
// （原型 setThemeWithReveal 的 getBoundingClientRect + 中心点）
function SegOption(props: { on: boolean; label: string; onPress: (origin: Origin) => void }) {
  const { tokens: t } = useUi();
  const styles = createStyles(t);
  const ref = useRef<PressableInstance>(null);
  return (
    <Pressable
      ref={ref}
      style={[styles.segOpt, props.on ? { backgroundColor: t.card } : null]}
      onPress={() => {
        ref.current?.measureInWindow((x, y, w, h) => {
          props.onPress({ x: x + w / 2, y: y + h / 2 });
        });
      }}
      accessibilityRole="button"
      accessibilityLabel={props.label}
    >
      <Text style={props.on ? styles.segOnTxt : styles.segOffTxt}>{props.label}</Text>
    </Pressable>
  );
}

export function SettingsScreen(props: {
  visible: boolean;
  onClose: () => void;
  // 模型/服务商变动后由壳刷新 useModelSelection 镜像（聊天抽屉与 pill 才能拿到新数据）
  onDefaultsChanged?: () => void;
}) {
  const {
    user,
    ui,
    tokens: t,
    requestTheme,
    setAccent,
    setFont,
    setLanguage,
    setNotify,
    switchAccount,
    toast,
  } = useUi();
  const styles = createStyles(t);

  // 更换头像弹层（原型 setAvatar → dSheet 的 RN 版独立弹层）
  const [avatarOpen, setAvatarOpen] = useState(false);
  // R6 真数据弹层：系统监控 / 模型与 API / 记忆中心
  const [monitoringOpen, setMonitoringOpen] = useState(false);
  const [modelManageOpen, setModelManageOpen] = useState(false);
  const [memoryCenterOpen, setMemoryCenterOpen] = useState(false);
  // 二级面板：kind 记最后一次打开的种类（关闭动画期间内容不闪空）
  const [subOpen, setSubOpen] = useState(false);
  const [sub, setSub] = useState<SubKind>('accounts');
  const openSub = (k: SubKind) => {
    setSub(k);
    setSubOpen(true);
  };

  // 主面板被外部关闭时，把还开着的二级面板/头像弹层一并收起（原型 logout 的 close('d')+close('a')）。
  // 用「渲染期对比 props 翻转再调整 state」的官方模式，避免在 effect 里同步 setState。
  const [prevVisible, setPrevVisible] = useState(props.visible);
  if (prevVisible !== props.visible) {
    setPrevVisible(props.visible);
    if (!props.visible) {
      setSubOpen(false);
      setAvatarOpen(false);
    }
  }

  return (
    <>
      {/* 主面板（原型 #aSheet） */}
      <SheetScaffold visible={props.visible} onClose={props.onClose} title="设置">
        {/* 滚动由 SheetScaffold 统一提供（原型 .sh-body overflow-y:auto）；这里只做布局 */}
        <View style={styles.body}>
          {/* 1. 3D 倾斜用户卡（原型 .ucard/.tcard） */}
          <TiltUserCard onAvatarPress={() => setAvatarOpen(true)} />

          {/* 2. 账号 / 监控 / 模型与 API / 记忆中心 / 通知（原型 setgroup 第一组） */}
          <View style={styles.setgroup}>
            <SetRow label="切换账号" value={user.account} onPress={() => openSub('accounts')} />
            <SetRow label="系统监控" value="只读" onPress={() => setMonitoringOpen(true)} />
            <SetRow label="模型与 API" onPress={() => setModelManageOpen(true)} />
            <SetRow label="记忆中心" onPress={() => setMemoryCenterOpen(true)} />
            <SetRow
              label="通知"
              right={<NotifyToggle on={ui.notify} onToggle={() => setNotify(!ui.notify)} />}
            />
          </View>

          {/* 3. 系统外观三分段：按下取选项中心作为主题圆形扩散的圆心 */}
          <View style={styles.setgroup}>
            <Text style={styles.setlabel}>系统外观</Text>
            <ThemeSeg value={ui.theme} onPick={(v, origin) => requestTheme(v, origin)} />
          </View>

          {/* 4. 壁纸横滑行（公共组件，自读 store） */}
          <View style={styles.setgroup}>
            <Text style={styles.setlabel}>壁纸</Text>
            <WallpaperPicker />
          </View>

          {/* 5. 强调色六圆（原型 .accents：选中 ink 描边，outline offset 用外圈 padding 近似） */}
          <View style={styles.setgroup}>
            <Text style={styles.setlabel}>强调色</Text>
            <View style={styles.accents}>
              {ACCENT_LIST.map(a => {
                const on = ui.accent === a.c;
                return (
                  <Pressable
                    key={a.c}
                    style={[styles.accentRing, { borderColor: on ? t.ink : 'transparent' }]}
                    onPress={() => setAccent(a.c)}
                    accessibilityRole="button"
                    accessibilityLabel={'强调色：' + a.n}
                  >
                    <View style={[styles.accentDot, { backgroundColor: a.c }, V7_SHADOWS.md]} />
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* 6. 语言 / 字号（原型 setgroup 第四组） */}
          <View style={styles.setgroup}>
            <SetRow label="语言" value={ui.language} onPress={() => openSub('language')} />
            <SetRow label="字号" value={ui.font} onPress={() => openSub('font')} />
          </View>

          {/* 7. 关于 / 退出登录（原型 setgroup 第五组：danger 行无 ›） */}
          <View style={styles.setgroup}>
            <SetRow label="关于" onPress={() => openSub('about')} />
            <SetRow label="退出登录" danger showChev={false} onPress={() => { props.onClose(); toast('已退出登录'); }} />
          </View>

          {/* 8. 版本脚注（原型 .setfoot） */}
          <View style={styles.setfoot}>
            <View style={styles.footmark}>
              <Image source={require('../assets/icon.png')} style={styles.footImg} />
            </View>
            <Text style={styles.footver}>{'v' + APP_VERSION}</Text>
          </View>
        </View>
      </SheetScaffold>

      {/* 更换头像弹层（AvatarSheet：预设格子 + 从本机选择图片） */}
      <AvatarSheet visible={avatarOpen} onClose={() => setAvatarOpen(false)} />

      {/* 系统监控（真数据：/monitoring 总览+Traces+Events，只读） */}
      <MonitoringSheet
        visible={monitoringOpen}
        onClose={() => setMonitoringOpen(false)}
      />
      {/* 模型与 API 管理（真数据：/model-providers 服务商+密钥+测试连接） */}
      <ModelManageSheet
        visible={modelManageOpen}
        onClose={() => setModelManageOpen(false)}
        onDefaultsChanged={() => {
          props.onDefaultsChanged?.();
          toast('默认模型已同步');
        }}
      />
      {/* 记忆中心（真数据：/memory 总览/管理/写入/画像） */}
      <MemoryCenterSheet
        visible={memoryCenterOpen}
        onClose={() => setMemoryCenterOpen(false)}
      />

      {/* 二级面板（原型 #dSheet）：与主面板并存，后渲染者自然在上层 */}
      <SheetScaffold
        visible={subOpen}
        onClose={() => setSubOpen(false)}
        title={SUB_TITLES[sub]}
        onBack={() => setSubOpen(false)}
      >
        {/* 滚动由 SheetScaffold 统一提供；这里只做布局 */}
        <View style={styles.subBody}>
          {/* 切换账号（原型 data-acct 行：首字符方块 + 账号名 + 当前标记） */}
          {sub === 'accounts' &&
            user.accounts.map(a => (
              <Pressable
                key={a}
                style={styles.optrow}
                onPress={() => {
                  switchAccount(a);
                  setSubOpen(false);
                }}
                accessibilityRole="button"
                accessibilityLabel={'切换账号：' + a}
              >
                <View style={styles.oi}>
                  <Text style={styles.oiTxt}>{a.slice(0, 1)}</Text>
                </View>
                <Text style={styles.ol}>{a}</Text>
                {user.account === a ? <Text style={styles.ov}>当前</Text> : null}
              </Pressable>
            ))}

          {/* 系统监控已升级为独立真数据弹层 MonitoringSheet（R6），mock 二级面板移除 */}

          {/* 语言（原型 optionsBody('lang', ...)） */}
          {sub === 'language' &&
            LANGUAGE_OPTIONS.map(l => (
              <Pressable
                key={l}
                style={styles.optrow}
                onPress={() => {
                  setLanguage(l);
                  setSubOpen(false);
                }}
                accessibilityRole="button"
                accessibilityLabel={'语言：' + l}
              >
                <Text style={styles.ol}>{l}</Text>
                {ui.language === l ? <Text style={styles.ov}>当前</Text> : null}
              </Pressable>
            ))}

          {/* 字号（原型 optionsBody('font', ...)） */}
          {sub === 'font' &&
            FONT_OPTIONS.map(f => (
              <Pressable
                key={f}
                style={styles.optrow}
                onPress={() => {
                  setFont(f);
                  setSubOpen(false);
                }}
                accessibilityRole="button"
                accessibilityLabel={'字号：' + f}
              >
                <Text style={styles.ol}>{f}</Text>
                {ui.font === f ? <Text style={styles.ov}>当前</Text> : null}
              </Pressable>
            ))}

          {/* 关于（原型 aboutmark：品牌方块 + 名字 + 版本） */}
          {sub === 'about' && (
            <View style={styles.aboutmark}>
              <View style={styles.aboutFootmark}>
                <Image source={require('../assets/icon.png')} style={styles.aboutImg} />
              </View>
              <Text style={styles.aboutname}>Bluebird</Text>
              <Text style={styles.aboutver}>{'v' + APP_VERSION}</Text>
            </View>
          )}
        </View>
      </SheetScaffold>
    </>
  );
}

// 原型 .setbody/.ucard/.tcard/.trow/.savatar/.sname/.uacct/.setgroup/.setrow/
// .setlabel/.seg/.accents/.setfoot/.optrow/.oi/.ol/.ov/.monstat/.moncard/.pdiv/.aboutmark
// 的 RN 移植
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    // 主面板滚动区（原型 .setbody：padding 0 20px 24px，顶部 0）
    body: { paddingHorizontal: 20, paddingBottom: 24 },
    // 二级面板滚动区（原型 .sh-body：padding 4px 20px 24px）
    subBody: { paddingTop: 4, paddingHorizontal: 20, paddingBottom: 24 },

    // 3D 倾斜用户卡：外容器（原型 .ucard）+ 内白卡（原型 .tcard，固定浅暖卡面不随主题）
    // 外层不加 overflow hidden：让内卡阴影在 iOS/Android 都能画出来（与 WallpaperPicker 同款取舍）
    ucard: { borderRadius: 20, padding: 14, marginBottom: 18 },
    tcard: {
      backgroundColor: '#ffffff',
      borderRadius: 18,
      paddingTop: 44,
      paddingHorizontal: 18,
      paddingBottom: 40,
      ...V7_SHADOWS.md,
    },
    trow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    savatar: {
      width: 54,
      height: 54,
      borderRadius: 18,
      backgroundColor: t.card,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      overflow: 'hidden',
    },
    savatarImg: { width: 54, height: 54, borderRadius: 18 },
    savatarTxt: { fontSize: 24, fontWeight: '700', color: t.on },
    tinfo: { flex: 1, minWidth: 0 },
    // 名字/账号固定深色：压在浅暖白卡面上，不随主题翻转（原型 #141414）
    sname: { fontSize: 22, fontWeight: '800', color: '#141414', letterSpacing: 0.5 },
    uacct: {
      marginTop: 4,
      fontSize: 12,
      fontWeight: '700',
      letterSpacing: 1.5,
      fontFamily: 'monospace',
      color: '#141414',
    },

    // 设置分组（原型 .setgroup{padding:12px 0 6px}）
    setgroup: { paddingTop: 12, paddingBottom: 6 },
    // 原型 .setrow{min-height:44px;padding:8px 2px;gap:12px;border-radius:10px}
    setrow: {
      minHeight: 44,
      paddingVertical: 8,
      paddingHorizontal: 2,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      borderRadius: 10,
    },
    sl: { flex: 1, fontSize: 13, fontWeight: '500', color: t.ink },
    sv: { fontSize: 12, color: t.mut },
    chev: { fontSize: 16, color: t.mut },
    // 原型 .setlabel{font-size:12px;color:var(--mut);font-weight:600;padding:10px 2px 8px}
    setlabel: {
      fontSize: 12,
      color: t.mut,
      fontWeight: '600',
      paddingTop: 10,
      paddingBottom: 8,
      paddingHorizontal: 2,
    },

    // 系统外观三分段（原型 .seg{background:var(--surface);r999;p3;sh-md}）
    seg: {
      flexDirection: 'row',
      backgroundColor: t.surface,
      borderRadius: 999,
      padding: 3,
      ...V7_SHADOWS.md,
    },
    segOpt: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 999 },
    segOnTxt: { fontSize: 12, color: t.on, fontWeight: '600' },
    segOffTxt: { fontSize: 12, color: t.sec },

    // 强调色六圆（原型 .accents{gap:12px;padding:4px 2px 10px}；
    // outline 2 ink offset 3 用外圈 34 描边 2 + padding 3 近似）
    accents: {
      flexDirection: 'row',
      gap: 12,
      paddingTop: 4,
      paddingHorizontal: 2,
      paddingBottom: 10,
    },
    accentRing: {
      width: 34,
      height: 34,
      borderRadius: 17,
      borderWidth: 2,
      padding: 3,
      alignItems: 'center',
      justifyContent: 'center',
    },
    accentDot: { width: 28, height: 28, borderRadius: 14 },

    // 版本脚注（原型 .setfoot{gap:8px;padding:22px 0 6px;border-top:1px solid var(--soft)}）
    setfoot: {
      alignItems: 'center',
      gap: 8,
      paddingTop: 22,
      paddingBottom: 6,
      borderTopWidth: 1,
      borderTopColor: t.soft,
    },
    footmark: {
      width: 36,
      height: 36,
      borderRadius: 11,
      backgroundColor: t.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    footImg: { width: 26, height: 26 },
    footver: { fontSize: 10, color: t.mut, letterSpacing: 0.5 },

    // 二级面板选项行（原型 .optrow{padding:12px 10px;r14;gap:12px}）
    optrow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 10,
      borderRadius: 14,
    },
    oi: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: t.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    oiTxt: { fontSize: 15, color: t.on },
    ol: { flex: 1, fontSize: 13, fontWeight: '500', color: t.ink },
    ov: { fontSize: 12, color: t.mut },

    // 系统监控（原型 .monstat 2x2 + .moncard{soft;r14;p12} + .pdiv）
    monstat: { gap: 12 },
    monrow: { flexDirection: 'row', gap: 12 },
    moncard: { flex: 1, backgroundColor: t.soft, borderRadius: 14, padding: 12 },
    moncardB: { fontSize: 19, fontWeight: '800', color: t.ink, marginBottom: 3 },
    moncardSpan: { fontSize: 10, color: t.mut },
    // 原型 .pdiv{height:1px;background:var(--soft);margin:4px 8px}
    pdiv: { height: 1, backgroundColor: t.soft, marginTop: 4, marginBottom: 4, marginHorizontal: 8 },

    // 关于（原型 .aboutmark{gap:8px;padding:14px 0 4px}，footmark 加大为 56/16）
    aboutmark: { alignItems: 'center', gap: 8, paddingTop: 14, paddingBottom: 4 },
    aboutFootmark: {
      width: 56,
      height: 56,
      borderRadius: 16,
      backgroundColor: t.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    aboutImg: { width: 40, height: 40 },
    aboutname: { fontSize: 15, fontWeight: '700', color: t.ink },
    aboutver: { fontSize: 12, color: t.mut },
  });
