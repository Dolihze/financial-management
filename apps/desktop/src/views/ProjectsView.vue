<script setup lang="ts">
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, type Project, type ProjectStatus } from '@fm/shared';
import { ElMessage } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api';
import { errorMessage } from '@/utils/format';

const router = useRouter();
const projects = ref<Project[]>([]);
const loading = ref(false);
const dialog = ref(false);
const form = reactive({ designNo: '', contractNo: '', name: '', status: 'unsettled' as ProjectStatus });

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

function openDialog() {
  Object.assign(form, { designNo: '', contractNo: '', name: '', status: 'unsettled' });
  dialog.value = true;
}

async function submit() {
  try {
    await api.projects.create({ ...form });
    dialog.value = false;
    await load();
    ElMessage.success('项目已创建');
  } catch (e) {
    ElMessage.error(errorMessage(e));
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
      <el-button type="primary" icon="Plus" @click="openDialog">新增项目</el-button>
    </div>

    <el-table v-loading="loading" :data="projects" border>
      <el-table-column prop="designNo" label="设计编号" width="200" />
      <el-table-column prop="contractNo" label="合同编号" width="200" />
      <el-table-column label="项目名称">
        <template #default="{ row }">
          <el-link type="primary" :underline="false" @click="openDetail(row.id)">{{ row.name }}</el-link>
        </template>
      </el-table-column>
      <el-table-column label="项目状态" width="120">
        <template #default="{ row }">
          <el-tag :type="row.status === 'settled' ? 'success' : 'warning'">
            {{ PROJECT_STATUS_LABELS[row.status as ProjectStatus] }}
          </el-tag>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" title="新增项目" width="460px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="设计编号"><el-input v-model="form.designNo" /></el-form-item>
        <el-form-item label="合同编号"><el-input v-model="form.contractNo" /></el-form-item>
        <el-form-item label="项目名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="项目状态">
          <el-select v-model="form.status" style="width: 100%">
            <el-option v-for="s in PROJECT_STATUSES" :key="s" :value="s" :label="PROJECT_STATUS_LABELS[s]" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :disabled="!form.name.trim()" @click="submit">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>
