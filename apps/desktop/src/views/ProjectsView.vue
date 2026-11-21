<script setup lang="ts">
import type { Project } from '@fm/shared';
import { ElMessage } from 'element-plus';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api';
import { errorMessage, formatMoney } from '@/utils/format';

const router = useRouter();
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

function openDetail(id: string) {
  router.push({ name: 'project-detail', params: { id } });
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-toolbar">
      <el-text type="info">项目数据仅支持通过「Excel 导入」维护。</el-text>
      <span class="spacer" />
      <el-button icon="Upload" @click="router.push({ name: 'import' })">去导入</el-button>
    </div>

    <el-table v-loading="loading" :data="projects" border class="project-table">
      <el-table-column type="index" label="序号" width="60" align="center" />
      <el-table-column prop="contractNo" label="合同编号" width="150" />
      <el-table-column prop="batchNo" label="批次号" width="80" />
      <el-table-column prop="region" label="区域" width="80" />
      <el-table-column label="项目名称" min-width="200">
        <template #default="{ row }">
          <a class="project-name" href="javascript:void(0)" @click.prevent="openDetail(row.id)">{{ row.name }}</a>
        </template>
      </el-table-column>
      <el-table-column label="合同价" align="right" width="125">
        <template #default="{ row }">{{ formatMoney(row.contractPrice) }}</template>
      </el-table-column>
      <el-table-column label="企信实收" align="right" width="125">
        <template #default="{ row }">{{ formatMoney(row.qxReceived) }}</template>
      </el-table-column>
      <el-table-column label="企信支付下家分包费" align="right" width="165">
        <template #default="{ row }">{{ formatMoney(row.qxSubcontractFee) }}</template>
      </el-table-column>
      <el-table-column label="陈沛" align="right" width="110">
        <template #default="{ row }">{{ formatMoney(row.chenPei) }}</template>
      </el-table-column>
      <el-table-column label="企信利润" align="right" width="115">
        <template #default="{ row }">{{ formatMoney(row.qxProfit) }}</template>
      </el-table-column>
      <el-table-column label="企信是否收到钱" align="center" width="135">
        <template #default="{ row }">
          <el-icon v-if="row.qxMoneyReceived" class="flag-yes" title="是"><Select /></el-icon>
          <el-icon v-else class="flag-no" title="否"><CloseBold /></el-icon>
        </template>
      </el-table-column>
      <el-table-column label="支付下家" align="center" width="85">
        <template #default="{ row }">
          <el-icon v-if="row.paidSubcontractor" class="flag-yes" title="是"><Select /></el-icon>
          <el-icon v-else class="flag-no" title="否"><CloseBold /></el-icon>
        </template>
      </el-table-column>
      <el-table-column label="支付陈沛" align="center" width="85">
        <template #default="{ row }">
          <el-icon v-if="row.paidChenPei" class="flag-yes" title="是"><Select /></el-icon>
          <el-icon v-else class="flag-no" title="否"><CloseBold /></el-icon>
        </template>
      </el-table-column>
    </el-table>
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
  font-size: 18px;
  vertical-align: middle;
}
.flag-yes {
  color: #67c23a;
}
.flag-no {
  color: #f56c6c;
}
</style>