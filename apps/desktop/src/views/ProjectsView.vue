<script setup lang="ts">
import type { Batch, ContractDetail, Project } from '@fm/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api';
import ProjectBreadcrumb from '@/components/ProjectBreadcrumb.vue';
import ProjectEditDialog from '@/components/ProjectEditDialog.vue';
import SettlementFields from '@/components/SettlementFields.vue';
import { errorMessage, formatMoney } from '@/utils/format';

/**
 * 项目管理第三层：某个合同下的项目进度。
 * 批次、合同由路由参数 batchId / contractId 决定；这里只展示该合同下的项目，所以没有「合同编号」「批次号」筛选。
 */
const router = useRouter();
const route = useRoute();
const batchId = computed(() => route.params.batchId as string);
const contractId = computed(() => route.params.contractId as string);
const batch = ref<Batch | null>(null);
const contract = ref<ContractDetail | null>(null);
const projects = ref<Project[]>([]);
const loading = ref(false);

const batchTitle = computed(() => (!batch.value ? '…' : batch.value.batchNo === 0 ? '未分批' : `第 ${batch.value.batchNo} 批`));
const crumbs = computed(() => [
  { label: '批次管理', to: { name: 'batches' } },
  { label: batchTitle.value, to: { name: 'contracts', params: { batchId: batchId.value } } },
  { label: contract.value?.contractNo ?? '…' }
]);

/** 已结算项目表里不应出现「项目结算 = 否」的项目（归入合同即结算），出现即为异常数据 */
const unsettledInContract = computed(() => projects.value.filter((p) => !p.qxMoneyReceived));
const unsettledMessage = computed(() => {
  const names = unsettledInContract.value.map((p) => `「${p.name}」`);
  const shown = names.slice(0, 3).join('、');
  const more = names.length > 3 ? ` 等 ${names.length} 个` : '';
  return `合同下有 ${names.length} 个项目的「项目结算」为否：${shown}${more}。已结算项目中不应出现未结算的项目，请核对`;
});

async function load() {
  loading.value = true;
  try {
    // 合同/批次不存在（被删除、链接过期）时后端 404：提示后回到上一层
    const [b, c, list] = await Promise.all([
      api.batches.get(batchId.value),
      api.contracts.get(contractId.value),
      api.projects.list({ contractId: contractId.value })
    ]);
    batch.value = b;
    contract.value = c;
    projects.value = list;
    // 项目归入合同即结算：合同下出现「项目结算 = 否」的项目是异常数据，直接报错提示
    if (unsettledInContract.value.length > 0) {
      ElMessage.error({ message: `数据异常：${unsettledMessage.value}`, duration: 8000, showClose: true });
    }
  } catch (e) {
    ElMessage.error(errorMessage(e));
    router.replace({ name: 'contracts', params: { batchId: batchId.value } });
  } finally {
    loading.value = false;
  }
}

// 同一组件下切换合同（路由参数变化）时重新加载并回到第一页、清空筛选
watch(contractId, () => {
  currentPage.value = 1;
  for (const k of Object.keys(selected) as FilterKey[]) selected[k] = [];
  load();
});

/** 下拉筛选：每列已选值（空数组 = 不筛选）。选项来自当前数据，去重后排序 */
type FilterKey = 'region' | 'paidSubcontractor' | 'paidChenPei';
const selected = reactive<Record<FilterKey, unknown[]>>({
  region: [], paidSubcontractor: [], paidChenPei: []
});

const EMPTY = '__empty__'; // 空值（未填写）的筛选项
const textOf = (v: unknown) => (v === null || v === undefined || v === '' ? EMPTY : v);

function optionsOf(key: 'region') {
  const set = new Set<unknown>(projects.value.map((p) => textOf(p[key])));
  const values = [...set].filter((v) => v !== EMPTY);
  values.sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'zh-CN', { numeric: true })));
  const opts = values.map((v) => ({ text: String(v), value: v }));
  if (set.has(EMPTY)) opts.push({ text: '（空）', value: EMPTY });
  return opts;
}
const regionFilters = computed(() => optionsOf('region'));
const yesNoFilters = [
  { text: '是', value: true },
  { text: '否', value: false }
];

