<script setup lang="ts">
import type { OverviewSummary, PeriodSummary } from '@fm/shared';
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '@/api';
import { errorMessage, formatMoney } from '@/utils/format';

const data = ref<OverviewSummary | null>(null);
const integrityOk = ref(true);

// ---------- 指定时间段统计 ----------
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** 用本地时间计算日期（不能用 toISOString，会因时区差一天） */
function monthRange(offset = 0): [string, string] {
  const n = new Date();
  return [ymd(new Date(n.getFullYear(), n.getMonth() + offset, 1)), ymd(new Date(n.getFullYear(), n.getMonth() + offset + 1, 0))];
}
/** 预设范围，每次调用按「当前日期」重新计算 */
function presetRange(key: Exclude<PeriodKey, 'custom'>): [string, string] {
  const n = new Date();
  switch (key) {
    case 'month': return monthRange(0);
    case 'lastMonth': return monthRange(-1);
    case 'quarter': {
      const q = Math.floor(n.getMonth() / 3) * 3;
      return [ymd(new Date(n.getFullYear(), q, 1)), ymd(new Date(n.getFullYear(), q + 3, 0))];
    }
    default: return [ymd(new Date(n.getFullYear(), 0, 1)), ymd(new Date(n.getFullYear(), 11, 31))];
  }
}
type PeriodKey = 'month' | 'lastMonth' | 'quarter' | 'year' | 'custom';
const PERIOD_TABS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'month', label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'quarter', label: '本季度' },
  { key: 'year', label: '今年' },
  { key: 'custom', label: '自定义' }
];
const periodKey = ref<PeriodKey>('month');
/** 自定义范围的「暂存值」：只有点「查询」才会真正用于统计 */
const customRange = ref<[string, string] | null>(monthRange(0));
/** 当前生效的统计范围（null = 全部时间） */
const range = ref<[string, string] | null>(presetRange('month'));

function selectPeriod(key: PeriodKey) {
  periodKey.value = key;
  if (key === 'custom') return; // 自定义：等用户选日期后点「查询」
  range.value = presetRange(key);
  loadPeriod();
}
function queryCustom() {
  range.value = customRange.value;
  loadPeriod();
}const period = ref<PeriodSummary | null>(null);
const periodLoading = ref(false);
type DetailRow = { name: string; amount: number; count: number };
type DimTab = 'category' | 'counterparty';
/** 左：支出去向；右：收入来源。各自独立切换「按分类 / 按往来单位」 */
const expenseTab = ref<DimTab>('category');
const incomeTab = ref<DimTab>('category');

const expenseRows = computed<DetailRow[]>(() => {
  const p = period.value;
  if (!p) return [];
  return expenseTab.value === 'category'
    ? p.expenseByCategory.map((x) => ({ name: x.categoryName, amount: x.amount, count: x.count }))
    : p.expenseByCounterparty;
});
const incomeRows = computed<DetailRow[]>(() => {
  const p = period.value;
  if (!p) return [];
  return incomeTab.value === 'category'
    ? p.incomeByCategory.map((x) => ({ name: x.categoryName, amount: x.amount, count: x.count }))
    : p.incomeByCounterparty;
});
const expenseTotal = computed(() => expenseRows.value.reduce((s, r) => s + r.amount, 0));
const incomeTotal = computed(() => incomeRows.value.reduce((s, r) => s + r.amount, 0));

// ---------- 锐辰欠款（计算口径待定，暂定为 0，单位：分） ----------
const ruichenDebt = ref(0);

// ---------- 三张表各自的前端分页（每页 15 条） ----------
const PAGE_SIZE = 15;
const accountPage = ref(1);
const incomePage = ref(1);
const expensePage = ref(1);
const slicePage = <T,>(rows: T[], page: number) => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
const accountPageRows = computed(() => slicePage(data.value?.accounts ?? [], accountPage.value));
const incomePageRows = computed(() => slicePage(incomeRows.value, incomePage.value));
const expensePageRows = computed(() => slicePage(expenseRows.value, expensePage.value));
/** 序号需跨页连续 */
const indexOf = (page: number) => (i: number) => (page - 1) * PAGE_SIZE + i + 1;
// 切换维度 Tab 后回到第 1 页（时间段变化在 loadPeriod 里重置）
watch(incomeTab, () => (incomePage.value = 1));
watch(expenseTab, () => (expensePage.value = 1));
/** 占比（仅展示）：按整数运算得到千分位再四舍五入，保留一位小数 */
const percentOf = (amount: number, total: number) => {
  if (total <= 0) return '-';
  const permille = Math.floor((amount * 1000 + Math.floor(total / 2)) / total);
  return `${Math.floor(permille / 10)}.${permille % 10}%`;
};

