<script setup lang="ts">
import type { ImportBatch, ImportPreviewResult } from '@fm/shared';
import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus';
import { onMounted, ref } from 'vue';
import { api } from '@/api';
import ProjectImportPanel from '@/components/ProjectImportPanel.vue';
import { useBaseStore } from '@/stores/base';
import { errorMessage } from '@/utils/format';

const base = useBaseStore();
const file = ref<File | null>(null);
const preview = ref<ImportPreviewResult | null>(null);
const skipDuplicates = ref(true);
const busy = ref(false);
const batches = ref<ImportBatch[]>([]);
const tab = ref<'project' | 'tx'>('project');

async function loadBatches() {
  batches.value = await api.imports.list();
}

async function onFileChange(f: UploadFile) {
  file.value = f.raw ?? null;
  preview.value = null;
  if (!file.value) return;
  busy.value = true;
  try {
    preview.value = await api.imports.preview(file.value);
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    busy.value = false;
  }
}

async function commit() {
  if (!file.value) return;
  busy.value = true;
  try {
    const batch = await api.imports.commit(file.value, skipDuplicates.value);
    ElMessage.success(`导入成功：${batch.importedCount} 条`);
    file.value = null;
    preview.value = null;
    await Promise.all([loadBatches(), base.loadAccounts()]);
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    busy.value = false;
  }
}

async function revert(b: ImportBatch) {
  try {
    await ElMessageBox.confirm(`确认撤销批次「${b.fileName}」？该批次的 ${b.importedCount} 条流水将被删除。`, '撤销导入', { type: 'warning' });
    await api.imports.revert(b.id);
    ElMessage.success('已撤销');
    await Promise.all([loadBatches(), base.loadAccounts()]);
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(errorMessage(e));
  }
}

onMounted(loadBatches);
</script>

<template>
  <el-tabs v-model="tab">
    <el-tab-pane label="项目导入" name="project">
      <ProjectImportPanel />
    </el-tab-pane>
    <el-tab-pane label="流水导入" name="tx">
  <div>
    <el-card shadow="never" header="导入流水" style="margin-bottom: 16px">
      <el-steps :active="preview ? 2 : 1" simple style="margin-bottom: 16px">
        <el-step title="下载模板并填写" />
        <el-step title="上传并预览校验" />
        <el-step title="确认导入" />
      </el-steps>

      <div class="page-toolbar">
        <el-link type="primary" :href="api.imports.templateUrl()" target="_blank">下载 Excel 模板</el-link>
        <el-upload :auto-upload="false" :show-file-list="false" accept=".xlsx" :on-change="onFileChange">
          <el-button icon="Upload">选择 Excel 文件</el-button>
        </el-upload>
        <span v-if="file">{{ file.name }}</span>
      </div>
      <el-text type="info" size="small">注意：账户和分类必须在系统中已存在；借款/贷款请使用「记账流水」手工录入。</el-text>

      <div v-if="preview" v-loading="busy" style="margin-top: 16px">
        <el-descriptions :column="4" border>
          <el-descriptions-item label="总行数">{{ preview.total }}</el-descriptions-item>
          <el-descriptions-item label="可导入">{{ preview.valid }}</el-descriptions-item>
          <el-descriptions-item label="与已有重复">{{ preview.duplicates }}</el-descriptions-item>
          <el-descriptions-item label="错误行">
            <span :class="{ 'money-out': preview.errors.length }">{{ preview.errors.length }}</span>
          </el-descriptions-item>
        </el-descriptions>

        <el-table v-if="preview.errors.length" :data="preview.errors" size="small" border style="margin-top: 12px" max-height="240">
          <el-table-column prop="row" label="行号" width="80" />
          <el-table-column prop="message" label="错误原因" />
        </el-table>

        <div class="page-toolbar" style="margin-top: 12px">
          <el-checkbox v-if="preview.duplicates" v-model="skipDuplicates">跳过重复行</el-checkbox>
          <el-button type="primary" :disabled="preview.errors.length > 0 || preview.valid + preview.duplicates === 0" @click="commit">确认导入</el-button>
          <el-text v-if="preview.errors.length" type="danger">请修正 Excel 中的错误行后重新上传</el-text>
        </div>
      </div>
    </el-card>

    <el-card shadow="never" header="导入历史">
      <el-table :data="batches" size="small" border>
        <el-table-column prop="createdAt" label="时间" width="230" />
        <el-table-column prop="fileName" label="文件" />
        <el-table-column prop="importedCount" label="导入条数" width="100" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }"><el-tag :type="row.status === 'committed' ? 'success' : 'info'" size="small">{{ row.status === 'committed' ? '已导入' : '已撤销' }}</el-tag></template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }"><el-button v-if="row.status === 'committed'" link type="danger" @click="revert(row)">撤销</el-button></template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
    </el-tab-pane>
  </el-tabs>
</template>
