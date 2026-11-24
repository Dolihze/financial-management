<script setup lang="ts">
/**
 * 项目管理第一层：批次管理。点击批次号进入该批次下的合同列表。
 * 支持新增批次、修改批次号/备注、删除批次（批次下还有合同时后端会拒绝）。
 */
import type { Batch, BatchAttachment } from '@fm/shared';
import { ElMessage, ElMessageBox, type UploadFile, type UploadFiles, type UploadUserFile } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api';
import ProjectBreadcrumb from '@/components/ProjectBreadcrumb.vue';
import { validateBatchNo } from '@/utils/batchNo';
import { errorMessage, formatMoney } from '@/utils/format';

const router = useRouter();
const batches = ref<Batch[]>([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    batches.value = await api.batches.list();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    loading.value = false;
  }
}

// ---------- 前端分页 ----------
const PAGE_SIZE = 15;
const currentPage = ref(1);
const pageRows = computed(() => batches.value.slice((currentPage.value - 1) * PAGE_SIZE, currentPage.value * PAGE_SIZE));
const rowIndex = (i: number) => (currentPage.value - 1) * PAGE_SIZE + i + 1;

/** 迁移产生的「未分批」兜底批次（批次号 0）：展示为「未分批」，不能改号/删除 */
const isUnbatched = (b: Batch) => b.batchNo === 0;
const batchTitle = (b: Batch) => (isUnbatched(b) ? '未分批' : `第 ${b.batchNo} 批`);

function openBatch(b: Batch) {
  router.push({ name: 'contracts', params: { batchId: b.id } });
}

// ---------- 新增 / 编辑 ----------
const dlg = reactive({ visible: false, saving: false, editing: null as Batch | null });
const form = reactive({ batchNo: '', note: '' });
const batchNoError = computed(() => (dlg.editing && isUnbatched(dlg.editing) ? null : validateBatchNo(form.batchNo)));

/** 新增批次时选中的相关文件（批次保存成功后再逐个上传） */
const pendingFiles = ref<UploadUserFile[]>([]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 20;

/** 选择文件时的数量与大小校验：不合格的直接从待上传列表里移除并提示 */
function onFileChange(_file: UploadFile, files: UploadFiles) {
  const ok = files.filter((f) => {
    const size = f.raw?.size ?? f.size ?? 0;
    if (size === 0) {
      ElMessage.warning(`「${f.name}」是空文件，已忽略`);
      return false;
    }
    if (size > MAX_FILE_BYTES) {
      ElMessage.warning(`「${f.name}」超过 20 MB，已忽略`);
      return false;
    }
    return true;
  });
  // 编辑时要把已上传的文件数一并算进上限
  const quota = fileQuota.value;
  if (ok.length > quota) {
    ElMessage.warning(`一个批次最多上传 ${MAX_FILES} 个文件`);
    ok.length = quota;
  }
  pendingFiles.value = ok;
}

function openCreate() {
  dlg.editing = null;
  // 默认建议下一个批次号：当前最大批次号 + 1
  const max = batches.value.reduce((m, b) => Math.max(m, b.batchNo), 0);
  form.batchNo = String(max + 1);
  form.note = '';
  pendingFiles.value = [];
  dlg.visible = true;
}
function openEdit(b: Batch) {
  dlg.editing = b;
  form.batchNo = String(b.batchNo);
  form.note = b.note;
  pendingFiles.value = [];
  dlg.visible = true;
}

/** 编辑弹窗里「已上传文件」：取列表中实时的批次，删除/上传刷新后同步更新 */
const editingFiles = computed<BatchAttachment[]>(() => {
  if (!dlg.editing) return [];
  return batches.value.find((b) => b.id === dlg.editing!.id)?.attachments ?? [];
});
/** 还能再选几个文件（已上传 + 待上传 不超过上限） */
const fileQuota = computed(() => Math.max(0, MAX_FILES - editingFiles.value.length));

/** 删除已上传文件：二次确认后立即生效（后端软删除，保留记录与磁盘文件），不依赖「保存」 */
async function removeAttachment(a: BatchAttachment) {
  try {
    await ElMessageBox.confirm(`确定删除文件「${a.fileName}」吗？`, '删除文件', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    });
  } catch {
    return; // 取消
  }
  await withBusy(a.id, async () => {
    await api.batches.removeAttachment(a.id);
    await load();
    ElMessage.success('已删除文件');
  });
}

