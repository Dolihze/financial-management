<script setup lang="ts">
import type { ContractDetail, Project } from '@fm/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api';
import { contractPriceToCents, sumContractPrices, validateContractPrice } from '@/utils/contractPrice';
import { errorMessage, formatMoney, fromCents } from '@/utils/format';

const route = useRoute();
const router = useRouter();
const id = route.params.id as string;

const contract = ref<ContractDetail | null>(null);
const loading = ref(false);
const saving = ref(false);

const contractNo = ref('');
/** 各项目合同价（元，字符串编辑；提交时转整数分，不做浮点运算） */
const prices = reactive<Record<string, string>>({});
/** 本次编辑中新加入、尚未保存的项目（保存后才真正归入合同） */
const pending = ref<Project[]>([]);

/** 表格展示的项目：已有项目 + 待加入项目 */
type Row = { id: string; name: string; batchNo: number | null; region: string; isNew: boolean };
const rows = computed<Row[]>(() => {
  const c = contract.value;
  if (!c) return [];
  return [
    ...c.projects.map((p) => ({ id: p.id, name: p.name, batchNo: p.batchNo, region: p.region, isNew: false })),
    ...pending.value.map((p) => ({ id: p.id, name: p.name, batchNo: p.batchNo, region: p.region, isNew: true }))
  ];
});

function fill(c: ContractDetail) {
  contract.value = c;
  contractNo.value = c.contractNo;
  pending.value = [];
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

const priceError = (v: string | undefined) => validateContractPrice(v);
const priceValid = (v: string | undefined) => priceError(v) === null;
const allValid = computed(() => rows.value.length > 0 && rows.value.every((r) => priceValid(prices[r.id])));
const firstError = computed(() => {
  for (const r of rows.value) {
    const err = priceError(prices[r.id]);
    if (err) return `「${r.name}」：${err}`;
  }
  return null;
});
/** 合同总价 = 各项目合同价之和（整数分）；有不合法的价格或总价越界时为 null */
const totalCents = computed<number | null>(() => sumContractPrices(rows.value.map((r) => prices[r.id])));

const dirty = computed(() => {
  const c = contract.value;
  if (!c) return false;
  if (pending.value.length > 0) return true;
  if (contractNo.value.trim() !== c.contractNo) return true;
  return c.projects.some((p) => !priceValid(prices[p.id]) || contractPriceToCents(prices[p.id]!) !== p.contractPrice);
});

async function save() {
  const c = contract.value;
  if (!c) return;
  const no = contractNo.value.trim();
  if (!no) return ElMessage.warning('请输入合同编号');
  if (firstError.value) return ElMessage.warning(firstError.value);
  if (totalCents.value === null) return ElMessage.warning('合同总价超出允许范围，请检查各项目合同价');
  saving.value = true;
  try {
    fill(
      await api.contracts.update(id, {
        contractNo: no,
        projects: rows.value.map((r) => ({ projectId: r.id, contractPrice: contractPriceToCents(prices[r.id]!) }))
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

// ---------- 添加项目：从「项目结算 = 否」且未归入任何合同的已有项目中挑选 ----------
const add = reactive({ visible: false, loading: false, keyword: '' });
const candidates = ref<Project[]>([]);
const picked = ref<Project[]>([]);

const shownCandidates = computed(() => {
  const k = add.keyword.trim();
  const taken = new Set(pending.value.map((p) => p.id));
  const list = candidates.value.filter((p) => !taken.has(p.id));
  return k ? list.filter((p) => p.name.includes(k) || p.region.includes(k) || String(p.batchNo ?? '').includes(k)) : list;
});

async function openAdd() {
  add.visible = true;
  add.loading = true;
  add.keyword = '';
  picked.value = [];
  try {
    candidates.value = (await api.projects.list()).filter((p) => !p.contractId && !p.qxMoneyReceived);
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    add.loading = false;
  }
}

function confirmAdd() {
  if (picked.value.length === 0) return ElMessage.warning('请至少选择一个项目');
  for (const p of picked.value) {
    pending.value.push(p);
    prices[p.id] = fromCents(p.contractPrice); // 默认带入项目原有合同价，可再修改
  }
  add.visible = false;
}

/** 取消一个尚未保存的待加入项目 */
function dropPending(projectId: string) {
  pending.value = pending.value.filter((p) => p.id !== projectId);
  delete prices[projectId];
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
          <span class="hint">（共 {{ rows.length }} 个项目的合同价之和，修改下方合同价后自动变化）</span>
        </el-form-item>
        <el-form-item label="包含的项目">
          <div class="projects">
            <el-button icon="Plus" style="margin-bottom: 8px" @click="openAdd">添加项目</el-button>
            <el-table :data="rows" border style="width: 100%" empty-text="该合同下暂无项目">
              <el-table-column type="index" label="序号" width="60" />
              <el-table-column prop="batchNo" label="批次号" width="80" />
              <el-table-column prop="region" label="区域" width="80" />
              <el-table-column label="项目名称" min-width="240">
                <template #default="{ row }">
                  <a class="project-link" href="javascript:void(0)" @click.prevent="openProject(row.id)">{{ row.name }}</a>
                  <el-tag v-if="row.isNew" size="small" type="success" style="margin-left: 6px">待保存</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="合同价" width="230">
                <template #default="{ row }">
                  <el-tooltip :content="priceError(prices[row.id]) ?? ''" :disabled="priceValid(prices[row.id])" placement="top">
                    <el-input v-model="prices[row.id]" :class="{ invalid: !priceValid(prices[row.id]) }" placeholder="合同价（元）">
                      <template #prepend>¥</template>
                    </el-input>
                  </el-tooltip>
                  <div v-if="!priceValid(prices[row.id])" class="err">{{ priceError(prices[row.id]) }}</div>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="80" align="center">
                <template #default="{ row }">
                  <el-button v-if="row.isNew" link type="danger" @click="dropPending(row.id)">取消</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-form-item>
      </el-form>
    </el-card>

    <el-dialog v-model="add.visible" title="添加项目" width="760px" append-to-body :close-on-click-modal="false">
      <el-input
        v-model="add.keyword"
        clearable
        placeholder="按项目名称 / 区域 / 批次号筛选（仅显示项目结算为否、且未归入合同的项目）"
        style="margin-bottom: 8px"
      />
      <el-table
        v-loading="add.loading"
        :data="shownCandidates"
        border
        height="300"
        row-key="id"
        empty-text="没有可添加的项目：需「项目结算」为否且未归入合同"
        @selection-change="picked = $event"
      >
        <el-table-column type="selection" width="50" :reserve-selection="true" />
        <el-table-column prop="batchNo" label="批次号" width="80" />
        <el-table-column prop="region" label="区域" width="80" />
        <el-table-column prop="name" label="项目名称" min-width="220" show-overflow-tooltip />
        <el-table-column label="原合同价" width="130" align="right">
          <template #default="{ row }">{{ formatMoney(row.contractPrice) }}</template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="add.visible = false">取消</el-button>
        <el-button type="primary" :disabled="picked.length === 0" @click="confirmAdd">添加 {{ picked.length || '' }}</el-button>
      </template>
    </el-dialog>
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
.projects {
  width: 100%;
}
.err {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.3;
  color: var(--el-color-danger);
}
.invalid :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}
</style>
