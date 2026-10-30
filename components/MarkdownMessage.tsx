import React, { useMemo } from 'react';
import {
  Alert,
  Clipboard,
  ScrollView,
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

function CodeBlock({
  block,
  styles,
}: {
  block: Extract<MarkdownBlock, { type: 'code' }>;
  styles: ReturnType<typeof createStyles>;
}) {
  const copy = () => {
    try {
      Clipboard.setString(block.code);
      Alert.alert('已复制', '代码已复制到剪贴板。');
    } catch {
      Alert.alert('复制失败', '当前设备无法访问剪贴板。');
    }
  };

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
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.codeScroll}
      >
        <Text selectable style={styles.codeText}>
          {block.code}
        </Text>
      </ScrollView>
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
    <View style={styles.root}>
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
    codeScroll: {
      padding: 12,
    },
    codeText: {
      color: theme.chatText,
      fontFamily: 'monospace',
      fontSize: 13,
      lineHeight: 20,
    },
  });
