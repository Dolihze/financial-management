<script setup lang="ts">
import type { ContractDetail } from '@fm/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api';
import { errorMessage, formatMoney, fromCents, toCents } from '@/utils/format';

const route = useRoute();
const router = useRouter();
const id = route.params.id as string;

const contract = ref<ContractDetail | null>(null);
const loading = ref(false);
const saving = ref(false);

const contractNo = ref('');
/** 各项目合同价（元，字符串编辑；提交时转整数分，不做浮点运算） */
const prices = reactive<Record<string, string>>({});

function fill(c: ContractDetail) {
  contract.value = c;
  contractNo.value = c.contractNo;
  for (const k of Object.keys(prices)) delete prices[k];
  for (const p of c.projects) prices[p.id] = fromCents(p.contractPrice);
}

async function load() {
  loading.value = true;
  try {
    fill(await api.contracts.get(id));
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    loading.value = false;
  }
}

const priceValid = (v: string | undefined) => /^\d+(\.\d{1,2})?$/.test((v ?? '').trim());
const allValid = computed(() => !!contract.value && contract.value.projects.every((p) => priceValid(prices[p.id])));
/** 合同总价 = 各项目合同价之和（整数分）；有不合法的价格时为 null */
const totalCents = computed<number | null>(() => {
  if (!contract.value || !allValid.value) return null;
  return contract.value.projects.reduce((s, p) => s + toCents(prices[p.id]!.trim()), 0);
});

const dirty = computed(() => {
  const c = contract.value;
  if (!c) return false;
  if (contractNo.value.trim() !== c.contractNo) return true;
  return c.projects.some((p) => !priceValid(prices[p.id]) || toCents(prices[p.id]!.trim()) !== p.contractPrice);
});

async function save() {
  const c = contract.value;
  if (!c) return;
  const no = contractNo.value.trim();
  if (!no) return ElMessage.warning('请输入合同编号');
  if (!allValid.value) return ElMessage.warning('请为每个项目填写正确的合同价（非负，最多两位小数）');
  saving.value = true;
  try {
    fill(
      await api.contracts.update(id, {
        contractNo: no,
        projects: c.projects.map((p) => ({ projectId: p.id, contractPrice: toCents(prices[p.id]!.trim()) }))
      })
    );
    ElMessage.success('已保存');
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    saving.value = false;
  }
}

function reset() {
  if (contract.value) fill(contract.value);
}

async function back() {
  if (dirty.value) {
    try {
      await ElMessageBox.confirm('有未保存的修改，确定离开吗？', '提示', { type: 'warning', confirmButtonText: '离开', cancelButtonText: '继续编辑' });
    } catch {
      return;
    }
  }
  router.push({ name: 'contracts' });
}

function openProject(projectId: string) {
  router.push({ name: 'project-detail', params: { id: projectId } });
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <div class="page-toolbar">
      <el-button icon="Back" @click="back">返回合同列表</el-button>
      <span class="spacer" />
      <el-button :disabled="!contract || !dirty" @click="reset">重置</el-button>
      <el-button type="primary" icon="Check" :loading="saving" :disabled="!contract || !dirty" @click="save">保存</el-button>
    </div>

    <el-card v-if="contract" shadow="never">
      <el-form label-width="110px" style="max-width: 880px" @submit.prevent>
        <el-form-item label="合同编号" required>
          <el-input v-model="contractNo" maxlength="50" style="width: 320px" />
        </el-form-item>
        <el-form-item label="合同总价">
          <b class="total">{{ totalCents === null ? '—' : formatMoney(totalCents) }}</b>
          <span class="hint">（共 {{ contract.projects.length }} 个项目的合同价之和，修改下方合同价后自动变化）</span>
        </el-form-item>
        <el-form-item label="包含的项目">
          <el-table :data="contract.projects" border style="width: 100%" empty-text="该合同下暂无项目">
            <el-table-column type="index" label="序号" width="60" />
            <el-table-column prop="batchNo" label="批次号" width="80" />
            <el-table-column prop="region" label="区域" width="80" />
            <el-table-column label="项目名称" min-width="240">
              <template #default="{ row }">
                <a class="project-link" href="javascript:void(0)" @click.prevent="openProject(row.id)">{{ row.name }}</a>
              </template>
            </el-table-column>
            <el-table-column label="合同价" width="200">
              <template #default="{ row }">
                <el-input v-model="prices[row.id]" :class="{ invalid: !priceValid(prices[row.id]) }">
                  <template #prepend>¥</template>
                </el-input>
              </template>
            </el-table-column>
          </el-table>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.total {
  font-size: 20px;
  color: #f56c6c;
}
.hint {
  margin-left: 12px;
  font-size: 14px;
  color: var(--el-text-color-secondary);
}
.project-link {
  display: block;
  color: var(--el-color-primary);
  cursor: pointer;
  text-decoration: none;
  white-space: normal;
  word-break: break-all;
  line-height: 1.5;
}
.project-link:hover {
  color: var(--el-color-primary-light-3);
}
.invalid :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}
</style>
