import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError } from '../lib/api/errors';
import {
  deleteWorkspaceFile,
  downloadWorkspaceFile,
  listWorkspaceFiles,
  readWorkspaceText,
  saveWorkspaceText,
  uploadWorkspaceFile,
} from '../lib/api/workspace-files';
import type { WorkspaceFileEntry, WorkspaceTextResponse } from '../lib/api/types';
import { useUi } from './ui-state';

type PickedUpload = { directory: string; name: string; base64: string };
type ModalKind = 'delete' | 'upload-conflict' | 'reload-conflict' | null;

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '修改时间未知';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function isTextPreview(entry: WorkspaceFileEntry): boolean {
  return entry.mimeType?.startsWith('text/') === true || entry.mimeType === 'application/json';
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  if (typeof globalThis.btoa !== 'function') throw new Error('当前设备无法编码上传文件');
  return globalThis.btoa(binary);
}

export function WorkspaceFilesScreen({ visible }: { visible: boolean }) {
  const ui = useUi();
  const t = ui.tokens;
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(t, ui.fontDelta), [t, ui.fontDelta]);
  const [currentPath, setCurrentPath] = useState('.');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [items, setItems] = useState<WorkspaceFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [activeFile, setActiveFile] = useState<WorkspaceTextResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<PickedUpload | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const [notice, setNotice] = useState('');
  const requestSeq = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 220);
    return () => clearTimeout(timer);
  }, [search]);

  const refreshList = useCallback(async (quiet = false) => {
    const seq = ++requestSeq.current;
    if (!quiet) setLoading(true);
    setListError('');
    try {
      const response = await listWorkspaceFiles(currentPath, debouncedSearch);
      if (requestSeq.current !== seq) return;
      setItems(response.entries);
      if (response.truncated) setNotice('结果较多，仅显示最近修改的 500 项');
      else setNotice('');
    } catch (error) {
      if (requestSeq.current !== seq) return;
      setListError(error instanceof Error ? error.message : '读取工作区失败');
    } finally {
      if (requestSeq.current === seq) {
        setLoading(false);
      }
    }
  }, [currentPath, debouncedSearch]);

  useEffect(() => {
    if (!visible) return undefined;
    const timer = setTimeout(() => { void refreshList(); }, 0);
    return () => clearTimeout(timer);
  }, [visible, refreshList]);

  // 编辑期间定期检查服务端版本；真正保存时仍由服务端再次强校验。
  useEffect(() => {
    if (!visible || !editing || !activeFile) return undefined;
    let cancelled = false;
    const check = async () => {
      try {
        const latest = await readWorkspaceText(activeFile.path);
        if (!cancelled && latest.version !== activeFile.version) setConflict(true);
      } catch {
        if (!cancelled) setConflict(true);
      }
    };
    const timer = setInterval(() => { void check(); }, 6000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, editing, activeFile]);

  const openTextFile = async (entry: WorkspaceFileEntry) => {
    setLoading(true);
    setListError('');
    try {
      const file = await readWorkspaceText(entry.path);
      setActiveFile(file);
      setDraft(file.content);
      setEditing(false);
      setConflict(false);
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '打开文件失败');
    } finally {
      setLoading(false);
    }
  };

  const downloadOrPreview = async (entry: WorkspaceFileEntry) => {
    setLoading(true);
    setNotice('正在下载文件…');
    try {
      const bytes = await downloadWorkspaceFile(entry.path);
      if (Platform.OS === 'web') {
        const doc = typeof document === 'undefined' ? null : document;
        if (!doc) throw new Error('浏览器下载不可用');
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        const blob = new Blob([buffer], { type: entry.mimeType || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const anchor = doc.createElement('a');
        anchor.href = url;
        anchor.download = entry.name;
        anchor.rel = 'noopener';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        setNotice(`已下载 ${entry.name}`);
        return;
      }
      const local = new File(Paths.cache, entry.name);
      if (local.exists) local.delete();
      local.create({ intermediates: true });
      await local.write(bytes);
      if (await local.canPreview()) {
        await local.preview({ title: entry.name });
      } else if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(local.uri, {
          dialogTitle: entry.name,
          mimeType: entry.mimeType || 'application/octet-stream',
        });
      } else {
        setNotice(`文件已下载到应用缓存：${entry.name}`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '下载或预览失败');
    } finally {
      setLoading(false);
    }
  };

  const openEntry = (entry: WorkspaceFileEntry) => {
    if (entry.type === 'dir') {
      setCurrentPath(entry.path);
      setSearch('');
      setDebouncedSearch('');
      return;
    }
    if (isTextPreview(entry)) void openTextFile(entry);
    else void downloadOrPreview(entry);
  };

  const beginUpload = async () => {
    setNotice('');
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        type: '*/*',
        base64: Platform.OS === 'web',
      });
      if (result.canceled || !result.assets.length) return;
      const asset = result.assets[0];
      if (asset.size != null && asset.size > 10 * 1024 * 1024) {
        setNotice('文件超过 10 MB 上传上限');
        return;
      }
      let base64 = asset.base64 || '';
      if (!base64 && asset.file) base64 = bytesToBase64(new Uint8Array(await asset.file.arrayBuffer()));
      if (!base64) base64 = await new File(asset.uri).base64();
      const upload: PickedUpload = { directory: currentPath, name: asset.name, base64 };
      await submitUpload(upload);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '选择或上传文件失败');
    }
  };

  const submitUpload = async (upload: PickedUpload, onConflict?: 'overwrite' | 'keep-both') => {
    setUploading(true);
    setNotice('');
    try {
      const result = await uploadWorkspaceFile({ ...upload, ...(onConflict ? { onConflict } : {}) });
      setPendingUpload(null);
      setModal(null);
      setNotice(`已上传：${result.name}`);
      await refreshList(true);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'workspace_file_exists' && !onConflict) {
        setPendingUpload(upload);
        setModal('upload-conflict');
      } else {
        setNotice(error instanceof Error ? error.message : '上传失败');
      }
    } finally {
      setUploading(false);
    }
  };

  const saveChanges = async () => {
    if (!activeFile || conflict) return;
    setSaving(true);
    setNotice('');
    try {
      const saved = await saveWorkspaceText(activeFile.path, draft, activeFile.version);
      setActiveFile({ ...activeFile, content: draft, version: saved.version, size: saved.size, mtime: saved.mtime });
      setEditing(false);
      setConflict(false);
      setNotice('已保存');
      await refreshList(true);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'workspace_version_conflict') {
        setConflict(true);
        setNotice('文件已在编辑期间被 Blue 或其他进程修改；你的内容没有覆盖服务器版本。');
      } else {
        setNotice(error instanceof Error ? error.message : '保存失败');
      }
    } finally {
      setSaving(false);
    }
  };

  const reloadLatest = async () => {
    if (!activeFile) return;
    setModal(null);
    setLoading(true);
    try {
      const latest = await readWorkspaceText(activeFile.path);
      setActiveFile(latest);
      setDraft(latest.content);
      setConflict(false);
      setNotice('已载入服务器上的最新版本');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '重新载入失败');
    } finally {
      setLoading(false);
    }
  };

  const deleteActiveFile = async () => {
    if (!activeFile) return;
    setDeleting(true);
    try {
      await deleteWorkspaceFile(activeFile.path);
      setActiveFile(null);
      setEditing(false);
      setConflict(false);
      setModal(null);
      setNotice('文件已删除');
      await refreshList(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  };

  const goUp = () => {
    if (currentPath === '.') return;
    const pieces = currentPath.split('/').filter(Boolean);
    pieces.pop();
    setCurrentPath(pieces.length ? pieces.join('/') : '.');
    setSearch('');
    setDebouncedSearch('');
  };

  const closeFile = () => {
    setActiveFile(null);
    setEditing(false);
    setConflict(false);
    setNotice('');
  };

  const modalBody = modal === 'delete'
    ? `确定删除「${activeFile?.path || ''}」吗？此操作不能撤销。`
    : modal === 'upload-conflict'
      ? `「${pendingUpload?.name || ''}」已存在。你可以覆盖原文件，或保留两份。`
      : modal === 'reload-conflict'
        ? '载入服务器最新版本会放弃当前编辑框里的内容。是否继续？'
        : '';

  return (
    <View style={[styles.screen, { display: visible ? 'flex' : 'none', paddingTop: insets.top + 8 }]}>
      <View style={styles.topRow}>
        {activeFile ? (
          <Pressable onPress={closeFile} accessibilityRole="button" accessibilityLabel="返回文件列表" style={styles.backButton}>
            <Text style={styles.backGlyph}>‹</Text>
          </Pressable>
        ) : currentPath !== '.' ? (
          <Pressable onPress={goUp} accessibilityRole="button" accessibilityLabel="返回上级目录" style={styles.backButton}>
            <Text style={styles.backGlyph}>‹</Text>
          </Pressable>
        ) : <View style={styles.backSpacer} />}
        <View style={styles.headingBlock}>
          <Text style={styles.heading}>{activeFile ? activeFile.path.split('/').pop() : '文件'}</Text>
          <Text numberOfLines={1} style={styles.subheading}>{activeFile ? activeFile.path : currentPath === '.' ? 'Bluebird 工作区' : currentPath}</Text>
        </View>
        {!activeFile && (
          <Pressable onPress={() => void beginUpload()} disabled={uploading} accessibilityRole="button" style={[styles.uploadButton, uploading && styles.disabled]}>
            {uploading ? <ActivityIndicator size="small" color={t.on} /> : <Text style={styles.uploadText}>上传</Text>}
          </Pressable>
        )}
      </View>

      {!activeFile ? (
        <>
          <View style={styles.searchBox}>
            <Text style={styles.searchGlyph}>⌕</Text>
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="搜索工作区文件"
              placeholderTextColor={t.mut}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="搜索工作区文件"
              style={styles.searchInput}
            />
            {search.length > 0 && <Pressable onPress={() => setSearch('')}><Text style={styles.clearSearch}>清除</Text></Pressable>}
          </View>
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          {listError ? <View style={styles.errorBox}><Text style={styles.errorText}>{listError}</Text><Pressable onPress={() => void refreshList()}><Text style={styles.inlineAction}>重试</Text></Pressable></View> : null}
          <ScrollView
            style={styles.list}
            contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 112 }]}
            keyboardShouldPersistTaps="handled"
            onScrollBeginDrag={() => {}}
          >
            {loading && items.length === 0 ? <ActivityIndicator color={t.ink} style={styles.loader} /> : null}
            {!loading && !listError && items.length === 0 ? <Text style={styles.empty}>{debouncedSearch ? '没有找到匹配项' : '这个工作区还没有文件'}</Text> : null}
            {items.map(entry => (
              <Pressable key={entry.path} onPress={() => openEntry(entry)} accessibilityRole="button" accessibilityLabel={`${entry.type === 'dir' ? '文件夹' : '文件'} ${entry.name}`} style={styles.fileRow}>
                <View style={[styles.fileBadge, entry.type === 'dir' ? styles.folderBadge : styles.fileBadgePlain]}>
                  <Text style={styles.fileBadgeText}>{entry.type === 'dir' ? '夹' : entry.name.split('.').pop()?.slice(0, 3).toUpperCase() || '文'}</Text>
                </View>
                <View style={styles.fileMain}>
                  <Text numberOfLines={1} style={styles.fileName}>{entry.name}</Text>
                  <Text numberOfLines={1} style={styles.fileMeta}>{formatTime(entry.mtime)}{entry.type === 'file' ? ` · ${formatSize(entry.size)}` : ' · 文件夹'}</Text>
                </View>
                <Text style={styles.chevron}>{entry.type === 'dir' ? '›' : '›'}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </>
      ) : (
        <>
          <View style={styles.detailActions}>
            {activeFile.editable && !editing && <Pressable onPress={() => { setDraft(activeFile.content); setEditing(true); setNotice(''); }} style={styles.actionButton}><Text style={styles.actionText}>编辑</Text></Pressable>}
            {editing && <Pressable onPress={() => { setEditing(false); setDraft(activeFile.content); setConflict(false); }} style={styles.actionButton}><Text style={styles.actionText}>取消编辑</Text></Pressable>}
            <Pressable testID="workspace-delete" accessibilityRole="button" accessibilityLabel="删除文件" onPress={() => setModal('delete')} style={[styles.actionButton, styles.dangerAction]}><Text style={styles.dangerText}>删除</Text></Pressable>
          </View>
          {conflict && (
            <View style={styles.conflictBox}>
              <Text style={styles.conflictTitle}>文件已被其他操作修改</Text>
              <Text style={styles.conflictText}>为保护你的草稿，保存已暂停，服务器版本没有被覆盖。</Text>
              <Pressable onPress={() => setModal('reload-conflict')} style={styles.inlineButton}><Text style={styles.inlineAction}>载入最新版本（放弃草稿）</Text></Pressable>
            </View>
          )}
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          {editing ? (
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              textAlignVertical="top"
              autoCapitalize="sentences"
              accessibilityLabel="编辑文件内容"
              style={styles.editor}
            />
          ) : (
            <ScrollView style={styles.preview} contentContainerStyle={styles.previewContent}>
              <Text selectable style={styles.previewText}>{activeFile.content}</Text>
            </ScrollView>
          )}
          {editing && (
            <View style={[styles.saveBar, { paddingBottom: insets.bottom + 96 }]}>
              <Text style={styles.versionMeta}>修改时间：{formatTime(activeFile.mtime)} · {formatSize(activeFile.size)}</Text>
              <Pressable onPress={() => void saveChanges()} disabled={saving || conflict || draft === activeFile.content} style={[styles.primaryButton, (saving || conflict || draft === activeFile.content) && styles.disabled]}>
                {saving ? <ActivityIndicator color={t.on} /> : <Text style={styles.primaryText}>{conflict ? '检测到冲突' : '保存更改'}</Text>}
              </Pressable>
            </View>
          )}
        </>
      )}

      {modal && (
        <View style={styles.modalShade}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{modal === 'delete' ? '删除文件' : modal === 'upload-conflict' ? '文件名已存在' : '载入最新版本'}</Text>
            <Text style={styles.modalBody}>{modalBody}</Text>
            {modal === 'upload-conflict' ? (
              <View style={styles.modalButtons}>
                <Pressable onPress={() => { setModal(null); setPendingUpload(null); }} style={styles.secondaryButton}><Text style={styles.actionText}>取消</Text></Pressable>
                <Pressable disabled={uploading} onPress={() => pendingUpload && void submitUpload(pendingUpload, 'keep-both')} style={styles.secondaryButton}><Text style={styles.actionText}>保留两份</Text></Pressable>
                <Pressable disabled={uploading} onPress={() => pendingUpload && void submitUpload(pendingUpload, 'overwrite')} style={styles.primaryButton}><Text style={styles.primaryText}>覆盖</Text></Pressable>
              </View>
            ) : (
              <View style={styles.modalButtons}>
                <Pressable onPress={() => setModal(null)} style={styles.secondaryButton}><Text style={styles.actionText}>取消</Text></Pressable>
                <Pressable disabled={deleting} onPress={() => modal === 'delete' ? void deleteActiveFile() : void reloadLatest()} style={[styles.primaryButton, modal === 'delete' && styles.dangerButton]}>
                  {deleting ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.primaryText}>{modal === 'delete' ? '确认删除' : '载入最新版本'}</Text>}
                </Pressable>
              </View>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

function createStyles(t: ReturnType<typeof useUi>['tokens'], fontDelta: number) {
  return StyleSheet.create({
    screen: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: t.bg, paddingHorizontal: 20 },
    topRow: { minHeight: 60, flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
    backButton: { width: 38, height: 42, alignItems: 'flex-start', justifyContent: 'center' },
    backSpacer: { width: 8 },
    backGlyph: { color: t.ink, fontSize: 34, lineHeight: 38, fontWeight: '300' },
    headingBlock: { flex: 1, minWidth: 0, paddingRight: 8 },
    heading: { color: t.ink, fontSize: 23 + fontDelta, fontWeight: '700' },
    subheading: { marginTop: 3, color: t.mut, fontSize: 12 + fontDelta },
    uploadButton: { minWidth: 68, height: 38, paddingHorizontal: 16, borderRadius: 14, backgroundColor: t.card, alignItems: 'center', justifyContent: 'center' },
    uploadText: { color: t.on, fontSize: 14 + fontDelta, fontWeight: '700' },
    disabled: { opacity: 0.48 },
    searchBox: { height: 46, flexDirection: 'row', alignItems: 'center', borderRadius: 14, paddingHorizontal: 13, backgroundColor: t.soft, marginBottom: 12 },
    searchGlyph: { color: t.mut, fontSize: 22, marginRight: 8 },
    searchInput: { flex: 1, minWidth: 0, paddingVertical: 0, color: t.ink, fontSize: 15 + fontDelta },
    clearSearch: { color: t.info, fontSize: 12 + fontDelta, paddingLeft: 8 },
    list: { flex: 1 },
    listContent: { paddingBottom: 110 },
    loader: { marginTop: 32 },
    empty: { color: t.mut, fontSize: 14 + fontDelta, textAlign: 'center', marginTop: 50 },
    fileRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.soft, paddingVertical: 10 },
    fileBadge: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
    folderBadge: { backgroundColor: t.card },
    fileBadgePlain: { backgroundColor: t.soft },
    fileBadgeText: { color: t.ink, fontSize: 10, fontWeight: '800' },
    fileMain: { flex: 1, minWidth: 0 },
    fileName: { color: t.ink, fontSize: 15 + fontDelta, fontWeight: '600' },
    fileMeta: { color: t.mut, fontSize: 11 + fontDelta, marginTop: 4 },
    chevron: { color: t.mut, fontSize: 25, marginLeft: 8 },
    notice: { color: t.sec, fontSize: 12 + fontDelta, marginBottom: 8 },
    errorBox: { padding: 12, borderRadius: 12, backgroundColor: t.soft, marginBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    errorText: { flex: 1, color: t.down, fontSize: 13 + fontDelta },
    inlineButton: { alignSelf: 'flex-start', marginTop: 8 },
    inlineAction: { color: t.info, fontSize: 13 + fontDelta, fontWeight: '700' },
    detailActions: { flexDirection: 'row', gap: 8, marginBottom: 10 },
    actionButton: { minHeight: 36, paddingHorizontal: 14, borderRadius: 12, backgroundColor: t.soft, alignItems: 'center', justifyContent: 'center' },
    actionText: { color: t.ink, fontSize: 13 + fontDelta, fontWeight: '600' },
    dangerAction: { backgroundColor: `${t.down}18` },
    dangerText: { color: t.down, fontSize: 13 + fontDelta, fontWeight: '700' },
    conflictBox: { borderRadius: 13, padding: 12, backgroundColor: `${t.warn}20`, marginBottom: 10 },
    conflictTitle: { color: t.ink, fontSize: 14 + fontDelta, fontWeight: '700' },
    conflictText: { color: t.sec, fontSize: 12 + fontDelta, marginTop: 4 },
    editor: { flex: 1, minHeight: 180, borderRadius: 14, padding: 14, color: t.ink, backgroundColor: t.soft, fontSize: 15 + fontDelta, lineHeight: 23 + fontDelta },
    preview: { flex: 1, borderRadius: 14, backgroundColor: t.soft },
    previewContent: { padding: 16, paddingBottom: 110 },
    previewText: { color: t.ink, fontSize: 15 + fontDelta, lineHeight: 24 + fontDelta },
    saveBar: { paddingTop: 10, gap: 8 },
    versionMeta: { color: t.mut, fontSize: 11 + fontDelta },
    primaryButton: { minHeight: 40, flexGrow: 1, paddingHorizontal: 14, borderRadius: 12, backgroundColor: t.card, alignItems: 'center', justifyContent: 'center' },
    primaryText: { color: t.on, fontSize: 13 + fontDelta, fontWeight: '700' },
    secondaryButton: { minHeight: 40, flexGrow: 1, paddingHorizontal: 12, borderRadius: 12, backgroundColor: t.soft, alignItems: 'center', justifyContent: 'center' },
    dangerButton: { backgroundColor: t.down },
    modalShade: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.42)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 },
    modalCard: { width: '100%', maxWidth: 420, borderRadius: 20, padding: 20, backgroundColor: t.surface },
    modalTitle: { color: t.ink, fontSize: 18 + fontDelta, fontWeight: '700' },
    modalBody: { color: t.sec, fontSize: 14 + fontDelta, lineHeight: 21 + fontDelta, marginTop: 10, marginBottom: 18 },
    modalButtons: { flexDirection: 'row', gap: 8 },
  });
}
