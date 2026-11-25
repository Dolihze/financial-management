<script setup lang="ts">
import type { Batch, Contract, Project } from '@fm/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api';
import { DEFAULT_PAGE_SIZE, MIN_PAGE_SIZE, PAGE_SIZES } from '@/utils/pagination';
import ProjectBreadcrumb from '@/components/ProjectBreadcrumb.vue';
import { contractPriceToCents, sumContractPrices, validateContractPrice } from '@/utils/contractPrice';
import { errorMessage, formatMoney, fromCents } from '@/utils/format';
import { useProjectRoutes } from '@/utils/projectRoutes';

/**
 * 项目管理第二层：某个批次下的合同。点击合同编号进入该合同的项目进度。
 * 批次由路由参数 batchId 决定；新增合同默认归属当前批次。
 * 「正在结算中」与「存档」共用本页：存档（sealed）时整页只读，隐藏新增 / 编辑 / 删除。
 */
const router = useRouter();
const route = useRoute();
const { sealed, names, rootLabel } = useProjectRoutes();
const batchId = computed(() => route.params.batchId as string);
const batch = ref<Batch | null>(null);
/** 全部批次：「编辑」弹框里的所属批次下拉 */
const allBatches = ref<Batch[]>([]);
const contracts = ref<Contract[]>([]);
const loading = ref(false);

const batchTitle = computed(() => (!batch.value ? '' : batch.value.batchNo === 0 ? '未分批' : `第 ${batch.value.batchNo} 批`));
const crumbs = computed(() => [
  { label: rootLabel.value, to: { name: names.value.batches } },
  { label: batchTitle.value || '…' }
]);

async function load() {
  loading.value = true;
  try {
    // 批次不存在（被删除/链接过期）时后端返回 404，提示后回到批次管理
    // 「所属批次」下拉只列正在结算中的批次：存档批次只读，合同不能移进去
    const [b, list, bs] = await Promise.all([api.batches.get(batchId.value), api.contracts.list(batchId.value), api.batches.list(false)]);
    // 批次的存档状态与当前页不一致（如在另一处被存档 / 取消存档后用旧链接打开）：回到对应的批次列表
    if ((b.sealedAt !== null) !== sealed.value) {
      ElMessage.warning(sealed.value ? '该批次已不在存档中' : '该批次已存档');
      router.replace({ name: sealed.value ? 'archive-batches' : 'batches' });
      return;
    }
    batch.value = b;
    contracts.value = list;
    allBatches.value = bs;
  } catch (e) {
    ElMessage.error(errorMessage(e));
    router.replace({ name: names.value.batches });
  } finally {
    loading.value = false;
  }
}

// 同一组件下切换批次（路由参数变化）时重新加载，并回到第一页、清空区域筛选
watch(batchId, () => {
  currentPage.value = 1;
  selectedRegions.value = [];
  load();
});

// ---------- 区域下拉筛选（表头漏斗，多选；合同含多个区域，命中任一即显示） ----------
const selectedRegions = ref<string[]>([]);
const regionFilters = computed(() => {
  const set = new Set(contracts.value.flatMap((c) => c.regions));
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })).map((r) => ({ text: r, value: r }));
});
const filteredContracts = computed(() =>
  selectedRegions.value.length === 0 ? contracts.value : contracts.value.filter((c) => c.regions.some((r) => selectedRegions.value.includes(r)))
);
function onFilterChange(filters: Record<string, unknown[]>) {
  if ('region' in filters) selectedRegions.value = filters.region as string[];
  currentPage.value = 1;
}
// 数据重新加载后结果变少时，当前页可能越界：夹回最后一页
watch(
  () => filteredContracts.value.length,
  (len) => {
    const last = Math.max(1, Math.ceil(len / pageSize.value));
    if (currentPage.value > last) currentPage.value = last;
  }
);

