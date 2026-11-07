import React, { useMemo, useState } from 'react';
import {
  Alert,
  Clipboard,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import type { Theme } from '../theme';
import {
  parseMarkdown,
  type MarkdownInline,
  type MarkdownBlock,
} from '../lib/markdown';

function InlineContent({
  inlines,
  styles,
}: {
  inlines: MarkdownInline[];
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <>
      {inlines.map((inline, index) => (
        <Text
          key={`${inline.type}-${index}`}
          style={[
            inline.type === 'code' && styles.inlineCode,
            inline.type === 'strong' && styles.strong,
            inline.type === 'em' && styles.em,
          ]}
        >
          {inline.text}
        </Text>
      ))}
    </>
  );
}

// 代码块默认最多展示的行数。超过即折叠并提供「展开全部」：
// 模型偶尔会吐很长的 JSON/日志，不设上限会把整个聊天视口占满，
// 看起来像「页面划不动」。
const COLLAPSED_CODE_LINES = 16;

/** 去掉尾部空白行并算出折叠信息（纯函数，便于单测）。 */
export function prepareCodeBlock(raw: string): {
  text: string;
  lineCount: number;
  collapsible: boolean;
} {
  const text = String(raw || '').replace(/[\s\u0085\u2028\u2029]+$/, '');
  const lineCount = text ? text.split('\n').length : 0;

  return { text, lineCount, collapsible: lineCount > COLLAPSED_CODE_LINES };
}

function CodeBlock({
  block,
  styles,
}: {
  block: Extract<MarkdownBlock, { type: 'code' }>;
  styles: ReturnType<typeof createStyles>;
}) {
  const [expanded, setExpanded] = useState(false);
  const prepared = useMemo(() => prepareCodeBlock(block.code), [block.code]);

  const copy = () => {
    try {
      Clipboard.setString(block.code);
      Alert.alert('已复制', '代码已复制到剪贴板。');
    } catch {
      Alert.alert('复制失败', '当前设备无法访问剪贴板。');
    }
  };

  const collapsed = prepared.collapsible && !expanded;
  const visibleText = collapsed
    ? prepared.text.split('\n').slice(0, COLLAPSED_CODE_LINES).join('\n')
    : prepared.text;

  return (
    <View style={styles.codeBlock}>
      <View style={styles.codeHead}>
        <Text style={styles.codeLang}>{block.language || 'code'}</Text>
        <TouchableOpacity
          onPress={copy}
          activeOpacity={0.65}
          accessibilityLabel="复制代码"
          style={styles.copyButton}
        >
          <Text style={styles.copyText}>复制</Text>
        </TouchableOpacity>
      </View>
      {/* 刻意不用横向 ScrollView：嵌套滚动会在 Android 上吞掉外层列表的
          纵向手势，代码块一长就「划不动」。这里让文本在气泡宽度内换行。 */}
      <View style={styles.codeBody}>
        <Text selectable style={styles.codeText}>
          {visibleText}
        </Text>
      </View>
      {prepared.collapsible && (
        <TouchableOpacity
          onPress={() => setExpanded(value => !value)}
          activeOpacity={0.65}
          accessibilityLabel={expanded ? '收起代码' : '展开代码'}
          style={styles.codeToggle}
        >
          <Text style={styles.codeToggleText}>
            {expanded ? '收起' : `展开全部（${prepared.lineCount} 行）`}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

/**
 * 消息正文的轻量 Markdown 渲染。只使用 Text/View/ScrollView，不引入
 * WebView、HTML 或第三方 Markdown 渲染器；复制代码使用 RN 内置 Clipboard。
 */
export function MarkdownMessage({
  content,
  theme,
}: {
  content: string;
  theme: Theme;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const blocks = useMemo(() => parseMarkdown(content), [content]);

  return (
    <View style={styles.root} testID="markdown-root">
      {blocks.map((block, index) => {
        if (block.type === 'code') {
          return (
            <CodeBlock key={`code-${index}`} block={block} styles={styles} />
          );
        }

        if (block.type === 'heading') {
          return (
            <Text
              key={`heading-${index}`}
              selectable
              style={[
                styles.heading,
                block.level === 1 && styles.heading1,
                block.level === 2 && styles.heading2,
                block.level === 3 && styles.heading3,
              ]}
            >
              <InlineContent inlines={block.inlines} styles={styles} />
            </Text>
          );
        }

        if (block.type === 'list') {
          return (
            <View key={`list-${index}`} style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View key={`item-${itemIndex}`} style={styles.listItem}>
                  <Text style={styles.bullet}>
                    {block.ordered ? `${itemIndex + 1}.` : '•'}
                  </Text>
                  <Text selectable style={styles.listText}>
                    <InlineContent inlines={item} styles={styles} />
                  </Text>
                </View>
              ))}
            </View>
          );
        }

        if (block.type === 'quote') {
          return (
            <View key={`quote-${index}`} style={styles.quote}>
              <Text selectable style={styles.quoteText}>
                <InlineContent inlines={block.inlines} styles={styles} />
              </Text>
            </View>
          );
        }

        return (
          <Text key={`paragraph-${index}`} selectable style={styles.paragraph}>
            <InlineContent inlines={block.inlines} styles={styles} />
          </Text>
        );
      })}
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    root: {
      marginTop: 10,
      gap: 12,
      // 父级 assistantColumn 是 alignItems:'flex-start'，根容器若不占满宽就会
      // shrink-to-fit；列表行里 flex:1 的文本将按「不定宽」测量，Android 上测量与
      // 布局两次宽度不一致会少算换行行高，下一块（段落）就压住列表末行。
      // 占满宽让行宽在测量/布局两趟一致，行高才正确。
      alignSelf: 'stretch',
    },
    paragraph: {
      color: theme.chatText,
      fontSize: 16,
      lineHeight: 26,
    },
    heading: {
      color: theme.chatText,
      fontWeight: '600',
    },
    heading1: {
      fontSize: 21,
      lineHeight: 29,
    },
    heading2: {
      fontSize: 19,
      lineHeight: 27,
    },
    heading3: {
      fontSize: 17,
      lineHeight: 25,
    },
    strong: {
      fontWeight: '600',
    },
    em: {
      fontStyle: 'italic',
    },
    inlineCode: {
      fontFamily: 'monospace',
      fontSize: 14,
      color: theme.chatText,
      backgroundColor: theme.pill,
      borderRadius: 4,
      paddingHorizontal: 4,
    },
    list: {
      gap: 6,
    },
    listItem: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 9,
    },
    bullet: {
      width: 18,
      color: theme.chatMuted,
      fontSize: 16,
      lineHeight: 26,
      textAlign: 'right',
    },
    listText: {
      flex: 1,
      color: theme.chatText,
      fontSize: 16,
      lineHeight: 26,
    },
    quote: {
      borderLeftWidth: 2,
      borderLeftColor: theme.accentBorder,
      paddingLeft: 12,
    },
    quoteText: {
      color: theme.textSecondary,
      fontSize: 15,
      lineHeight: 24,
    },
    codeBlock: {
      backgroundColor: theme.surfaceAlt,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 12,
      overflow: 'hidden',
    },
    codeHead: {
      height: 34,
      paddingHorizontal: 12,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    codeLang: {
      color: theme.textMuted,
      fontSize: 11,
      fontFamily: 'monospace',
    },
    copyButton: {
      paddingHorizontal: 6,
      paddingVertical: 4,
    },
    copyText: {
      color: theme.textSecondary,
      fontSize: 11,
    },
    codeBody: {
      padding: 12,
    },
    codeText: {
      color: theme.chatText,
      fontFamily: 'monospace',
      fontSize: 13,
      lineHeight: 20,
    },
    codeToggle: {
      paddingVertical: 10,
      alignItems: 'center',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    codeToggleText: {
      color: theme.accent,
      fontSize: 12,
      fontWeight: '600',
    },
  });
