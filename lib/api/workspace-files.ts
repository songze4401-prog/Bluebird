import { File, Paths } from 'expo-file-system';
import { API_PATHS } from './endpoints';
import { apiErrorFromPayload } from './errors';
import { apiFetch, API_BASE, TIMEOUTS } from './client';
import { API_TOKEN } from '../constants';
import type {
  WorkspaceFilesResponse,
  WorkspaceSaveResponse,
  WorkspaceTextResponse,
  WorkspaceUploadResponse,
} from './types';

async function jsonRequest<T>(response: Response, fallback: string): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) throw apiErrorFromPayload(payload, response.status, fallback);
  return payload as T;
}

export async function listWorkspaceFiles(path = '.', search = ''): Promise<WorkspaceFilesResponse> {
  const response = await apiFetch(API_PATHS.workspaceFiles(path, search));
  return jsonRequest<WorkspaceFilesResponse>(response, '读取工作区列表失败');
}

export async function readWorkspaceText(path: string): Promise<WorkspaceTextResponse> {
  const response = await apiFetch(API_PATHS.workspaceFileText(path));
  return jsonRequest<WorkspaceTextResponse>(response, '读取文件失败');
}

export async function saveWorkspaceText(
  path: string,
  content: string,
  expectedVersion: string
): Promise<WorkspaceSaveResponse> {
  const response = await apiFetch(API_PATHS.workspaceFileTextSave, {
    method: 'PUT',
    body: JSON.stringify({ path, content, expectedVersion }),
  });
  return jsonRequest<WorkspaceSaveResponse>(response, '保存文件失败');
}

export async function deleteWorkspaceFile(path: string): Promise<{ ok: true; path: string }> {
  const response = await apiFetch(API_PATHS.workspaceFiles(), {
    method: 'DELETE',
    body: JSON.stringify({ path, confirm: true }),
  });
  return jsonRequest<{ ok: true; path: string }>(response, '删除文件失败');
}

export async function uploadWorkspaceFile(args: {
  directory: string;
  name: string;
  base64: string;
  onConflict?: 'overwrite' | 'keep-both';
}): Promise<WorkspaceUploadResponse> {
  const response = await apiFetch(API_PATHS.workspaceFileUpload, {
    method: 'POST',
    timeoutMs: TIMEOUTS.upload,
    body: JSON.stringify(args),
  });
  return jsonRequest<WorkspaceUploadResponse>(response, '上传文件失败');
}

export async function downloadWorkspaceFile(path: string): Promise<Uint8Array> {
  const response = await apiFetch(API_PATHS.workspaceFileDownload(path), {
    timeoutMs: TIMEOUTS.upload,
  });
  if (!response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    throw apiErrorFromPayload(payload, response.status, '下载文件失败');
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * 原生端流式下载：由原生网络栈直接写入缓存文件，正文不进入 JS 内存。
 * 工作区是用户可见目录，可能有大文件；不能像 Web 端那样 arrayBuffer 全量缓冲。
 */
export async function downloadWorkspaceFileToCache(
  path: string,
  fileName: string
): Promise<File> {
  const destination = new File(Paths.cache, fileName);
  return File.downloadFileAsync(
    `${API_BASE}${API_PATHS.workspaceFileDownload(path)}`,
    destination,
    {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      // 允许覆盖同名缓存文件，重复打开不会因 DestinationAlreadyExists 失败
      idempotent: true,
    }
  );
}
