<script setup lang="ts">
import type { Project } from '@fm/shared';
import { ElMessage } from 'element-plus';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api';
import { errorMessage, formatMoney } from '@/utils/format';

const router = useRouter();
const route = useRoute();
const projects = ref<Project[]>([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    projects.value = await api.projects.list();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    loading.value = false;
  }
}

/** 下拉筛选：每列已选值（空数组 = 不筛选）。选项来自当前数据，去重后排序 */
type FilterKey = 'contractNo' | 'batchNo' | 'region' | 'qxMoneyReceived' | 'paidSubcontractor' | 'paidChenPei';
const selected = reactive<Record<FilterKey, unknown[]>>({
  // 从「合同管理」点合同编号跳过来时，URL 带 ?contractNo=xxx，预置为该合同的筛选
  contractNo: typeof route.query.contractNo === 'string' && route.query.contractNo ? [route.query.contractNo] : [],
  batchNo: [], region: [], qxMoneyReceived: [], paidSubcontractor: [], paidChenPei: []
});

const EMPTY = '__empty__'; // 空值（未填写）的筛选项
const textOf = (v: unknown) => (v === null || v === undefined || v === '' ? EMPTY : v);

function optionsOf(key: 'contractNo' | 'batchNo' | 'region') {
  const set = new Set<unknown>(projects.value.map((p) => textOf(p[key])));
  const values = [...set].filter((v) => v !== EMPTY);
  values.sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'zh-CN', { numeric: true })));
  const opts = values.map((v) => ({ text: String(v), value: v }));
  if (set.has(EMPTY)) opts.push({ text: '（空）', value: EMPTY });
  return opts;
}
const contractNoFilters = computed(() => optionsOf('contractNo'));
const batchNoFilters = computed(() => optionsOf('batchNo'));
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
      return sel.includes(k === 'qxMoneyReceived' || k === 'paidSubcontractor' || k === 'paidChenPei' ? p[k] : textOf(p[k]));
    })
  )
);

/** 前端分页：只切分表格显示的行；统计（totals）始终基于全部筛选结果 filtered，不受分页影响 */
const PAGE_SIZE = 30;
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
  { label: '企信支付下家分包费', value: totals.value.qxSubcontractFee, color: 'green' },
  { label: '陈沛', value: totals.value.chenPei, color: 'green' },
  { label: '企信利润', value: totals.value.qxProfit, color: 'red' }
]);
function openDetail(id: string) {
  router.push({ name: 'project-detail', params: { id } });
}

onMounted(load);
</script>

<template>
  <div>
    <!-- 「去导入」放到顶部标题栏右侧 -->
    <Teleport to="#header-actions">
      <el-button icon="Upload" @click="router.push({ name: 'import' })">去导入</el-button>
    </Teleport>

    <div class="summary-bar">
      <span class="summary-count">共 {{ filtered.length }} / {{ projects.length }} 个项目</span>
      <span v-for="s in summaryItems" :key="s.label" class="summary-item">
        <span class="summary-label">{{ s.label }}</span>
        <b :class="`summary-${s.color}`">{{ formatMoney(s.value) }}</b>
      </span>
    </div>

    <el-table v-loading="loading" :data="pageRows" border class="project-table" @filter-change="onFilterChange">
      <el-table-column type="index" :index="rowIndex" label="序号" width="60" />
      <el-table-column prop="contractNo" column-key="contractNo" label="合同编号" width="145" :filters="contractNoFilters" :filtered-value="selected.contractNo as string[]" :filter-method="() => true" filter-multiple />
      <el-table-column prop="batchNo" column-key="batchNo" label="批次号" width="85" :filters="batchNoFilters" :filter-method="() => true" filter-multiple />
      <el-table-column prop="region" column-key="region" label="区域" width="80" :filters="regionFilters" :filter-method="() => true" filter-multiple />
      <el-table-column label="项目名称" min-width="180">
        <template #default="{ row }">
          <a class="project-name" href="javascript:void(0)" @click.prevent="openDetail(row.id)">{{ row.name }}</a>
        </template>
      </el-table-column>
      <el-table-column label="合同价" width="115">
        <template #default="{ row }">{{ formatMoney(row.contractPrice) }}</template>
      </el-table-column>
      <el-table-column label="企信实收" width="115">
        <template #default="{ row }">{{ formatMoney(row.qxReceived) }}</template>
      </el-table-column>
      <el-table-column label="企信支付下家分包费" width="160">
        <template #default="{ row }">{{ formatMoney(row.qxSubcontractFee) }}</template>
      </el-table-column>
      <el-table-column label="陈沛" width="100">
        <template #default="{ row }">{{ formatMoney(row.chenPei) }}</template>
      </el-table-column>
      <el-table-column label="企信利润" width="110">
        <template #default="{ row }">{{ formatMoney(row.qxProfit) }}</template>
      </el-table-column>
      <el-table-column column-key="qxMoneyReceived" label="项目结算" width="110" :filters="yesNoFilters" :filter-method="() => true">
        <template #default="{ row }">
          <el-icon v-if="row.qxMoneyReceived" class="flag-yes" title="是"><Select /></el-icon>
          <el-icon v-else class="flag-no" title="否"><CloseBold /></el-icon>
        </template>
      </el-table-column>
      <el-table-column column-key="paidSubcontractor" label="支付下家" width="95" :filters="yesNoFilters" :filter-method="() => true">
        <template #default="{ row }">
          <el-icon v-if="row.paidSubcontractor" class="flag-yes" title="是"><Select /></el-icon>
          <el-icon v-else class="flag-no" title="否"><CloseBold /></el-icon>
        </template>
      </el-table-column>
      <el-table-column column-key="paidChenPei" label="支付陈沛" width="95" :filters="yesNoFilters" :filter-method="() => true">
        <template #default="{ row }">
          <el-icon v-if="row.paidChenPei" class="flag-yes" title="是"><Select /></el-icon>
          <el-icon v-else class="flag-no" title="否"><CloseBold /></el-icon>
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
/* 金额、编号不换行；项目名称列（自适应）单独允许换行 */
.project-table :deep(td .cell) {
  white-space: nowrap;
}
.project-table :deep(td .cell:has(.project-name)) {
  white-space: normal;
}
/* 项目名称可能很长：用普通 <a>（块级文本）而不是 el-link（inline-flex + nowrap），
   这样会占满单元格宽度并自动换行；break-all 兼容无空格的中文长串 */
.project-name {
  display: block;
  color: var(--el-color-primary);
  cursor: pointer;
  text-decoration: none;
  white-space: normal;
  word-break: break-all;
  line-height: 1.5;
}
.project-name:hover {
  color: var(--el-color-primary-light-3);
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