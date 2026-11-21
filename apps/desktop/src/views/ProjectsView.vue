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

    <el-table v-loading="loading" :data="projects" border>
      <el-table-column prop="contractNo" label="合同编号" width="150" />
      <el-table-column prop="batchNo" label="批次号" width="100" />
      <el-table-column prop="region" label="区域" width="100" />
      <el-table-column label="项目名称" min-width="200">
        <template #default="{ row }">
          <el-link type="primary" :underline="false" @click="openDetail(row.id)">{{ row.name }}</el-link>
        </template>
      </el-table-column>
      <el-table-column label="合同价" align="right" width="130">
        <template #default="{ row }">{{ formatMoney(row.contractPrice) }}</template>
      </el-table-column>
      <el-table-column label="企信实收" align="right" width="130">
        <template #default="{ row }">{{ formatMoney(row.qxReceived) }}</template>
      </el-table-column>
      <el-table-column label="企信支付下家分包费" align="right" width="170">
        <template #default="{ row }">{{ formatMoney(row.qxSubcontractFee) }}</template>
      </el-table-column>
      <el-table-column label="陈沛" align="right" width="130">
        <template #default="{ row }">{{ formatMoney(row.chenPei) }}</template>
      </el-table-column>
      <el-table-column label="企信利润" align="right" width="130">
        <template #default="{ row }">{{ formatMoney(row.qxProfit) }}</template>
      </el-table-column>
      <el-table-column label="企信是否收到钱" align="center" width="140">
        <template #default="{ row }">
          <el-tag :type="row.qxMoneyReceived ? 'success' : 'info'">{{ row.qxMoneyReceived ? '是' : '否' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="支付下家" align="center" width="100">
        <template #default="{ row }">
          <el-tag :type="row.paidSubcontractor ? 'success' : 'info'">{{ row.paidSubcontractor ? '是' : '否' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="支付陈沛" align="center" width="100">
        <template #default="{ row }">
          <el-tag :type="row.paidChenPei ? 'success' : 'info'">{{ row.paidChenPei ? '是' : '否' }}</el-tag>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
