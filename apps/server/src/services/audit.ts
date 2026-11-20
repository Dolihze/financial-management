import type { Db } from '../db/database';
import { newId, nowIso } from '../utils';

/** 追加审计日志（只增不改不删） */
export function writeAudit(
  db: Db,
  deviceId: string,
  entity: string,
  entityId: string,
  action: string,
  payload: unknown = {}
): void {
  db.prepare(
    'INSERT INTO audit_log (id, entity, entity_id, action, payload, device_id, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(newId(), entity, entityId, action, JSON.stringify(payload), deviceId, nowIso());
}
