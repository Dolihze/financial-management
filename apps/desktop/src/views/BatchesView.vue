<script setup lang="ts">
/**
 * 项目管理第一层：批次管理。点击批次号进入该批次下的合同列表。
 * 支持新增批次、修改批次号/备注、删除批次（批次下还有合同时后端会拒绝）。
 */
import type { Batch } from '@fm/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api';
import ProjectBreadcrumb from '@/components/ProjectBreadcrumb.vue';
import { validateBatchNo } from '@/utils/batchNo';
import { errorMessage, formatMoney } from '@/utils/format';

const router = useRouter();
const batches = ref<Batch[]>([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    batches.value = await api.batches.list();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    loading.value = false;
  }
}

// ---------- 前端分页 ----------
const PAGE_SIZE = 15;
const currentPage = ref(1);
const pageRows = computed(() => batches.value.slice((currentPage.value - 1) * PAGE_SIZE, currentPage.value * PAGE_SIZE));
const rowIndex = (i: number) => (currentPage.value - 1) * PAGE_SIZE + i + 1;

/** 迁移产生的「未分批」兜底批次（批次号 0）：展示为「未分批」，不能改号/删除 */
const isUnbatched = (b: Batch) => b.batchNo === 0;
const batchTitle = (b: Batch) => (isUnbatched(b) ? '未分批' : `第 ${b.batchNo} 批`);

function openBatch(b: Batch) {
  router.push({ name: 'contracts', params: { batchId: b.id } });
}

// ---------- 新增 / 编辑 ----------
const dlg = reactive({ visible: false, saving: false, editing: null as Batch | null });
const form = reactive({ batchNo: '', note: '' });
const batchNoError = computed(() => (dlg.editing && isUnbatched(dlg.editing) ? null : validateBatchNo(form.batchNo)));

function openCreate() {
  dlg.editing = null;
  // 默认建议下一个批次号：当前最大批次号 + 1
  const max = batches.value.reduce((m, b) => Math.max(m, b.batchNo), 0);
  form.batchNo = String(max + 1);
  form.note = '';
  dlg.visible = true;
}
function openEdit(b: Batch) {
  dlg.editing = b;
  form.batchNo = String(b.batchNo);
  form.note = b.note;
  dlg.visible = true;
}

async function submit() {
  if (batchNoError.value) return ElMessage.warning(batchNoError.value);
  if (form.note.length > 200) return ElMessage.warning('备注不能超过 200 个字符');
  const batchNo = Number(form.batchNo.trim());
  dlg.saving = true;
  try {
    if (dlg.editing) {
      await api.batches.update(dlg.editing.id, { batchNo, note: form.note.trim() });
      ElMessage.success('已保存');
    } else {
      await api.batches.create({ batchNo, note: form.note.trim() });
      ElMessage.success('已新增批次');
    }
    dlg.visible = false;
    await load();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    dlg.saving = false;
  }
}

async function remove(b: Batch) {
  if (b.contractCount > 0) {
    return ElMessage.warning(`「${batchTitle(b)}」下还有 ${b.contractCount} 个合同，请先把合同移到其他批次或删除后再删除批次`);
  }
  try {
    await ElMessageBox.confirm(`确定删除「${batchTitle(b)}」吗？`, '删除批次', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    });
  } catch {
    return; // 取消
  }
  try {
    await api.batches.remove(b.id);
    ElMessage.success('已删除批次');
    await load();
    if (pageRows.value.length === 0 && currentPage.value > 1) currentPage.value -= 1;
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}

onMounted(load);
</script>

<template>
  <div>
    <ProjectBreadcrumb :items="[{ label: '批次管理' }]" />

    <div class="page-toolbar">
      <el-button type="primary" icon="Plus" @click="openCreate">新增批次</el-button>
      <span class="hint">点击批次进入该批次下的合同</span>
    </div>

    <el-table v-loading="loading" :data="pageRows" border empty-text="暂无批次，点击「新增批次」或通过 Excel 导入项目自动生成">
      <el-table-column type="index" :index="rowIndex" label="序号" width="70" />
      <el-table-column label="批次" min-width="140">
        <template #default="{ row }">
          <a class="link" href="javascript:void(0)" title="查看该批次下的合同" @click.prevent="openBatch(row)">{{ batchTitle(row) }}</a>
        </template>
      </el-table-column>
      <el-table-column prop="contractCount" label="合同数" width="90" align="right" />
      <el-table-column prop="projectCount" label="项目数" width="90" align="right" />
      <el-table-column label="合同总价" width="150" align="right">
        <template #default="{ row }">{{ formatMoney(row.totalPrice) }}</template>
      </el-table-column>
      <el-table-column label="企信实收" width="150" align="right">
        <template #default="{ row }">{{ formatMoney(row.qxReceived) }}</template>
      </el-table-column>
      <el-table-column label="企信利润" width="150" align="right">
        <template #default="{ row }">{{ formatMoney(row.qxProfit) }}</template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="180" show-overflow-tooltip />
      <el-table-column label="操作" width="130" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="!isUnbatched(row)" link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-if="batches.length > PAGE_SIZE"
      v-model:current-page="currentPage"
      :page-size="PAGE_SIZE"
      :total="batches.length"
      layout="total, prev, pager, next"
      background
      style="margin-top: 16px; justify-content: flex-end"
    />

    <el-dialog v-model="dlg.visible" :title="dlg.editing ? '编辑批次' : '新增批次'" width="460px" draggable destroy-on-close align-center :close-on-click-modal="false">
      <el-form label-width="80px" @submit.prevent>
        <el-form-item label="批次号" required :error="form.batchNo && batchNoError ? batchNoError : ''">
          <el-input
            v-model="form.batchNo"
            :disabled="!!dlg.editing && isUnbatched(dlg.editing)"
            maxlength="6"
            placeholder="正整数，如 15"
            style="width: 200px"
            @keyup.enter="submit"
          >
            <template #prepend>第</template>
            <template #append>批</template>
          </el-input>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" maxlength="200" show-word-limit placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg.visible = false">取消</el-button>
        <el-button type="primary" :loading="dlg.saving" :disabled="!!batchNoError" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.link {
  color: var(--el-color-primary);
  cursor: pointer;
  text-decoration: none;
}
.link:hover {
  color: var(--el-color-primary-light-3);
  text-decoration: underline;
}
.hint {
  margin-left: 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
