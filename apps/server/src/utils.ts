import { randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();

/** 业务错误：路由层统一转换为 4xx 响应 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly code = 'BAD_REQUEST'
  ) {
    super(message);
  }
}