async function loadPeriod() {
  periodLoading.value = true;
  try {
    period.value = await api.overview.period({ from: range.value?.[0], to: range.value?.[1] });
    incomePage.value = 1;
    expensePage.value = 1;
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    periodLoading.value = false;
  }
}

async function load() {
  try {
    const [summary, integrity] = await Promise.all([api.overview.summary(), api.overview.integrity()]);
    data.value = summary;
    integrityOk.value = integrity.ok;
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}

onMounted(() => {
  load();
  loadPeriod();
});
</script>

<template>
  <div v-if="data" class="overview-page">
    <el-alert v-if="!integrityOk" type="error" show-icon :closable="false" title="数据完整性检查未通过：存在分录异常的交易，请联系管理员" style="margin-bottom: 16px" />

    <!-- 时间段筛选：页面最顶部 -->
    <div class="period-bar">
      <div class="period-tabs">
        <span
          v-for="t in PERIOD_TABS"
          :key="t.key"
          class="period-tab"
          :class="{ active: periodKey === t.key }"
          @click="selectPeriod(t.key)"
        >{{ t.label }}</span>
      </div>
      <template v-if="periodKey === 'custom'">
        <el-date-picker
          v-model="customRange"
          type="daterange"
          unlink-panels
          clearable
          value-format="YYYY-MM-DD"
          range-separator="~"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
        />
        <el-button type="primary" :loading="periodLoading" @click="queryCustom">查询</el-button>
        <el-text v-if="!customRange" type="info" size="small">未选日期：统计全部时间</el-text>
      </template>      <!-- 锐辰欠款：固定在筛选行最右侧（计算口径待定，暂定为 0） -->
      <div class="debt-box">
        <span class="debt-label">锐辰欠款</span>
        <b class="debt-value">{{ formatMoney(ruichenDebt) }}</b>
      </div>
    </div>

    <el-row :gutter="16" style="margin-bottom: 16px">
      <el-col :span="8">
        <el-card shadow="never"><el-statistic title="公司总余额" :value="formatMoney(data.totalBalance)" /></el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never"><el-statistic title="收入" :value="formatMoney(period?.income ?? 0)" value-style="color: #f56c6c" /></el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never"><el-statistic title="支出" :value="formatMoney(period?.expense ?? 0)" value-style="color: #67c23a" /></el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="period-card" v-loading="periodLoading">
      <template v-if="period">        <div class="panes">
          <!-- 资金分布 -->
          <div class="pane">
            <div class="pane-title">资金分布</div>
            <div class="pane-table">
              <el-table :data="accountPageRows" size="small" height="100%" :row-class-name="() => 'tall-row'" empty-text="还没有账户，请先到「账户管理」创建">
                <el-table-column type="index" :index="indexOf(accountPage)" label="#" width="40" />
                <el-table-column prop="name" label="账户" show-overflow-tooltip />
                <el-table-column label="余额" align="right" width="120">
                  <template #default="{ row }"><b :class="row.balance < 0 ? 'money-out' : ''">{{ formatMoney(row.balance) }}</b></template>
                </el-table-column>
                <el-table-column label="占比" width="64">
                  <template #default="{ row }">{{ percentOf(Math.max(0, row.balance), Math.max(0, data.totalBalance)) }}</template>
                </el-table-column>
              </el-table>
            </div>
            <el-pagination v-model:current-page="accountPage" class="pane-pager" small background layout="prev, pager, next" :page-size="PAGE_SIZE" :total="data.accounts.length" hide-on-single-page />
          </div>

          <!-- 收入来源 -->
          <div class="pane">
            <el-tabs v-model="incomeTab">
              <el-tab-pane label="收入来源（按分类）" name="category" />
              <el-tab-pane label="收入来源（按往来单位）" name="counterparty" />
            </el-tabs>
            <div class="pane-table">
              <el-table :data="incomePageRows" size="small" height="100%" :row-class-name="() => 'tall-row'" empty-text="该时间段没有收入数据">
                <el-table-column type="index" :index="indexOf(incomePage)" label="#" width="40" />
                <el-table-column prop="name" :label="incomeTab === 'category' ? '分类' : '往来单位'" show-overflow-tooltip />
                <el-table-column label="金额" width="110">
                  <template #default="{ row }"><b class="amount-income">{{ formatMoney(row.amount) }}</b></template>
                </el-table-column>
                <el-table-column label="占比" width="64">
                  <template #default="{ row }">{{ percentOf(row.amount, incomeTotal) }}</template>
                </el-table-column>
                <el-table-column prop="count" label="笔数" width="50" />
              </el-table>
            </div>
            <el-pagination v-model:current-page="incomePage" class="pane-pager" small background layout="prev, pager, next" :page-size="PAGE_SIZE" :total="incomeRows.length" hide-on-single-page />
          </div>

          <!-- 支出去向 -->
          <div class="pane">
            <el-tabs v-model="expenseTab">
              <el-tab-pane label="支出去向（按分类）" name="category" />
              <el-tab-pane label="支出去向（按往来单位）" name="counterparty" />
            </el-tabs>
            <div class="pane-table">
              <el-table :data="expensePageRows" size="small" height="100%" :row-class-name="() => 'tall-row'" empty-text="该时间段没有支出数据">
                <el-table-column type="index" :index="indexOf(expensePage)" label="#" width="40" />
                <el-table-column prop="name" :label="expenseTab === 'category' ? '分类' : '往来单位'" show-overflow-tooltip />
                <el-table-column label="金额" width="110">
                  <template #default="{ row }"><b class="amount-expense">{{ formatMoney(row.amount) }}</b></template>
                </el-table-column>
                <el-table-column label="占比" width="64">
                  <template #default="{ row }">{{ percentOf(row.amount, expenseTotal) }}</template>
                </el-table-column>
                <el-table-column prop="count" label="笔数" width="50" />
              </el-table>
            </div>
            <el-pagination v-model:current-page="expensePage" class="pane-pager" small background layout="prev, pager, next" :page-size="PAGE_SIZE" :total="expenseRows.length" hide-on-single-page />
          </div>
        </div>
      </template>
    </el-card>
  </div>
</template>

<style scoped>
/* 页面纵向 flex：筛选条和统计卡片在上，三张表格所在卡片占满剩余高度、分页贴底 */
.overview-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 560px;
}
.period-card {
  flex: 1;
  min-height: 0;
}
.period-card :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.period-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}
/* 时间段 Tab：文字 + 选中底部蓝条 */
.period-tabs {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
.period-tab {
  position: relative;
  padding: 0 14px;
  line-height: 32px;
  cursor: pointer;
  color: var(--el-text-color-regular);
  user-select: none;
}
.period-tab:hover {
  color: var(--el-color-primary);
}
.period-tab.active {
  color: var(--el-color-primary);
  font-weight: 600;
}
.period-tab.active::after {
  content: '';
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: -2px;
  height: 2px;
  border-radius: 1px;
  background: var(--el-color-primary);
}
/* 筛选行右侧的小模块：margin-left:auto 把它推到最右 */
.debt-box {
  margin-left: auto;
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 20px;
  height: 32px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-light);
  border-radius: 4px;
}
.debt-label {
  color: var(--el-text-color-regular);
}
.debt-value {
  font-size: 18px;
  color: var(--el-text-color-primary);
}
/* 日期范围选择器宽度：用官方变量控制，并禁止在 flex 行里被拉伸 */
.period-bar :deep(.el-date-editor.el-input__wrapper) {
  --el-date-editor-width: 350px;
  width: 350px;
  flex: none;
}
.panes {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 16px;
}
.pane {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.pane-table {
  flex: 1;
  min-height: 0;
}
.pane-pager {
  flex: none;
  justify-content: center;
  margin-top: 12px;
}
/* 行高加高 */
.pane :deep(.tall-row td.el-table__cell) {
  padding: 12px 0;
}
.pane :deep(.el-table__header th.el-table__cell) {
  padding: 12px 0;
}
/* 与 el-tabs 头部同高并带同样的底线，使三栏表格顶部对齐 */
.pane-title {
  flex: none;
  height: 40px;
  line-height: 40px;
  margin-bottom: 15px;
  font-size: 16px;
  color: var(--el-color-primary);
  border-bottom: 2px solid var(--el-border-color-light);
}
.pane :deep(.el-tabs) {
  flex: none;
}
.amount-income {
  color: #f56c6c;
}
.amount-expense {
  color: #67c23a;
}
</style>