/** 筛选后的数据：各列条件之间取「且」，同一列多选取「或」 */
const filtered = computed(() =>
  projects.value.filter((p) =>
    (Object.keys(selected) as FilterKey[]).every((k) => {
      const sel = selected[k];
      if (!sel.length) return true;
      return sel.includes(k === 'paidSubcontractor' || k === 'paidChenPei' ? p[k] : textOf(p[k]));
    })
  )
);

/** 前端分页：只切分表格显示的行；统计（totals）始终基于全部筛选结果 filtered，不受分页影响 */
const PAGE_SIZE = 10;
const currentPage = ref(1);
const pageRows = computed(() => filtered.value.slice((currentPage.value - 1) * PAGE_SIZE, currentPage.value * PAGE_SIZE));
/** 序号跨页连续：第 2 页从 31 开始 */
const rowIndex = (i: number) => (currentPage.value - 1) * PAGE_SIZE + i + 1;

function onFilterChange(filters: Record<string, unknown[]>) {
  for (const [col, vals] of Object.entries(filters)) {
    // column-key 即字段名
    if (col in selected) selected[col as FilterKey] = vals;
  }
  currentPage.value = 1; // 筛选条件变了，回到第一页
}

// 数据重新加载后结果变少时，当前页可能越界：夹回最后一页
watch(
  () => filtered.value.length,
  (len) => {
    const last = Math.max(1, Math.ceil(len / PAGE_SIZE));
    if (currentPage.value > last) currentPage.value = last;
  }
);

/** 统计：对筛选结果的整数分直接求和，不做浮点运算 */
const totals = computed(() => {
  const t = { contractPrice: 0, qxReceived: 0, qxSubcontractFee: 0, chenPei: 0, qxProfit: 0 };
  for (const p of filtered.value) {
    t.contractPrice += p.contractPrice;
    t.qxReceived += p.qxReceived;
    t.qxSubcontractFee += p.qxSubcontractFee;
    t.chenPei += p.chenPei;
    t.qxProfit += p.qxProfit;
  }
  return t;
});
const summaryItems = computed(() => [
  { label: '合同价', value: totals.value.contractPrice, color: 'red' },
  { label: '企信实收', value: totals.value.qxReceived, color: 'red' },
  { label: '企信支付下家', value: totals.value.qxSubcontractFee, color: 'green' },
  { label: '陈沛', value: totals.value.chenPei, color: 'green' },
  { label: '企信利润', value: totals.value.qxProfit, color: 'red' }
]);
// ---------- 编辑项目（弹窗）：原项目详情页的全部功能；保存/删除后刷新本页 ----------
const edit = reactive({ visible: false, projectId: '' });
function openEdit(p: Project) {
  edit.projectId = p.id;
  edit.visible = true;
}

/** 删除 = 归档（不物理删除）；已入账的项目后端会拒绝（409），需先在编辑里回退入账 */
async function removeProject(p: Project) {
  try {
    await ElMessageBox.confirm(`确认删除项目「${p.name}」？删除后将不再显示在项目列表中。`, '删除项目', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger'
    });
  } catch {
    return; // 用户取消
  }
  try {
    await api.projects.archive(p.id);
    ElMessage.success('已删除');
    await load();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}

// ---------- 新增项目：从未结算项目表（项目结算 = 否）中挑选，加入当前合同 ----------
// 项目归入合同 = 结算：加入时「项目结算」置为是，并按企信实收入账，所以要选入账账户与日期
const add = reactive({ visible: false, loading: false, saving: false, keyword: '', accountId: '', date: '' });
const candidates = ref<Project[]>([]);
const picked = ref<Project[]>([]);

const shownCandidates = computed(() => {
  const k = add.keyword.trim();
  return k ? candidates.value.filter((p) => p.name.includes(k) || p.region.includes(k)) : candidates.value;
});