// ---------- 前端分页 ----------
const pageSize = ref(DEFAULT_PAGE_SIZE);
const currentPage = ref(1);
const pageRows = computed(() => filteredContracts.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
const rowIndex = (i: number) => (currentPage.value - 1) * pageSize.value + i + 1;

// ---------- 跳转 ----------
/** 点合同编号：进入该合同的项目进度 */
function openProgress(c: Contract) {
  router.push({ name: names.value.projects, params: { batchId: batchId.value, contractId: c.id } });
}

// ---------- 编辑合同：改「所属批次」「合同编号」和「备注」 ----------
const MAX_NOTE = 200;
const edit = reactive({ visible: false, saving: false, contract: null as Contract | null, batchId: '', contractNo: '', note: '' });
const batchLabel = (b: Batch) => (b.batchNo === 0 ? '未分批' : `第 ${b.batchNo} 批`);
const editNoError = computed(() => {
  const v = edit.contractNo.trim();
  if (!v) return '请输入合同编号';
  if (v.length > 50) return '合同编号不能超过 50 个字符';
  return '';
});
const editNoteError = computed(() => (edit.note.length > MAX_NOTE ? `备注不能超过 ${MAX_NOTE} 个字符` : ''));
const editDirty = computed(
  () =>
    !!edit.contract &&
    (edit.batchId !== edit.contract.batchId || edit.contractNo.trim() !== edit.contract.contractNo || edit.note.trim() !== edit.contract.note)
);

function openEdit(c: Contract) {
  edit.contract = c;
  edit.batchId = c.batchId;
  edit.contractNo = c.contractNo;
  edit.note = c.note;
  edit.visible = true;
}

async function submitEdit() {
  const c = edit.contract;
  if (!c) return;
  if (editNoError.value) return ElMessage.warning(editNoError.value);
  if (editNoteError.value) return ElMessage.warning(editNoteError.value);
  edit.saving = true;
  try {
    // projects 传空数组：后端对请求里没出现的项目保持不变，所以只会修改合同编号 / 所属批次 / 备注，合同价不受影响
    await api.contracts.update(c.id, { batchId: edit.batchId, contractNo: edit.contractNo.trim(), note: edit.note.trim(), projects: [] });
    const moved = edit.batchId !== c.batchId;
    ElMessage.success(moved ? '已保存，合同已移到所选批次' : '已保存');
    edit.visible = false;
    await load(); // 移走的合同不再属于当前批次，列表里会消失
    if (pageRows.value.length === 0 && currentPage.value > 1) currentPage.value -= 1;
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    edit.saving = false;
  }
}

/** 只有合同内部没有项目时才能删除（后端同样会校验） */
async function remove(c: Contract) {
  if (c.projectCount > 0) {
    return ElMessage.warning(`合同「${c.contractNo}」下还有 ${c.projectCount} 个项目，不能删除。请先进入合同，删除其下的项目后再删除合同`);
  }
  try {
    await ElMessageBox.confirm(`确定删除合同「${c.contractNo}」吗？`, '删除合同', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    });
  } catch {
    return; // 取消
  }
  try {
    await api.contracts.archive(c.id);
    ElMessage.success('已删除合同');
    await load();
    if (pageRows.value.length === 0 && currentPage.value > 1) currentPage.value -= 1;
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}

// ---------- 新增合同：从未结算项目表（未归入合同的项目）中挑选，并给每个项目设置合同价 ----------
// 项目归入合同 = 变为已结算项目，不入账；入账在项目编辑里把「企信收到钱」切换为是时发生
const dlg = reactive({ visible: false, saving: false, loading: false });
const contractNo = ref('');
const unsettled = ref<Project[]>([]);
const keyword = ref('');
const selectedIds = ref<string[]>([]);
/** 每个已选项目的合同价（元，字符串编辑；提交时转整数分） */
const prices = reactive<Record<string, string>>({});

const shown = computed(() => {
  const k = keyword.value.trim();
  return k ? unsettled.value.filter((p) => p.name.includes(k) || p.region.includes(k)) : unsettled.value;
});
const selectedProjects = computed(() => unsettled.value.filter((p) => selectedIds.value.includes(p.id)));

/** 合同总价 = 已选项目合同价之和（整数分求和）；任一价格不合法或总价越界时为 null */
const totalCents = computed<number | null>(() => sumContractPrices(selectedProjects.value.map((p) => prices[p.id])));

async function openCreate() {
  dlg.visible = true;
  dlg.loading = true;
  contractNo.value = '';
  keyword.value = '';
  selectedIds.value = [];
  for (const k of Object.keys(prices)) delete prices[k];
  try {
    // 未结算项目 = 尚未归入合同的项目
    unsettled.value = await api.projects.list({ settled: false });
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    dlg.loading = false;
  }
}

function onSelectionChange(rows: Project[]) {
  selectedIds.value = rows.map((r) => r.id);
  // 新选中的项目默认带入它原有的合同价，已填写的不覆盖
  for (const r of rows) if (!(r.id in prices)) prices[r.id] = fromCents(r.contractPrice);
}

async function submitCreate() {
  const no = contractNo.value.trim();
  if (!no) return ElMessage.warning('请输入合同编号');
  if (selectedProjects.value.length === 0) return ElMessage.warning('请至少选择一个项目');
  for (const p of selectedProjects.value) {
    const err = validateContractPrice(prices[p.id]);
    if (err) return ElMessage.warning(`「${p.name}」：${err}`);
  }
  if (totalCents.value === null) return ElMessage.warning('合同总价超出允许范围，请检查各项目合同价');
  dlg.saving = true;
  try {
    await api.contracts.create({
      batchId: batchId.value,
      contractNo: no,
      projects: selectedProjects.value.map((p) => ({ projectId: p.id, contractPrice: contractPriceToCents(prices[p.id]!) }))
    });
    ElMessage.success(`合同已创建，${selectedProjects.value.length} 个项目已归入合同`);
    dlg.visible = false;
    await load();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    dlg.saving = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <ProjectBreadcrumb :items="crumbs" />

    <div class="page-toolbar">
      <el-button v-if="!sealed" type="primary" icon="Plus" @click="openCreate">新增合同</el-button>
      <span class="hint">点击合同编号进入该合同的项目进度</span>
      <el-tag v-if="sealed" type="info" style="margin-left: 12px">存档只读</el-tag>
    </div>

    <el-table
      v-loading="loading"
      :data="pageRows"
      border
      class="contract-table"
      :empty-text="sealed ? '该批次下没有合同' : '该批次下暂无合同，点击「新增合同」创建'"
      @filter-change="onFilterChange"
    >
      <el-table-column type="index" :index="rowIndex" label="序号" width="70" />
      <el-table-column label="合同编号" min-width="200">
        <template #default="{ row }">
          <a class="contract-link" href="javascript:void(0)" title="查看该合同的项目进度" @click.prevent="openProgress(row)">{{ row.contractNo }}</a>
        </template>
      </el-table-column>
      <el-table-column
        column-key="region"
        label="区域"
        min-width="200"
        show-overflow-tooltip
        :filters="regionFilters"
        :filter-method="() => true"
        filter-multiple
      >
        <template #default="{ row }">{{ row.regions.join('、') }}</template>
      </el-table-column>
      <el-table-column prop="projectCount" label="项目数" width="90" align="right" />
      <el-table-column label="合同总价" width="190" align="right">
        <template #default="{ row }">{{ formatMoney(row.totalPrice) }}</template>
      </el-table-column>
      <el-table-column label="企信实收" width="180" align="right">
        <template #default="{ row }">{{ formatMoney(row.qxReceived) }}</template>
      </el-table-column>
      <el-table-column label="企信利润" width="180" align="right">
        <template #default="{ row }">{{ formatMoney(row.qxProfit) }}</template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="180" show-overflow-tooltip />
      <el-table-column v-if="!sealed" label="操作" width="130" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-if="filteredContracts.length > MIN_PAGE_SIZE"
      v-model:current-page="currentPage"
      v-model:page-size="pageSize"
      :page-sizes="PAGE_SIZES"
      :total="filteredContracts.length"
      layout="total, prev, pager, next, sizes"
      background
      @size-change="currentPage = 1"
      style="margin-top: 16px; justify-content: flex-end"
    />

    <el-dialog v-model="edit.visible" title="编辑合同" width="520px" draggable destroy-on-close align-center :close-on-click-modal="false">
      <el-form label-width="130px" @submit.prevent>
        <el-form-item label="所属批次" required>
          <el-select v-model="edit.batchId" style="width: 100%" placeholder="请选择批次">
            <el-option v-for="b in allBatches" :key="b.id" :label="batchLabel(b)" :value="b.id" />
          </el-select>
          <div v-if="edit.contract && edit.batchId !== edit.contract.batchId" class="form-tip">保存后，合同及其下项目将移到所选批次</div>
        </el-form-item>
        <el-form-item label="合同编号" required :error="edit.contractNo && editNoError ? editNoError : ''">
          <el-input v-model="edit.contractNo" maxlength="50" @keyup.enter="submitEdit" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="edit.note" type="textarea" :rows="3" :maxlength="MAX_NOTE" show-word-limit placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="edit.visible = false">取消</el-button>
        <el-button type="primary" :loading="edit.saving" :disabled="!editDirty || !!editNoError || !!editNoteError" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="dlg.visible" :title="`新增合同（归属${batchTitle}）`" width="860px" draggable destroy-on-close align-center :close-on-click-modal="false">
      <el-form label-width="130px" @submit.prevent>
        <el-form-item label="合同编号" required>
          <el-input v-model="contractNo" maxlength="50" style="width: 320px" placeholder="如 HT-2026-001" />
        </el-form-item>
        <el-form-item label="选择项目">
          <div class="pick">
            <el-input v-model="keyword" clearable placeholder="按项目名称 / 区域筛选（仅显示未结算项目：尚未归入合同）" style="margin-bottom: 8px" />
            <el-table
              v-loading="dlg.loading"
              :data="shown"
              border
              height="260"
              row-key="id"
              empty-text="没有可选的项目：请先在「未结算项目」中新建项目"
              @selection-change="onSelectionChange"
            >
              <el-table-column type="selection" width="50" :reserve-selection="true" />
              <el-table-column prop="region" label="区域" width="80" />
              <el-table-column prop="name" label="项目名称" min-width="220" show-overflow-tooltip />
              <el-table-column label="企信实收" width="160" align="right">
                <template #default="{ row }">{{ formatMoney(row.qxReceived) }}</template>
              </el-table-column>
            </el-table>
          </div>
        </el-form-item>
        <el-form-item v-if="selectedProjects.length" label="设置合同价">
          <div class="pick">
            <div v-for="p in selectedProjects" :key="p.id" class="price-row">
              <span class="price-name" :title="p.name">{{ p.name }}</span>
              <el-input
                v-model="prices[p.id]"
                class="price-input"
                :class="{ invalid: validateContractPrice(prices[p.id]) !== null }"
                placeholder="合同价（元）"
              >
                <template #prepend>¥</template>
              </el-input>
              <span v-if="validateContractPrice(prices[p.id])" class="err">{{ validateContractPrice(prices[p.id]) }}</span>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="合同总价">
          <b class="total">{{ totalCents === null ? '—' : formatMoney(totalCents) }}</b>
          <span class="hint">（已选 {{ selectedProjects.length }} 个项目的合同价之和）</span>
        </el-form-item>
        <el-form-item>
          <div class="form-tip" style="width: 100%">项目归入合同即成为已结算项目，此时不入账；需要入账时，在项目的编辑里把「企信收到钱」切换为是</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg.visible = false">取消</el-button>
        <el-button type="primary" :loading="dlg.saving" @click="submitCreate">创建合同</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.contract-link {
  color: var(--el-color-primary);
  cursor: pointer;
  text-decoration: none;
}
.contract-link:hover {
  color: var(--el-color-primary-light-3);
  text-decoration: underline;
}
.pick {
  width: 100%;
}
.price-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.price-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.price-input {
  width: 220px;
}
.form-tip {
  font-size: 16px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.err {
  font-size: 16px;
  color: var(--el-color-danger);
}
.invalid :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}
.total {
  font-size: 22px;
  color: #f56c6c;
}
.hint {
  margin-left: 12px;
  font-size: 18px;
  color: var(--el-text-color-secondary);
}
</style>
