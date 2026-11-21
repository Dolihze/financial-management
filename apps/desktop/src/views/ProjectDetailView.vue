<script setup lang="ts">
import type { Project } from '@fm/shared';
import { ElMessage } from 'element-plus';
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api';
import { errorMessage, formatMoney } from '@/utils/format';

const route = useRoute();
const router = useRouter();
const project = ref<Project | null>(null);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    project.value = await api.projects.get(route.params.id as string);
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <div class="page-toolbar">
      <el-button icon="Back" @click="router.push({ name: 'projects' })">返回项目列表</el-button>
    </div>

    <el-descriptions v-if="project" :title="project.name" :column="2" border>
      <el-descriptions-item label="合同编号">{{ project.contractNo }}</el-descriptions-item>
      <el-descriptions-item label="批次号">{{ project.batchNo }}</el-descriptions-item>
      <el-descriptions-item label="区域">{{ project.region }}</el-descriptions-item>
      <el-descriptions-item label="项目名称">{{ project.name }}</el-descriptions-item>
      <el-descriptions-item label="合同价">{{ formatMoney(project.contractPrice) }}</el-descriptions-item>
      <el-descriptions-item label="企信实收">{{ formatMoney(project.qxReceived) }}</el-descriptions-item>
      <el-descriptions-item label="企信支付下家分包费">{{ formatMoney(project.qxSubcontractFee) }}</el-descriptions-item>
      <el-descriptions-item label="陈沛">{{ formatMoney(project.chenPei) }}</el-descriptions-item>
      <el-descriptions-item label="企信利润">{{ formatMoney(project.qxProfit) }}</el-descriptions-item>
      <el-descriptions-item label="企信是否收到钱">{{ project.qxMoneyReceived ? '是' : '否' }}</el-descriptions-item>
      <el-descriptions-item label="支付下家">{{ project.paidSubcontractor ? '是' : '否' }}</el-descriptions-item>
      <el-descriptions-item label="支付陈沛">{{ project.paidChenPei ? '是' : '否' }}</el-descriptions-item>
    </el-descriptions>
  </div>
</template>