async function openAdd() {
  add.visible = true;
  add.loading = true;
  add.keyword = '';
  add.accountId = '';
  add.date = '';
  picked.value = [];
  try {
    candidates.value = (await api.projects.list({ settled: false })).filter((p) => !p.contractId);
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    add.loading = false;
  }
}

async function confirmAdd() {
  const c = contract.value;
  if (!c) return;
  if (picked.value.length === 0) return ElMessage.warning('请至少选择一个项目');
  if (!add.accountId) return ElMessage.warning('项目归入合同即结算入账，请选择入账账户');
  if (!add.date) return ElMessage.warning('请选择入账日期');
  const noReceived = picked.value.find((p) => p.qxReceived <= 0);
  if (noReceived) return ElMessage.warning(`「${noReceived.name}」企信实收为 0，无法结算入账，请先填写企信实收`);
  add.saving = true;
  try {
    // 新加入的项目沿用它原有的合同价；合同里已有项目按当前价原样带上（不改动）。批次、合同编号保持不变
    await api.contracts.update(c.id, {
      contractNo: c.contractNo,
      projects: [
        ...c.projects.map((p) => ({ projectId: p.id, contractPrice: p.contractPrice })),
        ...picked.value.map((p) => ({ projectId: p.id, contractPrice: p.contractPrice }))
      ],
      settlement: { accountId: add.accountId, date: add.date }
    });
    ElMessage.success(`已新增 ${picked.value.length} 个项目，并已结算入账`);
    add.visible = false;
    await load();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    add.saving = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <ProjectBreadcrumb :items="crumbs" />

    <!-- 「去导入」放到顶部标题栏右侧 -->
    <Teleport to="#header-actions">
      <el-button icon="Upload" @click="router.push({ name: 'import' })">去导入</el-button>
    </Teleport>

    <div class="page-toolbar">
      <el-button type="primary" icon="Plus" @click="openAdd">新增项目</el-button>
      <span class="hint">合同 {{ contract?.contractNo }}（{{ batchTitle }}）</span>
    </div>

    <el-alert
      v-if="unsettledInContract.length > 0"
      type="error"
      show-icon
      :closable="false"
      :title="`数据异常：${unsettledMessage}`"
      style="margin-bottom: 12px"
    />

    <div class="summary-bar">
      <span class="summary-count">共 {{ filtered.length }} / {{ projects.length }} 个项目</span>
      <span v-for="s in summaryItems" :key="s.label" class="summary-item">
        <span class="summary-label">{{ s.label }}</span>
        <b :class="`summary-${s.color}`">{{ formatMoney(s.value) }}</b>
      </span>
    </div>

    <el-table v-loading="loading" :data="pageRows" border class="project-table" empty-text="该合同下暂无项目" @filter-change="onFilterChange">
      <el-table-column type="index" :index="rowIndex" label="序号" width="60" />

      <el-table-column prop="region" column-key="region" label="区域" width="80" :filters="regionFilters" :filter-method="() => true" filter-multiple />
      <el-table-column prop="name" label="项目名称" min-width="180" class-name="name-cell" />
      <el-table-column label="合同价" width="115">
        <template #default="{ row }">{{ formatMoney(row.contractPrice) }}</template>
      </el-table-column>
      <el-table-column label="企信实收" width="115">
        <template #default="{ row }">{{ formatMoney(row.qxReceived) }}</template>
      </el-table-column>
      <el-table-column label="企信支付下家" width="160">
        <template #default="{ row }">{{ formatMoney(row.qxSubcontractFee) }}</template>
      </el-table-column>
      <el-table-column label="陈沛" width="100">
        <template #default="{ row }">{{ formatMoney(row.chenPei) }}</template>
      </el-table-column>
      <el-table-column label="企信利润" width="110">
        <template #default="{ row }">{{ formatMoney(row.qxProfit) }}</template>
      </el-table-column>
      <!-- 「项目结算」列不展示：项目归入合同即结算，合同下的项目都是已结算（是） -->
      <el-table-column column-key="paidSubcontractor" label="支付下家" width="120" :filters="yesNoFilters" :filter-method="() => true">
        <template #default="{ row }">
          <el-icon v-if="row.paidSubcontractor" class="flag-yes" title="是"><Select /></el-icon>
          <el-icon v-else class="flag-no" title="否"><CloseBold /></el-icon>
        </template>
      </el-table-column>
      <el-table-column column-key="paidChenPei" label="支付陈沛" width="120" :filters="yesNoFilters" :filter-method="() => true">
        <template #default="{ row }">
          <el-icon v-if="row.paidChenPei" class="flag-yes" title="是"><Select /></el-icon>
          <el-icon v-else class="flag-no" title="否"><CloseBold /></el-icon>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" @click="removeProject(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-if="filtered.length > PAGE_SIZE"
      v-model:current-page="currentPage"
      :page-size="PAGE_SIZE"
      :total="filtered.length"
      layout="total, prev, pager, next"
      background
      style="margin-top: 16px; justify-content: flex-end"
    />

    <ProjectEditDialog v-model="edit.visible" :project-id="edit.projectId" @saved="load" />

    <el-dialog v-model="add.visible" title="添加项目" width="760px" append-to-body draggable destroy-on-close align-center :close-on-click-modal="false">
      <el-input
        v-model="add.keyword"
        clearable
        placeholder="按项目名称 / 区域筛选（仅显示未结算项目：项目结算为否）"
        style="margin-bottom: 8px"
      />
      <el-table
        v-loading="add.loading"
        :data="shownCandidates"
        border
        height="300"
        row-key="id"
        empty-text="没有可添加的项目：请先在「未结算项目」中新建项目"
        @selection-change="picked = $event"
      >
        <el-table-column type="selection" width="50" :reserve-selection="true" />
        <el-table-column prop="region" label="区域" width="80" />
        <el-table-column prop="name" label="项目名称" min-width="220" show-overflow-tooltip />
        <el-table-column label="原合同价" width="130" align="right">
          <template #default="{ row }">{{ formatMoney(row.contractPrice) }}</template>
        </el-table-column>
      </el-table>
      <div class="settle-row">
        <span class="settle-label">结算入账：</span>
        <SettlementFields v-model:account-id="add.accountId" v-model:date="add.date" />
      </div>
      <div class="settle-tip">项目加入合同即结算：「项目结算」置为是，并按各自企信实收记一笔收入</div>
      <template #footer>
        <el-button @click="add.visible = false">取消</el-button>
        <el-button type="primary" :loading="add.saving" :disabled="picked.length === 0" @click="confirmAdd">添加 {{ picked.length || '' }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.summary-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 28px;
  margin-bottom: 12px;
  padding: 10px 16px;
  background: #fff;
  border: 1px solid var(--el-border-color-light);
  border-radius: 4px;
}
.summary-count {
  color: var(--el-text-color-secondary);
}
.hint {
  margin-left: 12px;
  font-size: 14px;
  color: var(--el-text-color-secondary);
}
.summary-red {
  color: #f56c6c;
}
.summary-green {
  color: #67c23a;
}
.summary-label {
  margin-right: 8px;
  color: var(--el-text-color-secondary);
}
/* 金额、编号不换行；项目名称列（自适应）单独允许换行：项目名称可能很长，break-all 兼容无空格的中文长串 */
.project-table :deep(td .cell) {
  white-space: nowrap;
}
.project-table :deep(td.name-cell .cell) {
  white-space: normal;
  word-break: break-all;
  line-height: 1.5;
}
.settle-row {
  display: flex;
  align-items: center;
  margin-top: 12px;
}
.settle-label {
  margin-right: 8px;
}
.settle-tip {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
/* 是/否 图标：绿勾、红叉 */
.flag-yes,
.flag-no {
  font-size: 20px;
  vertical-align: middle;
}
.flag-yes {
  color: #67c23a;
}
.flag-no {
  color: #f56c6c;
}
</style>