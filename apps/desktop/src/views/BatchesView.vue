<script setup lang="ts">
/**
 * 项目管理第一层：批次管理。点击批次号进入该批次下的合同列表。
 * 支持新增批次、修改批次号/备注、删除批次（批次下还有合同时后端会拒绝）。
 */
import type { Batch, BatchAttachment } from '@fm/shared';
import { ElMessage, ElMessageBox, type UploadFile, type UploadFiles, type UploadUserFile } from 'element-plus';
import type { TableInstance } from 'element-plus';
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api';
import { DEFAULT_PAGE_SIZE, MIN_PAGE_SIZE, PAGE_SIZES } from '@/utils/pagination';
import ProjectBreadcrumb from '@/components/ProjectBreadcrumb.vue';
import { validateBatchNo } from '@/utils/batchNo';
import { errorMessage, formatMoney } from '@/utils/format';
import { useProjectRoutes } from '@/utils/projectRoutes';

/**
 * 「正在结算中」与「存档」共用本页：存档（sealed）页展示已存档的批次，整页只读（隐藏新增 / 编辑 / 删除 / 存档），
 * 只提供「取消存档」；正在结算中页展示未存档的批次，用表格自带的勾选挑选批次，再点工具栏「存档」。
 */
const router = useRouter();
const { sealed, names, rootLabel } = useProjectRoutes();
const batches = ref<Batch[]>([]);
const loading = ref(false);
const tableRef = ref<TableInstance>();

async function load() {
  loading.value = true;
  try {
    batches.value = await api.batches.list(sealed.value);
    // 数据刷新后，已不在列表里的批次（被删除 / 刚存档）不应继续留在勾选里
    const alive = new Set(batches.value.map((b) => b.id));
    picked.value = picked.value.filter((b) => alive.has(b.id));
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    loading.value = false;
  }
}

// ---------- 前端分页 ----------
const pageSize = ref(DEFAULT_PAGE_SIZE);
const currentPage = ref(1);
const pageRows = computed(() => batches.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
const rowIndex = (i: number) => (currentPage.value - 1) * pageSize.value + i + 1;

/** 迁移产生的「未分批」兜底批次（批次号 0）：展示为「未分批」，不能改号/删除 */
const isUnbatched = (b: Batch) => b.batchNo === 0;
const batchTitle = (b: Batch) => (isUnbatched(b) ? '未分批' : `第 ${b.batchNo} 批`);

function openBatch(b: Batch) {
  router.push({ name: names.value.contracts, params: { batchId: b.id } });
}

// ---------- 存档：用表格勾选批次，没勾选时「存档」按钮置灰；点击后后端校验，通过才存档 ----------
/** 表格里当前勾选的批次（跨分页保留，见表格的 row-key + reserve-selection） */
const picked = ref<Batch[]>([]);
const sealing = ref(false);

async function confirmSeal() {
  const targets = picked.value.slice();
  if (targets.length === 0 || sealing.value) return; // 按钮已置灰，这里只是兜底
  const titles = targets.map(batchTitle).join('、');
  try {
    await ElMessageBox.confirm(`确定将「${titles}」存档吗？存档后这些批次整批只读，如需修改要先取消存档。`, '存档', {
      type: 'warning',
      confirmButtonText: '存档',
      cancelButtonText: '取消'
    });
  } catch {
    return; // 取消
  }
  sealing.value = true;
  try {
    await api.batches.seal(targets.map((b) => b.id));
    ElMessage.success(`已存档 ${targets.length} 个批次`);
    tableRef.value?.clearSelection();
    picked.value = [];
    await load();
    await nextTick();
    if (pageRows.value.length === 0 && currentPage.value > 1) currentPage.value -= 1;
  } catch (e) {
    // 校验不通过（还有项目没走完全部流程）时，后端的 message 已指出是哪个项目缺哪一步；弹窗展示。
    // 批次保持未存档、勾选保留，用户处理完项目后可直接再点「存档」
    ElMessageBox.alert(errorMessage(e), '不能存档', { type: 'warning', confirmButtonText: '知道了' }).catch(() => {});
  } finally {
    sealing.value = false;
  }
}

/** 取消存档：批次放回正在结算中，恢复可编辑 */
async function unseal(b: Batch) {
  try {
    await ElMessageBox.confirm(`确定取消「${batchTitle(b)}」的存档吗？取消后批次回到「正在结算中」，可以重新编辑。`, '取消存档', {
      type: 'warning',
      confirmButtonText: '取消存档',
      cancelButtonText: '返回'
    });
  } catch {
    return; // 取消
  }
  try {
    await api.batches.unseal(b.id);
    ElMessage.success('已取消存档，批次回到「正在结算中」');
    await load();
    if (pageRows.value.length === 0 && currentPage.value > 1) currentPage.value -= 1;
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
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
    <ProjectBreadcrumb :items="[{ label: rootLabel }]" />

    <div class="page-toolbar">
      <el-button v-if="!sealed" type="primary" icon="Plus" @click="openCreate">新增批次</el-button>
      <!-- 勾选批次后才可点击；没有勾选时置灰。点击后先二次确认，再由后端校验，通过才存档 -->
      <el-button v-if="!sealed" icon="Box" :disabled="picked.length === 0" :loading="sealing" @click="confirmSeal">
        存档{{ picked.length ? `（${picked.length}）` : '' }}
      </el-button>
      <span class="hint">点击批次进入该批次下的合同<template v-if="!sealed">；勾选批次后可「存档」</template></span>
      <el-tag v-if="sealed" type="info" style="margin-left: 12px">存档只读</el-tag>
    </div>

    <el-table
      ref="tableRef"
      v-loading="loading"
      :data="pageRows"
      border
      row-key="id"
      :empty-text="sealed ? '暂无存档的批次。在「正在结算中」里把已走完全部流程的批次存档后会出现在这里' : '暂无批次，点击「新增批次」或通过 Excel 导入项目自动生成'"
      @selection-change="picked = $event"
    >
      <!-- 勾选列只在「正在结算中」出现；reserve-selection 让翻页后已勾选的批次仍保持勾选 -->
      <el-table-column v-if="!sealed" type="selection" width="50" :reserve-selection="true" />
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
      <el-table-column v-if="!sealed" label="操作" width="130" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="!isUnbatched(row)" link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
      <!-- 存档页只读：唯一的操作是取消存档 -->
      <el-table-column v-else label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button link type="warning" @click="unseal(row)">取消存档</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-if="batches.length > MIN_PAGE_SIZE"
      v-model:current-page="currentPage"
      v-model:page-size="pageSize"
      :page-sizes="PAGE_SIZES"
      :total="batches.length"
      layout="total, prev, pager, next, sizes"
      background
      @size-change="currentPage = 1"
      style="margin-top: 16px; justify-content: flex-end"
    />

    <el-dialog v-if="!sealed" v-model="dlg.visible" :title="dlg.editing ? '编辑批次' : '新增批次'" width="520px" draggable destroy-on-close align-center :close-on-click-modal="false">
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
