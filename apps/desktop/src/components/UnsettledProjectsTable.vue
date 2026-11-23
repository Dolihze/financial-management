<script setup lang="ts">
import type { Project } from '@fm/shared';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { formatMoney } from '@/utils/format';

/**
 * 未结算项目表。
 * 定义（合同管理模块上线后落地）：项目初始合同字段为空、「企信是否收到钱」为否 => 未结算；
 * 归入某个合同后，「企信是否收到钱」置为是 => 已结算。
 * 目前数据来源尚未确定，先只做界面与空表：rows 暂为空数组，等数据来源确定后在这里接入。
 */
const router = useRouter();
const rows = ref<Project[]>([]);

const PAGE_SIZE = 30;
const currentPage = ref(1);
const pageRows = computed(() => rows.value.slice((currentPage.value - 1) * PAGE_SIZE, currentPage.value * PAGE_SIZE));
/** 序号跨页连续 */
const rowIndex = (i: number) => (currentPage.value - 1) * PAGE_SIZE + i + 1;

function openDetail(id: string) {
  router.push({ name: 'project-detail', params: { id } });
}
</script>

<template>
  <div>
    <el-table :data="pageRows" border class="project-table" empty-text="暂无未结算项目">
      <el-table-column type="index" :index="rowIndex" label="序号" width="60" />
      <el-table-column prop="batchNo" label="批次号" width="85" />
      <el-table-column prop="region" label="区域" width="80" />
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
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row.id)">详情</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-if="rows.length > PAGE_SIZE"
      v-model:current-page="currentPage"
      :page-size="PAGE_SIZE"
      :total="rows.length"
      layout="total, prev, pager, next"
      background
      style="margin-top: 16px; justify-content: flex-end"
    />
  </div>
</template>

<style scoped>
/* 金额、编号不换行；项目名称列（自适应）单独允许换行 */
.project-table :deep(td .cell) {
  white-space: nowrap;
}
.project-table :deep(td .cell:has(.project-name)) {
  white-space: normal;
}
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
</style>
