import { createReadStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { BatchAttachment, TransactionAttachment } from '@fm/shared';
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

interface BatchAttachmentRow {
  id: string;
  batch_id: string;
  file_name: string;
  stored_name: string;
  mime_type: string;
  size: number;
  created_at: string;
}

export const toBatchAttachment = (r: BatchAttachmentRow): BatchAttachment => ({
  id: r.id,
  batchId: r.batch_id,
  fileName: r.file_name,
  mimeType: r.mime_type,
  size: r.size,
  createdAt: r.created_at
});

/** 可在浏览器内直接预览的类型；其余类型一律按下载处理，避免 HTML/SVG 等在本机来源下执行脚本 */
export const INLINE_MIME = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf|text\/plain)$/i;

/** 取一个安全的扩展名（只保留字母数字，最长 10 位），用于磁盘文件名；文件名本身不会来自用户输入 */
export function safeExt(fileName: string): string {
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
        .prepare('SELECT * FROM tx_attachment WHERE tx_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid')
        .all(txId) as AttachmentRow[]
    ).map(toAttachment);
  }

  /**
   * 给流水添加一个附件：先把文件落盘，再在事务里写元数据与审计；元数据写失败时删除刚落盘的文件，
   * 保证不会留下「库里有记录但没有文件」的坏数据。
   */
  add(txId: string, file: { fileName: string; mimeType: string; data: Buffer }): TransactionAttachment {
    this.assertTxExists(txId);
    if (file.data.length === 0) throw new AppError('文件内容为空', 400, 'VALIDATION');
    if (file.data.length > MAX_ATTACHMENT_BYTES) {
      throw new AppError(`文件过大，单个文件不能超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`, 413, 'FILE_TOO_LARGE');
    }
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM tx_attachment WHERE tx_id = ? AND deleted_at IS NULL').get(txId) as { c: number }).c;
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
    const row = this.db.prepare('SELECT * FROM tx_attachment WHERE id = ? AND deleted_at IS NULL').get(id) as AttachmentRow | undefined;
    if (!row) throw new AppError('文件不存在', 404, 'NOT_FOUND');
    return toAttachment(row);
  }

  /**
   * 「删除」流水文件 = 软删除（与批次文件一致）：只标记 deleted_at 并写审计，记录与磁盘文件保留。
   * 之后列表、下载都不再返回它，也不占用「最多 20 个」的名额。整笔流水被删除时才会连文件一并清理。
   */
  remove(id: string): TransactionAttachment {
    const cur = this.get(id);
    this.db.transaction(() => {
      this.db.prepare('UPDATE tx_attachment SET deleted_at = ? WHERE id = ?').run(nowIso(), id);
      writeAudit(this.db, this.deviceId, 'tx', cur.txId, 'detach', { attachmentId: id, fileName: cur.fileName, size: cur.size });
    })();
    return cur;
  }

  /** 打开文件内容用于下载/预览：返回元数据、读取流与是否可内联预览 */
  open(id: string): { meta: TransactionAttachment; stream: NodeJS.ReadableStream; inline: boolean } {
    const row = this.db.prepare('SELECT * FROM tx_attachment WHERE id = ? AND deleted_at IS NULL').get(id) as AttachmentRow | undefined;
    if (!row) throw new AppError('文件不存在', 404, 'NOT_FOUND');
    const path = this.pathOf(row.stored_name);
    if (!existsSync(path)) throw new AppError('文件已丢失（磁盘上找不到该文件）', 404, 'FILE_MISSING');
    return { meta: toAttachment(row), stream: createReadStream(path), inline: INLINE_MIME.test(row.mime_type) };
  }

  // ---------- 批次的相关文件（batch_attachment），与流水附件共用同一个磁盘目录 ----------

  private assertBatchExists(batchId: string): void {
    if (!this.db.prepare('SELECT 1 FROM batch WHERE id = ?').get(batchId)) throw new AppError('批次不存在', 404, 'NOT_FOUND');
  }

  listForBatch(batchId: string): BatchAttachment[] {
    this.assertBatchExists(batchId);
    return (
      this.db
        .prepare('SELECT * FROM batch_attachment WHERE batch_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid')
        .all(batchId) as BatchAttachmentRow[]
    ).map(toBatchAttachment);
  }

  /** 给批次添加一个附件：落盘与事务/回滚策略同 add() */
  addToBatch(batchId: string, file: { fileName: string; mimeType: string; data: Buffer }): BatchAttachment {
    this.assertBatchExists(batchId);
    if (file.data.length === 0) throw new AppError('文件内容为空', 400, 'VALIDATION');
    if (file.data.length > MAX_ATTACHMENT_BYTES) {
      throw new AppError(`文件过大，单个文件不能超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`, 413, 'FILE_TOO_LARGE');
    }
    const count = (
      this.db.prepare('SELECT COUNT(*) AS c FROM batch_attachment WHERE batch_id = ? AND deleted_at IS NULL').get(batchId) as { c: number }
    ).c;
    if (count >= MAX_ATTACHMENTS_PER_TX) {
      throw new AppError(`一个批次最多上传 ${MAX_ATTACHMENTS_PER_TX} 个文件`, 400, 'TOO_MANY_ATTACHMENTS');
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
            `INSERT INTO batch_attachment (id, batch_id, file_name, stored_name, mime_type, size, created_at, device_id)
             VALUES (?,?,?,?,?,?,?,?)`
          )
          .run(id, batchId, fileName, storedName, mimeType, file.data.length, nowIso(), this.deviceId);
        writeAudit(this.db, this.deviceId, 'batch', batchId, 'attach', { attachmentId: id, fileName, size: file.data.length });
      })();
    } catch (e) {
      try {
        unlinkSync(this.pathOf(storedName));
      } catch {
        /* 清理失败不掩盖原始错误 */
      }
      throw e;
    }
    return this.getBatchAttachment(id);
  }

  getBatchAttachment(id: string): BatchAttachment {
    const row = this.db.prepare('SELECT * FROM batch_attachment WHERE id = ? AND deleted_at IS NULL').get(id) as
      | BatchAttachmentRow
      | undefined;
    if (!row) throw new AppError('文件不存在', 404, 'NOT_FOUND');
    return toBatchAttachment(row);
  }

  /**
   * 「删除」批次文件 = 软删除：只标记 deleted_at 并写审计，记录与磁盘文件都保留（不物理删除财务数据）。
   * 之后列表、下载都不再返回它，也不占用「最多 20 个」的名额。
   */
  removeBatchAttachment(id: string): BatchAttachment {
    const cur = this.getBatchAttachment(id);
    this.db.transaction(() => {
      this.db.prepare('UPDATE batch_attachment SET deleted_at = ? WHERE id = ?').run(nowIso(), id);
      writeAudit(this.db, this.deviceId, 'batch', cur.batchId, 'detach', {
        attachmentId: id,
        fileName: cur.fileName,
        size: cur.size
      });
    })();
    return cur;
  }

  openBatchAttachment(id: string): { meta: BatchAttachment; stream: NodeJS.ReadableStream; inline: boolean } {
    const row = this.db.prepare('SELECT * FROM batch_attachment WHERE id = ? AND deleted_at IS NULL').get(id) as
      | BatchAttachmentRow
      | undefined;
    if (!row) throw new AppError('文件不存在', 404, 'NOT_FOUND');
    const path = this.pathOf(row.stored_name);
    if (!existsSync(path)) throw new AppError('文件已丢失（磁盘上找不到该文件）', 404, 'FILE_MISSING');
    return { meta: toBatchAttachment(row), stream: createReadStream(path), inline: INLINE_MIME.test(row.mime_type) };
  }
}
