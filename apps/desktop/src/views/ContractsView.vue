<script setup lang="ts">
import type { Batch, Contract, Project } from '@fm/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api';
import ProjectBreadcrumb from '@/components/ProjectBreadcrumb.vue';
import { contractPriceToCents, sumContractPrices, validateContractPrice } from '@/utils/contractPrice';
import { errorMessage, formatMoney, fromCents } from '@/utils/format';

/**
 * 项目管理第二层：某个批次下的合同。点击合同编号进入该合同的项目进度。
 * 批次由路由参数 batchId 决定；新增合同默认归属当前批次。
 */
const router = useRouter();
const route = useRoute();
const batchId = computed(() => route.params.batchId as string);
const batch = ref<Batch | null>(null);
const contracts = ref<Contract[]>([]);
const loading = ref(false);

const batchTitle = computed(() => (!batch.value ? '' : batch.value.batchNo === 0 ? '未分批' : `第 ${batch.value.batchNo} 批`));
const crumbs = computed(() => [{ label: '批次管理', to: { name: 'batches' } }, { label: batchTitle.value || '…' }]);

async function load() {
  loading.value = true;
  try {
    // 批次不存在（被删除/链接过期）时后端返回 404，提示后回到批次管理
    const [b, list] = await Promise.all([api.batches.get(batchId.value), api.contracts.list(batchId.value)]);
    batch.value = b;
    contracts.value = list;
  } catch (e) {
    ElMessage.error(errorMessage(e));
    router.replace({ name: 'batches' });
  } finally {
    loading.value = false;
  }
}

// 同一组件下切换批次（路由参数变化）时重新加载，并回到第一页
watch(batchId, () => {
  currentPage.value = 1;
  load();
});

// ---------- 前端分页 ----------
const PAGE_SIZE = 30;
const currentPage = ref(1);
const pageRows = computed(() => contracts.value.slice((currentPage.value - 1) * PAGE_SIZE, currentPage.value * PAGE_SIZE));
const rowIndex = (i: number) => (currentPage.value - 1) * PAGE_SIZE + i + 1;

// ---------- 跳转 ----------
/** 点合同编号：进入该合同的项目进度 */
function openProgress(c: Contract) {
  router.push({ name: 'projects', params: { batchId: batchId.value, contractId: c.id } });
}

/** 只有合同内部没有项目时才能删除（后端同样会校验）；编辑合同请先进入合同再点「编辑合同」 */
async function remove(c: Contract) {
  if (c.projectCount > 0) {
    return ElMessage.warning(`合同「${c.contractNo}」下还有 ${c.projectCount} 个项目，不能删除。请先进入合同，删除其下的项目后再删除合同`);
  }
  try {
    await ElMessageBox.confirm(`确定删除合同「${c.contractNo}」吗？`, '删除合同', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    });
  } catch {
    return; // 取消
  }
  try {
    await api.contracts.archive(c.id);
    ElMessage.success('已删除合同');
    await load();
    if (pageRows.value.length === 0 && currentPage.value > 1) currentPage.value -= 1;
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}

// ---------- 新增合同：从「项目结算 = 否」且尚未归入合同的项目中挑选，并给每个项目设置合同价 ----------
const dlg = reactive({ visible: false, saving: false, loading: false });
const contractNo = ref('');
const unsettled = ref<Project[]>([]);
const keyword = ref('');
const selectedIds = ref<string[]>([]);
/** 每个已选项目的合同价（元，字符串编辑；提交时转整数分） */
const prices = reactive<Record<string, string>>({});

const shown = computed(() => {
  const k = keyword.value.trim();
  return k ? unsettled.value.filter((p) => p.name.includes(k) || p.region.includes(k)) : unsettled.value;
});
const selectedProjects = computed(() => unsettled.value.filter((p) => selectedIds.value.includes(p.id)));

/** 合同总价 = 已选项目合同价之和（整数分求和）；任一价格不合法或总价越界时为 null */
const totalCents = computed<number | null>(() => sumContractPrices(selectedProjects.value.map((p) => prices[p.id])));

async function openCreate() {
  dlg.visible = true;
  dlg.loading = true;
  contractNo.value = '';
  keyword.value = '';
  selectedIds.value = [];
  for (const k of Object.keys(prices)) delete prices[k];
  try {
    unsettled.value = (await api.projects.list()).filter((p) => !p.contractId && !p.qxMoneyReceived);
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    dlg.loading = false;
  }
}

function onSelectionChange(rows: Project[]) {
  selectedIds.value = rows.map((r) => r.id);
  // 新选中的项目默认带入它原有的合同价，已填写的不覆盖
  for (const r of rows) if (!(r.id in prices)) prices[r.id] = fromCents(r.contractPrice);
}