async function submit() {
  if (batchNoError.value) return ElMessage.warning(batchNoError.value);
  if (form.note.length > 200) return ElMessage.warning('备注不能超过 200 个字符');
  const batchNo = Number(form.batchNo.trim());
  dlg.saving = true;
  try {
    const editing = !!dlg.editing;
    const saved = dlg.editing
      ? await api.batches.update(dlg.editing.id, { batchNo, note: form.note.trim() })
      : await api.batches.create({ batchNo, note: form.note.trim() });
    // 批次已经保存：之后文件上传失败不能当作「保存失败」，否则用户会重复新增。逐个上传，失败的单独提示
    const failed: string[] = [];
    for (const f of pendingFiles.value) {
      if (!f.raw) continue;
      try {
        await api.batches.addAttachment(saved.id, f.raw);
      } catch (e) {
        failed.push(`${f.name}（${errorMessage(e)}）`);
      }
    }
    dlg.visible = false;
    await load();
    if (failed.length === 0) ElMessage.success(editing ? '已保存' : '已新增批次');
    else {
      ElMessageBox.alert(
        `批次已${editing ? '保存' : '新增'}（请勿重复提交），但以下文件上传失败：\n${failed.join('\n')}`,
        '部分文件上传失败',
        { type: 'warning', confirmButtonText: '知道了' }
      ).catch(() => {});
    }
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    dlg.saving = false;
  }
}

// ---------- 相关文件弹窗 ----------
const filesDialog = ref(false);
const filesOfId = ref<string | null>(null);
/** 用 id 实时取当前批次，上传后刷新列表时弹窗内容同步更新 */
const filesOf = computed(() => batches.value.find((b) => b.id === filesOfId.value) ?? null);
function showFiles(b: Batch) {
  filesOfId.value = b.id;
  filesDialog.value = true;
}

/** 正在打开/下载的文件 id：期间禁用对应按钮，避免大文件重复点击 */
const busyFiles = ref<Set<string>>(new Set());
async function withBusy(id: string, fn: () => Promise<void>) {
  if (busyFiles.value.has(id)) return;
  busyFiles.value = new Set(busyFiles.value).add(id);
  try {
    await fn();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    const next = new Set(busyFiles.value);
    next.delete(id);
    busyFiles.value = next;
  }
}
/** 点击文件名：用系统默认程序打开，不会下载 */
const openAttachment = (a: BatchAttachment) => withBusy(a.id, () => api.batches.openAttachment(a));
/** 点击「下载」：弹出系统另存为对话框 */
const downloadAttachment = (a: BatchAttachment) =>
  withBusy(a.id, async () => {
    if (await api.batches.downloadAttachment(a)) ElMessage.success('已保存');
  });

/** ISO 时间（UTC）显示为本地时间 YYYY-MM-DD HH:mm */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function remove(b: Batch) {
  if (b.contractCount > 0) {
    return ElMessage.warning(`「${batchTitle(b)}」下还有 ${b.contractCount} 个合同，请先把合同移到其他批次或删除后再删除批次`);
  }
  try {
    await ElMessageBox.confirm(`确定删除「${batchTitle(b)}」吗？`, '删除批次', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    });
  } catch {
    return; // 取消
  }
  try {
    await api.batches.remove(b.id);
    ElMessage.success('已删除批次');
    await load();
    if (pageRows.value.length === 0 && currentPage.value > 1) currentPage.value -= 1;
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}

onMounted(load);
</script>

