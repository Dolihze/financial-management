import { createReadStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { TransactionAttachment } from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';
import { writeAudit } from './audit';

/** 单个附件大小上限（与全局 multipart 的 fileSize 限制一致） */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** 一笔流水最多可挂的附件数 */
export const MAX_ATTACHMENTS_PER_TX = 20;

interface AttachmentRow {
  id: string;
  tx_id: string;
  file_name: string;
  stored_name: string;
  mime_type: string;
  size: number;
  created_at: string;
}

export const toAttachment = (r: AttachmentRow): TransactionAttachment => ({
  id: r.id,
  txId: r.tx_id,
  fileName: r.file_name,
  mimeType: r.mime_type,
  size: r.size,
  createdAt: r.created_at
});

/** 可在浏览器内直接预览的类型；其余类型一律按下载处理，避免 HTML/SVG 等在本机来源下执行脚本 */
const INLINE_MIME = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf|text\/plain)$/i;

/** 取一个安全的扩展名（只保留字母数字，最长 10 位），用于磁盘文件名；文件名本身不会来自用户输入 */
function safeExt(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

/**
 * 去掉路径成分与控制字符，只保留文件名本身（浏览器一般只传文件名，但不能依赖这一点）。
 * 过长的名字截断但保留扩展名。
 */
export function sanitizeFileName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) return '未命名文件';
  if (cleaned.length <= 120) return cleaned;
  const ext = extname(cleaned).slice(0, 12);
  return cleaned.slice(0, 120 - ext.length) + ext;
}

export class AttachmentService {
  constructor(
    private readonly db: Db,
    private readonly deviceId: string,
    private readonly dir: string
  ) {}

  private pathOf(storedName: string): string {
    return join(this.dir, storedName);
  }

  private assertTxExists(txId: string): void {
    if (!this.db.prepare('SELECT 1 FROM tx WHERE id = ?').get(txId)) throw new AppError('交易不存在', 404, 'NOT_FOUND');
  }

  list(txId: string): TransactionAttachment[] {
    this.assertTxExists(txId);
    return (
      this.db
        .prepare('SELECT * FROM tx_attachment WHERE tx_id = ? ORDER BY created_at, rowid')
        .all(txId) as AttachmentRow[]
    ).map(toAttachment);
  }

  /**
   * 给流水添加一个附件：先把文件落盘，再在事务里写元数据与审计；元数据写失败时删除刚落盘的文件，
   * 保证不会留下「库里有记录但没有文件」的坏数据。作废的流水也允许补传凭证。
   */
  add(txId: string, file: { fileName: string; mimeType: string; data: Buffer }): TransactionAttachment {
    this.assertTxExists(txId);
    if (file.data.length === 0) throw new AppError('文件内容为空', 400, 'VALIDATION');
    if (file.data.length > MAX_ATTACHMENT_BYTES) {
      throw new AppError(`文件过大，单个文件不能超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`, 413, 'FILE_TOO_LARGE');
    }
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM tx_attachment WHERE tx_id = ?').get(txId) as { c: number }).c;
    if (count >= MAX_ATTACHMENTS_PER_TX) {
      throw new AppError(`一笔流水最多上传 ${MAX_ATTACHMENTS_PER_TX} 个文件`, 400, 'TOO_MANY_ATTACHMENTS');
    }

    const id = newId();
    const fileName = sanitizeFileName(file.fileName);
    const storedName = `${id}${safeExt(fileName)}`;
    const mimeType = file.mimeType || 'application/octet-stream';

    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.pathOf(storedName), file.data);
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO tx_attachment (id, tx_id, file_name, stored_name, mime_type, size, created_at, device_id)
             VALUES (?,?,?,?,?,?,?,?)`
          )
          .run(id, txId, fileName, storedName, mimeType, file.data.length, nowIso(), this.deviceId);
        writeAudit(this.db, this.deviceId, 'tx', txId, 'attach', { attachmentId: id, fileName, size: file.data.length });
      })();
    } catch (e) {
      try {
        unlinkSync(this.pathOf(storedName));
      } catch {
        /* 清理失败不掩盖原始错误 */
      }
      throw e;
    }
    return this.get(id);
  }

  get(id: string): TransactionAttachment {
    const row = this.db.prepare('SELECT * FROM tx_attachment WHERE id = ?').get(id) as AttachmentRow | undefined;
    if (!row) throw new AppError('文件不存在', 404, 'NOT_FOUND');
    return toAttachment(row);
  }

  /** 打开文件内容用于下载/预览：返回元数据、读取流与是否可内联预览 */
  open(id: string): { meta: TransactionAttachment; stream: NodeJS.ReadableStream; inline: boolean } {
    const row = this.db.prepare('SELECT * FROM tx_attachment WHERE id = ?').get(id) as AttachmentRow | undefined;
    if (!row) throw new AppError('文件不存在', 404, 'NOT_FOUND');
    const path = this.pathOf(row.stored_name);
    if (!existsSync(path)) throw new AppError('文件已丢失（磁盘上找不到该文件）', 404, 'FILE_MISSING');
    return { meta: toAttachment(row), stream: createReadStream(path), inline: INLINE_MIME.test(row.mime_type) };
  }
}
