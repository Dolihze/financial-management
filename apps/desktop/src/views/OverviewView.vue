<script setup lang="ts">
import { ACCOUNT_TYPE_LABELS, type OverviewSummary } from '@fm/shared';
import * as echarts from 'echarts';
import { ElMessage } from 'element-plus';
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '@/api';
import { errorMessage, formatMoney } from '@/utils/format';

const data = ref<OverviewSummary | null>(null);
const integrityOk = ref(true);
const trendEl = ref<HTMLDivElement>();
const pieEl = ref<HTMLDivElement>();
let charts: echarts.ECharts[] = [];

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
        { name: '收入', type: 'bar', data: s.trend.map((t) => t.income), itemStyle: { color: '#67c23a' } },
        { name: '支出', type: 'bar', data: s.trend.map((t) => t.expense), itemStyle: { color: '#f56c6c' } }
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

const onResize = () => charts.forEach((c) => c.resize());
onMounted(() => {
  load();
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  charts.forEach((c) => c.dispose());
});
</script>

<template>
  <div v-if="data">
    <el-alert v-if="!integrityOk" type="error" show-icon :closable="false" title="数据完整性检查未通过：存在分录不平衡的转账，请联系管理员" style="margin-bottom: 16px" />

    <el-row :gutter="16" style="margin-bottom: 16px">
      <el-col :span="8">
        <el-card shadow="never"><el-statistic title="公司总余额" :value="formatMoney(data.totalBalance)" /></el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never"><el-statistic title="本月收入" :value="formatMoney(data.monthIncome)" value-style="color: #67c23a" /></el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never"><el-statistic title="本月支出" :value="formatMoney(data.monthExpense)" value-style="color: #f56c6c" /></el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" header="资金分布（每一笔钱在哪里）" style="margin-bottom: 16px">
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
