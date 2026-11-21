/**
 * HTTP 客户端。后端地址集中在此处管理：
 * - 本地模式：启动时由 App.vue 调用 setBaseUrl(await resolveBackendBase())，
 *   开发版为固定端口，发布版为 Tauri 随机选取的端口（见 ./backend.ts）
 * - 联网模式（后期）：把 baseUrl 指向云端服务并附带 token 即可
 */
import { DEV_BASE } from './backend';

// 初始值仅用于模块加载到 setBaseUrl 之间；发布版真实端口在启动时才确定
let baseUrl: string = DEV_BASE;
let authToken: string | null = null;

export const setBaseUrl = (url: string): void => {
  baseUrl = url.replace(/\/$/, '');
};
export const setAuthToken = (token: string | null): void => {
  authToken = token;
};
export const getBaseUrl = (): string => baseUrl;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string
  ) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) {
    const type = res.headers.get('content-type') ?? '';
    return (type.includes('application/json') ? res.json() : res.blob()) as Promise<T>;
  }
  let body: { code?: string; message?: string } = {};
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  throw new ApiError(body.message ?? `请求失败 (${res.status})`, res.status, body.code ?? 'UNKNOWN');
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}`, ...extra } : extra;
}

export async function get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
  const url = new URL(baseUrl + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return handle<T>(await fetch(url, { headers: headers() }));
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  return handle<T>(
    await fetch(baseUrl + path, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body ?? {})
    })
  );
}

export async function patch<T>(path: string, body: unknown): Promise<T> {
  return handle<T>(
    await fetch(baseUrl + path, {
      method: 'PATCH',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    })
  );
}

export async function del<T>(path: string): Promise<T> {
  return handle<T>(await fetch(baseUrl + path, { method: 'DELETE', headers: headers() }));
}

export async function upload<T>(path: string, file: File, query?: Record<string, string>): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  const url = new URL(baseUrl + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return handle<T>(await fetch(url, { method: 'POST', headers: headers(), body: form }));
}