async function submitCreate() {
  const no = contractNo.value.trim();
  if (!no) return ElMessage.warning('请输入合同编号');
  if (selectedProjects.value.length === 0) return ElMessage.warning('请至少选择一个项目');
  for (const p of selectedProjects.value) {
    const err = validateContractPrice(prices[p.id]);
    if (err) return ElMessage.warning(`「${p.name}」：${err}`);
  }
  if (totalCents.value === null) return ElMessage.warning('合同总价超出允许范围，请检查各项目合同价');
  dlg.saving = true;
  try {
    await api.contracts.create({
      batchId: batchId.value,
      contractNo: no,
      projects: selectedProjects.value.map((p) => ({ projectId: p.id, contractPrice: contractPriceToCents(prices[p.id]!) }))
    });
    ElMessage.success('合同已创建');
    dlg.visible = false;
    await load();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    dlg.saving = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <ProjectBreadcrumb :items="crumbs" />

    <div class="page-toolbar">
      <el-button type="primary" icon="Plus" @click="openCreate">新增合同</el-button>
      <span class="hint">点击合同编号进入该合同的项目进度</span>
    </div>

    <el-table v-loading="loading" :data="pageRows" border class="contract-table" empty-text="该批次下暂无合同，点击「新增合同」创建">
      <el-table-column type="index" :index="rowIndex" label="序号" width="70" />
      <el-table-column label="合同编号" min-width="200">
        <template #default="{ row }">
          <a class="contract-link" href="javascript:void(0)" title="查看该合同的项目进度" @click.prevent="openProgress(row)">{{ row.contractNo }}</a>
        </template>
      </el-table-column>
      <el-table-column prop="projectCount" label="项目数" width="90" align="right" />
      <el-table-column label="合同总价" width="180" align="right">
        <template #default="{ row }">{{ formatMoney(row.totalPrice) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-if="contracts.length > PAGE_SIZE"
      v-model:current-page="currentPage"
      :page-size="PAGE_SIZE"
      :total="contracts.length"
      layout="total, prev, pager, next"
      background
      style="margin-top: 16px; justify-content: flex-end"
    />

    <el-dialog v-model="dlg.visible" :title="`新增合同（归属${batchTitle}）`" width="860px" :close-on-click-modal="false">
      <el-form label-width="90px" @submit.prevent>
        <el-form-item label="合同编号" required>
          <el-input v-model="contractNo" maxlength="50" style="width: 320px" placeholder="如 HT-2026-001" />
        </el-form-item>
        <el-form-item label="选择项目">
          <div class="pick">
            <el-input v-model="keyword" clearable placeholder="按项目名称 / 区域筛选（仅显示项目结算为否、且未归入合同的项目）" style="margin-bottom: 8px" />
            <el-table
              v-loading="dlg.loading"
              :data="shown"
              border
              height="260"
              row-key="id"
              empty-text="没有可选的项目：需「项目结算」为否且未归入合同"
              @selection-change="onSelectionChange"
            >
              <el-table-column type="selection" width="50" :reserve-selection="true" />
              <el-table-column prop="region" label="区域" width="80" />
              <el-table-column prop="name" label="项目名称" min-width="220" show-overflow-tooltip />
              <el-table-column label="原合同价" width="120" align="right">
                <template #default="{ row }">{{ formatMoney(row.contractPrice) }}</template>
              </el-table-column>
            </el-table>
          </div>
        </el-form-item>
        <el-form-item v-if="selectedProjects.length" label="设置合同价">
          <div class="pick">
            <div v-for="p in selectedProjects" :key="p.id" class="price-row">
              <span class="price-name" :title="p.name">{{ p.name }}</span>
              <el-input
                v-model="prices[p.id]"
                class="price-input"
                :class="{ invalid: validateContractPrice(prices[p.id]) !== null }"
                placeholder="合同价（元）"
              >
                <template #prepend>¥</template>
              </el-input>
              <span v-if="validateContractPrice(prices[p.id])" class="err">{{ validateContractPrice(prices[p.id]) }}</span>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="合同总价">
          <b class="total">{{ totalCents === null ? '—' : formatMoney(totalCents) }}</b>
          <span class="hint">（已选 {{ selectedProjects.length }} 个项目的合同价之和）</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg.visible = false">取消</el-button>
        <el-button type="primary" :loading="dlg.saving" @click="submitCreate">创建合同</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.contract-link {
  color: var(--el-color-primary);
  cursor: pointer;
  text-decoration: none;
}
.contract-link:hover {
  color: var(--el-color-primary-light-3);
  text-decoration: underline;
}
.pick {
  width: 100%;
}
.price-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.price-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.price-input {
  width: 220px;
}
.err {
  font-size: 12px;
  color: var(--el-color-danger);
}
.invalid :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}
.total {
  font-size: 18px;
  color: #f56c6c;
}
.hint {
  margin-left: 12px;
  font-size: 14px;
  color: var(--el-text-color-secondary);
}
</style>
