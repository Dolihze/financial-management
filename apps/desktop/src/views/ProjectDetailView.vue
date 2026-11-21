<script setup lang="ts">
import { PROJECT_STATUS_LABELS, type Project } from '@fm/shared';
import { ElMessage } from 'element-plus';
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api';
import { errorMessage } from '@/utils/format';

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
      <el-descriptions-item label="设计编号">{{ project.designNo }}</el-descriptions-item>
      <el-descriptions-item label="合同编号">{{ project.contractNo }}</el-descriptions-item>
      <el-descriptions-item label="项目名称">{{ project.name }}</el-descriptions-item>
      <el-descriptions-item label="项目状态">
        <el-tag :type="project.status === 'settled' ? 'success' : 'warning'">
          {{ PROJECT_STATUS_LABELS[project.status] }}
        </el-tag>
      </el-descriptions-item>
    </el-descriptions>
  </div>
</template>
