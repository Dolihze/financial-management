<script setup lang="ts">
import { ACCOUNT_TYPE_LABELS, type OverviewSummary, type PeriodSummary } from '@fm/shared';
import * as echarts from 'echarts';
import { ElMessage } from 'element-plus';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '@/api';
import { errorMessage, formatMoney } from '@/utils/format';

const data = ref<OverviewSummary | null>(null);
const integrityOk = ref(true);
const trendEl = ref<HTMLDivElement>();
const pieEl = ref<HTMLDivElement>();
let charts: echarts.ECharts[] = [];

// ---------- 指定时间段统计 ----------
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** 用本地时间计算日期（不能用 toISOString，会因时区差一天） */
function monthRange(offset = 0): [string, string] {
  const n = new Date();
  return [ymd(new Date(n.getFullYear(), n.getMonth() + offset, 1)), ymd(new Date(n.getFullYear(), n.getMonth() + offset + 1, 0))];
}
const shortcuts = [
  { text: '本月', value: () => monthRange(0) },
  { text: '上月', value: () => monthRange(-1) },
  {
    text: '本季度',
    value: () => {
      const n = new Date();
      const q = Math.floor(n.getMonth() / 3) * 3;
      return [ymd(new Date(n.getFullYear(), q, 1)), ymd(new Date(n.getFullYear(), q + 3, 0))];
    }
  },
  { text: '今年', value: () => [ymd(new Date(new Date().getFullYear(), 0, 1)), ymd(new Date(new Date().getFullYear(), 11, 31))] },
  { text: '近 30 天', value: () => [ymd(new Date(Date.now() - 29 * 86400000)), ymd(new Date())] }
];

const range = ref<[string, string] | null>(monthRange(0));
const period = ref<PeriodSummary | null>(null);
const periodLoading = ref(false);
const periodPieEl = ref<HTMLDivElement>();
let periodPie: echarts.ECharts | null = null;
type DetailTab = 'expenseCategory' | 'expenseCounterparty' | 'incomeCategory' | 'incomeCounterparty';
const detailTab = ref<DetailTab>('expenseCategory');

/** 当前明细 Tab 对应的行：统一成 { name, amount, count } */
const detailRows = computed(() => {
  const p = period.value;
  if (!p) return [] as Array<{ name: string; amount: number; count: number }>;
  switch (detailTab.value) {
    case 'expenseCategory': return p.expenseByCategory.map((x) => ({ name: x.categoryName, amount: x.amount, count: x.count }));
    case 'incomeCategory': return p.incomeByCategory.map((x) => ({ name: x.categoryName, amount: x.amount, count: x.count }));
    case 'expenseCounterparty': return p.expenseByCounterparty;
    default: return p.incomeByCounterparty;
  }
});
const detailTotal = computed(() => detailRows.value.reduce((s, r) => s + r.amount, 0));
const isExpenseTab = computed(() => detailTab.value.startsWith('expense'));
/** 占比（仅展示）：按整数运算得到千分位再四舍五入，保留一位小数 */
const percentOf = (amount: number) => {
  if (detailTotal.value <= 0) return '-';
  const permille = Math.floor((amount * 1000 + Math.floor(detailTotal.value / 2)) / detailTotal.value);
  return `${Math.floor(permille / 10)}.${permille % 10}%`;
};

async function loadPeriod() {
  periodLoading.value = true;
  try {
    period.value = await api.overview.period({ from: range.value?.[0], to: range.value?.[1] });
    await nextTick();
    renderPeriodPie();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    periodLoading.value = false;
  }
}

function renderPeriodPie() {
  periodPie?.dispose();
  periodPie = null;
  if (!periodPieEl.value || !detailRows.value.length) return;
  periodPie = echarts.init(periodPieEl.value);
  periodPie.setOption({
    tooltip: { trigger: 'item', valueFormatter: (v: number) => formatMoney(v) },
    series: [{ type: 'pie', radius: ['40%', '70%'], data: detailRows.value.map((x) => ({ name: x.name, value: x.amount })) }]
  });
}

