import type { Project, ProjectStatus } from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';
import { writeAudit } from './audit';

interface ProjectRow {
  id: string;
  design_no: string;
  contract_no: string;
  name: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  designNo: r.design_no,
  contractNo: r.contract_no,
  name: r.name,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

export interface CreateProjectInput {
  name: string;
  designNo?: string;
  contractNo?: string;
  status?: ProjectStatus;
}

export class ProjectService {
  constructor(
    private readonly db: Db,
    private readonly deviceId: string
  ) {}

  list(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM project WHERE archived = 0 ORDER BY created_at DESC, rowid DESC')
      .all() as ProjectRow[];
    return rows.map(toProject);
  }

  get(id: string): Project {
    const row = this.db.prepare('SELECT * FROM project WHERE id = ? AND archived = 0').get(id) as ProjectRow | undefined;
    if (!row) throw new AppError('项目不存在', 404, 'NOT_FOUND');
    return toProject(row);
  }

  create(input: CreateProjectInput): Project {
    const name = input.name.trim();
    if (!name) throw new AppError('项目名称不能为空', 400, 'VALIDATION');
    const id = newId();
    const now = nowIso();
    const values = {
      designNo: (input.designNo ?? '').trim(),
      contractNo: (input.contractNo ?? '').trim(),
      status: input.status ?? 'unsettled'
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO project (id,design_no,contract_no,name,status,archived,created_at,updated_at,device_id)
           VALUES (?,?,?,?,?,0,?,?,?)`
        )
        .run(id, values.designNo, values.contractNo, name, values.status, now, now, this.deviceId);
      writeAudit(this.db, this.deviceId, 'project', id, 'create', { name, ...values });
    })();
    return this.get(id);
  }
}
