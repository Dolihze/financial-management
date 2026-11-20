/**
 * 后端地址解析与就绪等待（仅本地桌面模式使用）。
 *
 * - 开发（vite dev / tauri dev）：端口固定为 DEV_BASE（与 apps/server 默认端口、src-tauri 的 DEV_BACKEND_PORT 一致）
 * - 发布（Tauri 打包）：端口由 Rust 随机选取，通过 `get_backend_url` 命令取得；
 *   就绪由 Rust 发出 `backend-ready` 事件通知，错过事件时用 `is_backend_ready` 补查
 * - 纯浏览器打开页面（没有 Tauri）：直接用开发地址，不等待事件
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const DEV_BASE = 'http://127.0.0.1:17890';
const EVENT_BACKEND_READY = 'backend-ready';

/** 是否运行在 Tauri 窗口里 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 解析后端基础地址。
 * 开发版固定端口，无需询问 Rust；发布版必须向 Rust 取随机端口，取不到时抛错而不是静默回退，
 * 否则会悄悄连到别的程序占用的 17890 端口。
 */
export async function resolveBackendBase(): Promise<string> {
  const override = import.meta.env.VITE_API_BASE as string | undefined;
  if (override) return override.replace(/\/$/, '');
  if (import.meta.env.DEV || !isTauri()) return DEV_BASE;
  return invoke<string>('get_backend_url');
}

/**
 * 等待后端就绪。
 * @returns true=就绪；false=Rust 侧超时或本函数超时
 */
export async function waitBackendReady(timeoutMs = 70000): Promise<boolean> {
  if (!isTauri()) return true;
  if (await invoke<boolean>('is_backend_ready')) return true;

  return new Promise<boolean>((resolve) => {
    let done = false;
    let unlisten: () => void = () => {};

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unlisten();
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    listen<boolean>(EVENT_BACKEND_READY, (e) => finish(Boolean(e.payload))).then((fn) => {
      unlisten = fn;
      if (done) fn();
    });

    // 监听注册期间事件可能已经发出，补查一次，避免永远等不到
    invoke<boolean>('is_backend_ready').then((ok) => {
      if (ok) finish(true);
    });
  });
}