function onDetailTabChange() {
  nextTick(renderPeriodPie);
}
async function load() {
  try {
    const [summary, integrity] = await Promise.all([api.overview.summary(), api.overview.integrity()]);
    data.value = summary;
    integrityOk.value = integrity.ok;
    await nextTick();
    render(summary);
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}

function render(s: OverviewSummary) {
  charts.forEach((c) => c.dispose());
  charts = [];
  if (trendEl.value) {
    const c = echarts.init(trendEl.value);
    c.setOption({
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => formatMoney(v) },
      legend: { data: ['收入', '支出'] },
      grid: { left: 80, right: 20, top: 40, bottom: 30 },
      xAxis: { type: 'category', data: s.trend.map((t) => t.month) },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${v / 100}` } },
      series: [
        { name: '收入', type: 'bar', data: s.trend.map((t) => t.income), itemStyle: { color: '#f56c6c' } },
        { name: '支出', type: 'bar', data: s.trend.map((t) => t.expense), itemStyle: { color: '#67c23a' } }
      ]
    });
    charts.push(c);
  }
  if (pieEl.value) {
    const c = echarts.init(pieEl.value);
    c.setOption({
      tooltip: { trigger: 'item', valueFormatter: (v: number) => formatMoney(v) },
      series: [
        {
          type: 'pie',
          radius: ['40%', '70%'],
          data: s.expenseByCategory.map((x) => ({ name: x.categoryName, value: x.amount }))
        }
      ]
    });
    charts.push(c);
  }
}

const onResize = () => {
  charts.forEach((c) => c.resize());
  periodPie?.resize();
};
onMounted(() => {
  load();
  loadPeriod();
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  charts.forEach((c) => c.dispose());
  periodPie?.dispose();
});
</script>

<template>
  <div v-if="data">
    <el-alert v-if="!integrityOk" type="error" show-icon :closable="false" title="数据完整性检查未通过：存在分录异常的交易，请联系管理员" style="margin-bottom: 16px" />

    <el-row :gutter="16" style="margin-bottom: 16px">
      <el-col :span="8">
        <el-card shadow="never"><el-statistic title="公司总余额" :value="formatMoney(data.totalBalance)" /></el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never"><el-statistic title="本月收入" :value="formatMoney(data.monthIncome)" value-style="color: #f56c6c" /></el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never"><el-statistic title="本月支出" :value="formatMoney(data.monthExpense)" value-style="color: #67c23a" /></el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" style="margin-bottom: 16px" v-loading="periodLoading">
      <template #header>
        <div class="period-header">
          <span>时间段筛选</span>
          <el-date-picker
            v-model="range"
            type="daterange"
            unlink-panels
            clearable
            value-format="YYYY-MM-DD"
            range-separator="~"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            :shortcuts="shortcuts"
            style="width: 280px"
            @change="loadPeriod"
          />
          <el-text v-if="!range" type="info" size="small">未选日期：统计全部时间</el-text>
        </div>
      </template>
      <template v-if="period">
        <el-row :gutter="16" style="margin-bottom: 16px">
          <el-col :span="6"><el-statistic title="收入" :value="formatMoney(period.income)" value-style="color: #f56c6c" /></el-col>
          <el-col :span="6"><el-statistic title="支出" :value="formatMoney(period.expense)" value-style="color: #67c23a" /></el-col>
          <el-col :span="6">
            <el-statistic
              title="结余（收入 − 支出）"
              :value="formatMoney(period.profit)"
              :value-style="period.profit > 0 ? 'color: #f56c6c' : period.profit < 0 ? 'color: #67c23a' : ''"
            />
          </el-col>
          <el-col :span="6"><el-statistic title="流水笔数" :value="period.count" /></el-col>
        </el-row>

        <el-tabs v-model="detailTab" @tab-change="onDetailTabChange">
          <el-tab-pane label="支出去向（按分类）" name="expenseCategory" />
          <el-tab-pane label="支出去向（按往来单位）" name="expenseCounterparty" />
          <el-tab-pane label="收入来源（按分类）" name="incomeCategory" />
          <el-tab-pane label="收入来源（按往来单位）" name="incomeCounterparty" />
        </el-tabs>
        <el-row v-if="detailRows.length" :gutter="16">
          <el-col :span="14">
            <el-table :data="detailRows" size="small" max-height="320">
              <el-table-column type="index" label="#" width="50" />
              <el-table-column prop="name" :label="detailTab.endsWith('Category') ? '分类' : '往来单位'" />
              <el-table-column label="金额" width="150">
                <template #default="{ row }"><b :class="isExpenseTab ? 'amount-expense' : 'amount-income'">{{ formatMoney(row.amount) }}</b></template>
              </el-table-column>
              <el-table-column label="占比" width="90">
                <template #default="{ row }">{{ percentOf(row.amount) }}</template>
              </el-table-column>
              <el-table-column prop="count" label="笔数" width="70" />
            </el-table>
          </el-col>
          <el-col :span="10"><div ref="periodPieEl" style="height: 300px" /></el-col>
        </el-row>
        <el-empty v-else description="该时间段没有数据" :image-size="80" />
      </template>
    </el-card>
    <el-card shadow="never" header="资金分布" style="margin-bottom: 16px">
      <el-table :data="data.accounts" size="small" empty-text="还没有账户，请先到「账户管理」创建">
        <el-table-column prop="name" label="账户" />
        <el-table-column label="类型" width="120">
          <template #default="{ row }">{{ ACCOUNT_TYPE_LABELS[row.type as keyof typeof ACCOUNT_TYPE_LABELS] }}</template>
        </el-table-column>
        <el-table-column label="余额" align="right" width="180">
          <template #default="{ row }"><b :class="row.balance < 0 ? 'money-out' : ''">{{ formatMoney(row.balance) }}</b></template>
        </el-table-column>
        <el-table-column label="占比" width="160">
          <template #default="{ row }">
            <el-progress v-if="data.totalBalance > 0" :percentage="Math.max(0, Math.round((row.balance / data.totalBalance) * 100))" :stroke-width="10" />
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-row :gutter="16">
      <el-col :span="14"><el-card shadow="never" header="近 6 个月收支趋势"><div ref="trendEl" style="height: 300px" /></el-card></el-col>
      <el-col :span="10"><el-card shadow="never" header="本月支出分类"><div ref="pieEl" style="height: 300px" /></el-card></el-col>
    </el-row>
  </div>
</template>

<style scoped>
.period-header {
  display: flex;
  align-items: center;
  gap: 16px;
}
.amount-income {
  color: #f56c6c;
}
.amount-expense {
  color: #67c23a;
}
</style>