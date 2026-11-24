import type { FastifyInstance } from 'fastify';
import type { Services } from '../app';
import { MAX_ATTACHMENT_BYTES } from '../services/attachmentService';
import { AppError } from '../utils';

export function registerAttachmentRoutes(app: FastifyInstance, { attachments }: Services): void {
  app.get('/api/transactions/:id/attachments', async (req) => attachments.list((req.params as { id: string }).id));

  // 上传一个文件（multipart，字段名 file）；一次一个，前端多文件时逐个上传
  app.post('/api/transactions/:id/attachments', async (req, reply) => {
    const txId = (req.params as { id: string }).id;
    const file = await req.file({ limits: { fileSize: MAX_ATTACHMENT_BYTES } });
    if (!file) throw new AppError('请选择要上传的文件');
    const data = await file.toBuffer();
    // 超过大小限制时 multipart 会截断并置位 truncated，不能把被截断的文件存下来
    if (file.file.truncated) {
      throw new AppError(`文件过大，单个文件不能超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`, 413, 'FILE_TOO_LARGE');
    }
    return reply.status(201).send(attachments.add(txId, { fileName: file.filename, mimeType: file.mimetype, data }));
  });

  // 「删除」= 软删除（记录与磁盘文件保留，仅从列表隐藏并写审计）
  app.post('/api/attachments/:id/remove', async (req) => attachments.remove((req.params as { id: string }).id));

  // 取文件内容：图片/PDF 在浏览器内预览，其他类型下载。nosniff + 严格 CSP 防止被当作页面执行
  app.get('/api/attachments/:id/file', async (req, reply) => {
    const { meta, stream, inline } = attachments.open((req.params as { id: string }).id);
    return reply
      .header('Content-Type', inline ? meta.mimeType : 'application/octet-stream')
      .header('Content-Length', meta.size)
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.fileName)}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(stream);
  });

  // ---------- 批次的相关文件 ----------
  app.get('/api/batches/:id/attachments', async (req) => attachments.listForBatch((req.params as { id: string }).id));

  app.post('/api/batches/:id/attachments', async (req, reply) => {
    const batchId = (req.params as { id: string }).id;
    const file = await req.file({ limits: { fileSize: MAX_ATTACHMENT_BYTES } });
    if (!file) throw new AppError('请选择要上传的文件');
    const data = await file.toBuffer();
    if (file.file.truncated) {
      throw new AppError(`文件过大，单个文件不能超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`, 413, 'FILE_TOO_LARGE');
    }
    return reply.status(201).send(attachments.addToBatch(batchId, { fileName: file.filename, mimeType: file.mimetype, data }));
  });

  // 「删除」= 软删除（记录与磁盘文件保留，仅从列表隐藏并写审计）
  app.post('/api/batch-attachments/:id/remove', async (req) => attachments.removeBatchAttachment((req.params as { id: string }).id));

  app.get('/api/batch-attachments/:id/file', async (req, reply) => {
    const { meta, stream, inline } = attachments.openBatchAttachment((req.params as { id: string }).id);
    return reply
      .header('Content-Type', inline ? meta.mimeType : 'application/octet-stream')
      .header('Content-Length', meta.size)
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.fileName)}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(stream);
  });
}