<template>
  <div>
    <ProjectBreadcrumb :items="[{ label: '批次管理' }]" />

    <div class="page-toolbar">
      <el-button type="primary" icon="Plus" @click="openCreate">新增批次</el-button>
      <span class="hint">点击批次进入该批次下的合同</span>
    </div>

    <el-table v-loading="loading" :data="pageRows" border empty-text="暂无批次，点击「新增批次」或通过 Excel 导入项目自动生成">
      <el-table-column type="index" :index="rowIndex" label="序号" width="70" />
      <el-table-column label="批次" min-width="140">
        <template #default="{ row }">
          <a class="link" href="javascript:void(0)" title="查看该批次下的合同" @click.prevent="openBatch(row)">{{ batchTitle(row) }}</a>
        </template>
      </el-table-column>
      <el-table-column prop="contractCount" label="合同数" width="90" align="right" />
      <el-table-column prop="projectCount" label="项目数" width="90" align="right" />
      <el-table-column label="合同总价" width="150" align="right">
        <template #default="{ row }">{{ formatMoney(row.totalPrice) }}</template>
      </el-table-column>
      <el-table-column label="企信实收" width="150" align="right">
        <template #default="{ row }">{{ formatMoney(row.qxReceived) }}</template>
      </el-table-column>
      <el-table-column label="企信利润" width="150" align="right">
        <template #default="{ row }">{{ formatMoney(row.qxProfit) }}</template>
      </el-table-column>
      <el-table-column label="相关文件" width="160" align="left" header-align="left">
        <template #default="{ row }">
          <el-button v-if="(row as Batch).attachments.length" link type="primary" @click="showFiles(row)">
            <el-icon><Paperclip /></el-icon>
            <span class="file-link-text">查看文件（{{ (row as Batch).attachments.length }}）</span>
          </el-button>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="180" show-overflow-tooltip />
      <el-table-column label="操作" width="130" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="!isUnbatched(row)" link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-if="batches.length > PAGE_SIZE"
      v-model:current-page="currentPage"
      :page-size="PAGE_SIZE"
      :total="batches.length"
      layout="total, prev, pager, next"
      background
      style="margin-top: 16px; justify-content: flex-end"
    />

    <el-dialog v-model="dlg.visible" :title="dlg.editing ? '编辑批次' : '新增批次'" width="520px" draggable destroy-on-close align-center :close-on-click-modal="false">
      <el-form label-width="80px" @submit.prevent>
        <el-form-item label="批次号" required :error="form.batchNo && batchNoError ? batchNoError : ''">
          <el-input
            v-model="form.batchNo"
            :disabled="!!dlg.editing && isUnbatched(dlg.editing)"
            maxlength="6"
            placeholder="正整数，如 15"
            style="width: 200px"
            @keyup.enter="submit"
          >
            <template #prepend>第</template>
            <template #append>批</template>
          </el-input>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" maxlength="200" show-word-limit placeholder="可选" />
        </el-form-item>
        <!-- 编辑时：已上传的文件，可查看（打开）、下载、删除；删除立即生效 -->
        <el-form-item v-if="editingFiles.length" label="相关文件">
          <ul class="uploaded-list">
            <li v-for="a in editingFiles" :key="a.id" class="uploaded-item">
              <el-link class="file-link" type="primary" underline="never" :title="`点击用系统软件打开：${a.fileName}`" :disabled="busyFiles.has(a.id)" @click="openAttachment(a)">
                <el-icon><Paperclip /></el-icon>
                <span class="file-name">{{ a.fileName }}</span>
              </el-link>
              <span class="file-size">{{ formatSize(a.size) }}</span>
              <el-button link type="primary" size="small" :disabled="busyFiles.has(a.id)" @click="downloadAttachment(a)">下载</el-button>
              <el-button link type="danger" size="small" :disabled="busyFiles.has(a.id)" @click="removeAttachment(a)">删除</el-button>
            </li>
          </ul>
        </el-form-item>
        <!-- 中等大小的拖拽上传区（与记账流水一致）；选中的文件保存后一并上传 -->
        <el-form-item label="文件上传">
          <el-upload
            v-model:file-list="pendingFiles"
            multiple
            drag
            :auto-upload="false"
            :limit="MAX_FILES + 1"
            :disabled="fileQuota === 0"
            :on-change="onFileChange"
            class="compact-upload"
          >
            <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
            <div class="el-upload__text">拖拽文件到此处，或<em>点击选择</em></div>
            <template #tip>
              <div class="form-tip">单个不超过 20 MB，最多 {{ MAX_FILES }} 个；保存后{{ dlg.editing ? '上传新选的文件' : '一并上传' }}</div>
            </template>
          </el-upload>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg.visible = false">取消</el-button>
        <el-button type="primary" :loading="dlg.saving" :disabled="!!batchNoError" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 相关文件列表：点击文件名用系统默认程序打开，「下载」另存到本机 -->
    <el-dialog v-model="filesDialog" title="相关文件" width="640px" draggable align-center>
      <el-table :data="filesOf?.attachments ?? []" size="small" border max-height="360" empty-text="暂无文件">
        <el-table-column label="文件名" min-width="240" align="left" header-align="left">
          <template #default="{ row }">
            <el-link class="file-link" type="primary" underline="never" :title="`点击用系统软件打开：${row.fileName}`" :disabled="busyFiles.has(row.id)" @click="openAttachment(row)">
              <el-icon><Paperclip /></el-icon>
              <span class="file-name">{{ row.fileName }}</span>
            </el-link>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="90" align="left" header-align="left">
          <template #default="{ row }">{{ formatSize(row.size) }}</template>
        </el-table-column>
        <el-table-column label="上传时间" width="160" align="left" header-align="left">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="80" align="left" header-align="left">
          <template #default="{ row }">
            <el-button link type="primary" :loading="busyFiles.has(row.id)" @click="downloadAttachment(row)">下载</el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="filesDialog = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.link {
  color: var(--el-color-primary);
  cursor: pointer;
  text-decoration: none;
}
.link:hover {
  color: var(--el-color-primary-light-3);
  text-decoration: underline;
}
.hint {
  margin-left: 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.file-link-text {
  margin-left: 4px;
}
/* 文件名过长时显示省略号 */
.file-link {
  display: flex;
  justify-content: flex-start;
  max-width: 100%;
}
.file-link :deep(.el-link__inner) {
  display: flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
}
.file-name {
  flex: 1;
  min-width: 0;
  margin-left: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.uploaded-list {
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 140px;
  overflow-y: auto;
}
.uploaded-item {
  display: flex;
  align-items: center;
  gap: 8px;
  line-height: 28px;
}
.uploaded-item .file-link {
  flex: 1;
  min-width: 0;
}
.file-size {
  flex: none;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.form-tip {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.5;
}
</style>
