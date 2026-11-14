// 蓝鸟 UI 移植 · 弹层「编辑」（原型 #bSheet 资料编辑二版）
// 头像=上传图片（同步聊天页图标）、名字+线条小铅笔、模型清单+自定义添加、人设文本域。
// 本组件只负责 sh-body 内容：scrim / 把手 / 标题 / ✕ 由弹层壳 SheetScaffold 统一承担。

import React, { useRef, useState } from 'react';
import {
  Image,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type TextInputInstance,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { SheetScaffold } from './SheetScaffold';
import { useUi } from '../app/ui-state';
import { V7_SHADOWS, type V7Tokens } from '../app/ui-theme';
import { MODELS } from '../data/mock';

export function EditProfileSheet(props: { visible: boolean; onClose: () => void }) {
  const ui = useUi();
  const t = ui.tokens;
  const bot = ui.bots[0];

  const nameRef = useRef<TextInputInstance>(null);
  const [adding, setAdding] = useState(false);
  const [newModel, setNewModel] = useState('');

  // 模型清单：自定义在前、内置在后（原型 renderProfile 的合并顺序）
  const models = [...ui.customModels, ...MODELS];

  // 头像按钮 → 系统相册选图 → setBotAvatar(uri)（原型读文件转 dataURL，RN 直接用 uri）
  const pickAvatar = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.85,
      });
      if (res.canceled) return;
      const uri = res.assets?.[0]?.uri;
      if (!uri) return;
      ui.setBotAvatar(uri);
      ui.toast('头像已更新');
    } catch {
      ui.toast('图片选择失败');
    }
  };

  // 「＋自定义添加」提交：trim 后为空则忽略
  const submitNewModel = () => {
    const m = newModel.trim();
    if (!m) return;
    ui.addCustomModel(m);
    setNewModel('');
    setAdding(false);
  };

  const styles = createStyles(t);

  return (
    <SheetScaffold visible={props.visible} onClose={props.onClose} title="编辑">
      <View style={styles.body}>
        {/* 头像区：圆 64 头像按钮（card 底 + card 阴影）+ 名字行，底部分隔线 */}
        <View style={styles.phead}>
          <TouchableOpacity
            style={[styles.pava, { backgroundColor: t.card }, V7_SHADOWS.card]}
            onPress={pickAvatar}
            activeOpacity={0.85}
          >
            <Image
              style={styles.pavaImg}
              source={bot.avatarImg ? { uri: bot.avatarImg } : require('../assets/icon.png')}
              resizeMode="cover"
            />
          </TouchableOpacity>
          <View style={styles.pnamerow}>
            <TextInput
              ref={nameRef}
              defaultValue={bot.n}
              style={styles.pname}
              onChangeText={v => {
                const n = v.trim();
                if (n) ui.renameBot(n); // trim 后非空才提交
              }}
            />
            {/* 小铅笔只负责聚焦名字输入框 */}
            <TouchableOpacity style={styles.pencil} onPress={() => nameRef.current?.focus()}>
              <Text style={styles.pencilTxt}>✎</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* 模型清单：行=soft 底圆角，右侧 ✓（选中 up 色 / 未选透明） */}
        <Text style={styles.pglabel}>模型</Text>
        <View>
          {models.map(m => {
            const on = ui.model === m;
            return (
              <TouchableOpacity key={m} style={styles.mrow} onPress={() => ui.setModel(m)}>
                <Text style={styles.mname}>{m}</Text>
                <Text style={[styles.mchk, { color: on ? t.up : 'transparent' }]}>✓</Text>
              </TouchableOpacity>
            );
          })}
          {/* ＋自定义添加：无底色虚线框；点击进入编辑态（输入 + 添加按钮） */}
          {adding ? (
            <View style={styles.maddEditing}>
              <TextInput
                style={styles.maddIn}
                placeholder="输入模型名称"
                placeholderTextColor={t.mut}
                value={newModel}
                onChangeText={setNewModel}
              />
              <TouchableOpacity style={styles.maddOk} onPress={submitNewModel}>
                <Text style={styles.maddOkTxt}>添加</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={styles.madd} onPress={() => setAdding(true)}>
              <Text style={styles.maddTxt}>＋ 自定义添加</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* 人设：多行文本域 + 字数（上限 4000） */}
        <Text style={styles.pglabel}>人设</Text>
        <View>
          <TextInput
            style={styles.ptexta}
            value={ui.persona.customPrompt}
            onChangeText={ui.setPersonaPrompt}
            placeholder="写下 TA 的人设：性格、说话方式、边界…"
            placeholderTextColor={t.mut}
            multiline
            maxLength={4000}
          />
          <Text style={styles.pcount}>{ui.persona.customPrompt.length}/4000</Text>
        </View>
      </View>
    </SheetScaffold>
  );
}

