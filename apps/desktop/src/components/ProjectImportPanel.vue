<script setup lang="ts">
import type { ProjectImportPreview } from '@fm/shared';
import { ElMessage, type UploadFile } from 'element-plus';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api';
import { errorMessage } from '@/utils/format';

const router = useRouter();
const file = ref<File | null>(null);
const preview = ref<ProjectImportPreview | null>(null);
const busy = ref(false);

async function onFileChange(f: UploadFile) {
  file.value = f.raw ?? null;
  preview.value = null;
  if (!file.value) return;
  busy.value = true;
  try {
    preview.value = await api.projects.importPreview(file.value);
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
    const r = await api.projects.importCommit(file.value);
    const kept = r.skippedPosted ? `（其中 ${r.skippedPosted} 个项目因字段已入账，对应的「是」标记和金额保持不变）` : '';
    ElMessage.success(`导入成功：新增 ${r.created} 个，更新 ${r.updated} 个项目${kept}`);
    file.value = null;
    preview.value = null;
    router.push({ name: 'batches' }); // 导入后回到项目管理入口（批次 → 合同 → 项目）
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <el-card shadow="never" header="导入项目">
    <el-steps :active="preview ? 2 : 1" simple style="margin-bottom: 16px">
      <el-step title="下载模板并填写" />
      <el-step title="上传并预览校验" />
      <el-step title="确认导入" />
    </el-steps>

    <div class="page-toolbar">
      <el-link type="primary" :href="api.projects.importTemplateUrl()" target="_blank">下载 Excel 模板</el-link>
      <el-upload :auto-upload="false" :show-file-list="false" accept=".xlsx" :on-change="onFileChange">
        <el-button icon="Upload">选择 Excel 文件</el-button>
      </el-upload>
      <span v-if="file">{{ file.name }}</span>
    </div>
    <el-text type="info" size="small">
      第 1 行为表头，只有「项目名称」「合同价」两列必须有，其余列（区域、批次、合同编号、备注等）都可以没有：新增项目时缺的列取默认值，更新已有项目时缺的列保持原值、不会被清零。项目名称为「合计」的行（以及重复表头的说明行）会被忽略，其余行为项目数据。「批次」写作「第15批」或数字 15，批次随合同走：合同编号在系统中不存在时，会自动新建合同并归入该批次（批次不存在也会自动新建，批次留空则归入「未分批」）；合同编号已存在的，沿用合同原来的批次，不会被 Excel 里的批次改动；没有合同编号的项目不属于任何批次。以项目名称为准：项目名称已存在的项目会被更新，否则新增（合同编号可以重复）；「项目结算 / 支付下家 / 支付陈沛」只有填「是」才记为是，其他内容一律记为否（旧版表头「企信是否收到钱」仍可识别为「项目结算」）。
    </el-text>

    <div v-if="preview" v-loading="busy" style="margin-top: 16px">
      <el-descriptions :column="4" border>
        <el-descriptions-item label="数据行数">{{ preview.total }}</el-descriptions-item>
        <el-descriptions-item label="将新增">{{ preview.toCreate }}</el-descriptions-item>
        <el-descriptions-item label="将更新（项目名称已存在）">
          {{ preview.toUpdate }}
          <el-text v-if="preview.toUpdatePartially" type="warning" size="small">
            其中 {{ preview.toUpdatePartially }} 个项目有字段已入账，该字段的「是」标记和金额不会被覆盖
          </el-text>
        </el-descriptions-item>
        <el-descriptions-item label="错误行">
          <span :class="{ 'money-out': preview.errors.length }">{{ preview.errors.length }}</span>
        </el-descriptions-item>
      </el-descriptions>

      <el-table v-if="preview.errors.length" :data="preview.errors" size="small" border style="margin-top: 12px" max-height="240">
        <el-table-column prop="row" label="行号" width="80" />
        <el-table-column prop="message" label="错误原因" />
      </el-table>

      <div class="page-toolbar" style="margin-top: 12px">
        <el-button type="primary" :disabled="preview.errors.length > 0 || preview.total === 0" @click="commit">确认导入</el-button>
        <el-text v-if="preview.errors.length" type="danger">请修正 Excel 中的错误行后重新上传</el-text>
      </div>
    </div>
  </el-card>
</template>