// 原型 .phead/.pava/.pname-in/.pglabel/.mrow/.madd/.ptexta/.pcount 的 RN 移植
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    // sh-body 的 gap 16 列容器
    body: { gap: 16 },
    // 原型 .phead：列居中 gap8 + 底部分隔线 + 下 margin 12
    phead: {
      alignItems: 'center',
      gap: 8,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: t.soft,
      marginBottom: 12,
    },
    // 原型 .pava：圆 64（card 阴影由调用处叠 V7_SHADOWS.card）
    pava: {
      width: 64,
      height: 64,
      borderRadius: 32,
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
    },
    pavaImg: { width: '100%', height: '100%' },
    pnamerow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    // 原型 .pname-in：16 w800 ink 居中（TextInput 原生无边框，容器不给底色）
    pname: {
      minWidth: 56,
      maxWidth: 220,
      paddingVertical: 2,
      paddingHorizontal: 4,
      fontSize: 16,
      fontWeight: '800',
      color: t.ink,
      textAlign: 'center',
    },
    // 原型 .pencil：线条小铅笔 14 mut
    pencil: { padding: 4 },
    pencilTxt: { fontSize: 14, color: t.mut },
    // 原型 .pglabel：10 w700 mut，margin 12/0/6，letterSpacing 1
    pglabel: {
      fontSize: 10,
      fontWeight: '700',
      color: t.mut,
      marginTop: 12,
      marginBottom: 6,
      letterSpacing: 1,
    },
    // 原型 .mrow：soft 底 r12 p10/12 mb6，两端对齐
    mrow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: t.soft,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 12,
      marginBottom: 6,
    },
    mname: { fontSize: 12, fontWeight: '600', color: t.ink },
    // 原型 .mchk：12 w800（颜色由调用处给：选中 up / 未选透明）
    mchk: { fontSize: 12, fontWeight: '800' },
    // 原型 .mrow.madd：无底色 + 1.5 虚线 mut 框，居中 sec 12
    madd: {
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 12,
      borderWidth: 1.5,
      borderStyle: 'dashed',
      borderColor: t.mut,
      paddingVertical: 10,
      paddingHorizontal: 12,
    },
    maddTxt: { fontSize: 12, color: t.sec },
    // 原型 .mrow.madd.editing：输入框 + 添加按钮一行
    maddEditing: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderRadius: 12,
      borderWidth: 1.5,
      borderStyle: 'dashed',
      borderColor: t.mut,
      paddingVertical: 8,
      paddingHorizontal: 10,
    },
    maddIn: { flex: 1, fontSize: 12, color: t.ink, padding: 0 },
    // 原型 .madd-ok：card 底 on 12 w700 r8 p4/10
    maddOk: {
      backgroundColor: t.card,
      borderRadius: 8,
      paddingVertical: 4,
      paddingHorizontal: 10,
    },
    maddOkTxt: { fontSize: 12, fontWeight: '700', color: t.on },
    // 原型 .ptexta：1.5 soft 框 r12 p9/11 12px，minHeight 84
    ptexta: {
      borderWidth: 1.5,
      borderColor: t.soft,
      borderRadius: 12,
      paddingVertical: 9,
      paddingHorizontal: 11,
      fontSize: 12,
      lineHeight: 19,
      color: t.ink,
      minHeight: 84,
      textAlignVertical: 'top',
    },
    // 原型 .pcount：10 mut 右对齐 mt3
    pcount: { fontSize: 10, color: t.mut, textAlign: 'right', marginTop: 3 },
  });
