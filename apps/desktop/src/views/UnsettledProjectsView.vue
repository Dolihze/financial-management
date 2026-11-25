<script setup lang="ts">
/**
 * 项目管理 → 未结算项目：总表。
 * 项目只有一张表（project），是否结算由「合同」字段是否有值区分：本表只展示没有合同的项目
 * （归入合同后即成为已结算项目，之后出现在已结算项目里）。
 * 字段：序号、区域、项目名称、合同价、企信实收、企信支付下家、陈沛、企信利润、操作（编辑/删除）。
 * 金额表单用「元」字符串编辑，提交时用 toCents 转整数分，不做浮点运算。
 */
import type { Project } from '@fm/shared';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '@/api';
import { DEFAULT_PAGE_SIZE, MIN_PAGE_SIZE, PAGE_SIZES } from '@/utils/pagination';
import { errorMessage, formatMoney, fromCents, toCents } from '@/utils/format';
import {
  calcFromContractPrice, CHEN_PEI_RATE, DEFAULT_RATES, QX_RECEIVED_RATE, loadRates, parseRate, rateToText, saveRates, SUBCONTRACT_MODES, type FormulaRates, type SubcontractMode
} from '@/utils/projectFormula';

const rows = ref<Project[]>([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    // 只取没有合同的项目
    rows.value = await api.projects.list({ settled: false });
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    loading.value = false;
  }
}

// ---------- 前端分页 ----------
const pageSize = ref(DEFAULT_PAGE_SIZE);
const currentPage = ref(1);
const pageRows = computed(() => rows.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
const rowIndex = (i: number) => (currentPage.value - 1) * pageSize.value + i + 1;

// ---------- 新增 / 编辑 ----------
interface FormState {
  region: string;
  name: string;
  contractPrice: string;
  qxReceived: string;
  qxSubcontractFee: string;
  chenPei: string;
  qxProfit: string;
}
const emptyForm = (): FormState => ({
  region: '',
  name: '',
  contractPrice: '0.00',
  qxReceived: '0.00',
  qxSubcontractFee: '0.00',
  chenPei: '0.00',
  qxProfit: '0.00'
});

const dlg = reactive({ visible: false, saving: false, editing: null as Project | null });
const form = reactive<FormState>(emptyForm());
const formRef = ref<FormInstance>();

/** 金额校验：非负，最多两位小数 */
const moneyRule = (label: string) => ({
  validator: (_r: unknown, v: string, cb: (e?: Error) => void) => {
    if (!/^\d+(\.\d{1,2})?$/.test(String(v ?? '').trim())) cb(new Error(`${label}请输入非负金额，最多两位小数`));
    else cb();
  },
  trigger: 'blur'
});
const rules: FormRules<FormState> = {
  name: [{ required: true, whitespace: true, message: '请输入项目名称', trigger: 'blur' }],
  // 合同价必填：不能为空（金额格式校验同其他金额）
  contractPrice: [{ required: true, whitespace: true, message: '请输入合同价', trigger: 'blur' }, moneyRule('合同价')],
  qxReceived: [moneyRule('企信实收')],
  qxSubcontractFee: [moneyRule('企信支付下家')],
  chenPei: [moneyRule('陈沛')],
  qxProfit: [moneyRule('企信利润')]
};

// ---------- 区域下拉：从已有区域中选择 ----------
const regionOptions = ref<string[]>([]);
/** 编辑时当前区域即使不在已有列表里（如已被归档的来源）也要能显示 */
const regionChoices = computed(() =>
  form.region && !regionOptions.value.includes(form.region) ? [...regionOptions.value, form.region] : regionOptions.value
);
async function loadRegions() {
  try {
    regionOptions.value = await api.projects.regions();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}

function openCreate() {
  dlg.editing = null;
  Object.assign(form, emptyForm());
  // 新建项目合同价必填：不预填 0.00，由用户输入
  form.contractPrice = '';
  dlg.visible = true; // 弹窗 destroy-on-close：每次打开表单都是全新挂载，校验提示不会残留
  loadRegions();
}
function openEdit(p: Project) {
  dlg.editing = p;
  loadRegions();
  Object.assign(form, {
    region: p.region,
    name: p.name,
    contractPrice: fromCents(p.contractPrice),
    qxReceived: fromCents(p.qxReceived),
    qxSubcontractFee: fromCents(p.qxSubcontractFee),
    chenPei: fromCents(p.chenPei),
    qxProfit: fromCents(p.qxProfit)
  });
  dlg.visible = true;
}

async function submit() {
  if (!formRef.value) return;
  try {
    await formRef.value.validate();
  } catch {
    return;
  }
  const body = {
    region: form.region.trim(),
    name: form.name.trim(),
    contractPrice: toCents(form.contractPrice.trim()),
    qxReceived: toCents(form.qxReceived.trim()),
    qxSubcontractFee: toCents(form.qxSubcontractFee.trim()),
    chenPei: toCents(form.chenPei.trim()),
    qxProfit: toCents(form.qxProfit.trim())
  };
  dlg.saving = true;
  try {
    if (dlg.editing) {
      // 上海院已支付（shPaid）省略 = 保持原值，不触发入账；表单不涉及的字段沿用原值
      await api.projects.update(dlg.editing.id, {
        ...body,
        paidSubcontractor: dlg.editing.paidSubcontractor,
        paidChenPei: dlg.editing.paidChenPei,
        note: dlg.editing.note
      });
      ElMessage.success('已保存');
    } else {
      // 新建的项目：不归属合同，所以出现在本表
      await api.projects.create(body);
      ElMessage.success('已新建项目');
    }
    dlg.visible = false;
    await load();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    dlg.saving = false;
  }
}

async function remove(p: Project) {
  try {
    await ElMessageBox.confirm(`确定删除「${p.name}」吗？`, '删除项目', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    });
  } catch {
    return; // 取消
  }
  try {
    await api.projects.archive(p.id);
    ElMessage.success('已删除');
    await load();
    if (pageRows.value.length === 0 && currentPage.value > 1) currentPage.value -= 1;
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}

// ---------- 公式计算（与已结算项目的编辑弹窗共用同一套公式与费率设置） ----------
const rates = ref<FormulaRates>(loadRates());
const formulaVisible = ref(false);
/** 弹窗里编辑中的费率文本（点「保存」才生效） */
const rateForm = reactive<{ mode: SubcontractMode; rate: string; custom: string }>({ mode: 'rate', rate: '', custom: '' });
const qxReceivedRateText = rateToText(QX_RECEIVED_RATE);
const chenPeiRateText = rateToText(CHEN_PEI_RATE);

function fillRateForm(r: FormulaRates) {
  rateForm.mode = r.subcontractMode;
  rateForm.rate = rateToText(r.subcontractRate);
  rateForm.custom = fromCents(r.subcontractCustom);
}
function openFormula() {
  fillRateForm(rates.value);
  formulaVisible.value = true;
}
function saveFormula() {
  const rate = parseRate(rateForm.rate);
  if (rate === null) {
    ElMessage.warning('费率请输入 0~1 之间的数，最多 4 位小数');
    return;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(rateForm.custom.trim())) {
    ElMessage.warning('自定义分包费请输入非负金额，最多两位小数');
    return;
  }
  rates.value = { subcontractMode: rateForm.mode, subcontractRate: rate, subcontractCustom: toCents(rateForm.custom.trim()) };
  saveRates(rates.value);
  formulaVisible.value = false;
  ElMessage.success('公式已保存');
}
function resetFormula() {
  fillRateForm(DEFAULT_RATES);
}
/** 按合同价和公式计算企信实收、企信支付下家、陈沛、企信利润 */
function calculate() {
  if (!/^\d+(\.\d{1,2})?$/.test(form.contractPrice.trim())) {
    ElMessage.warning('请先输入正确的合同价（非负，最多两位小数）');
    return;
  }
  const r = calcFromContractPrice(toCents(form.contractPrice.trim()), rates.value);
  form.qxReceived = fromCents(r.qxReceived);
  form.qxSubcontractFee = fromCents(r.qxSubcontractFee);
  form.chenPei = fromCents(r.chenPei);
  form.qxProfit = fromCents(r.qxProfit);
  ElMessage.success('已按公式计算，请确认后保存');
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-toolbar">
      <el-button type="primary" icon="Plus" @click="openCreate">新建项目</el-button>
    </div>

    <el-table v-loading="loading" :data="pageRows" border empty-text="暂无项目，点击「新建项目」添加">
      <el-table-column type="index" :index="rowIndex" label="序号" width="70" />
      <el-table-column prop="region" label="区域" min-width="110" show-overflow-tooltip />
      <el-table-column prop="name" label="项目名称" min-width="200" show-overflow-tooltip />
      <el-table-column label="合同价" width="140" align="right">
        <template #default="{ row }">{{ formatMoney(row.contractPrice) }}</template>
      </el-table-column>
      <el-table-column label="企信实收" width="140" align="right">
        <template #default="{ row }">{{ formatMoney(row.qxReceived) }}</template>
      </el-table-column>
      <el-table-column label="企信支付下家" width="180" align="right">
        <template #default="{ row }">{{ formatMoney(row.qxSubcontractFee) }}</template>
      </el-table-column>
      <el-table-column label="陈沛" width="130" align="right">
        <template #default="{ row }">{{ formatMoney(row.chenPei) }}</template>
      </el-table-column>
      <el-table-column label="企信利润" width="140" align="right">
        <template #default="{ row }">{{ formatMoney(row.qxProfit) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="130" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-if="rows.length > MIN_PAGE_SIZE"
      v-model:current-page="currentPage"
      v-model:page-size="pageSize"
      :page-sizes="PAGE_SIZES"
      :total="rows.length"
      layout="total, prev, pager, next, sizes"
      background
      @size-change="currentPage = 1"
      style="margin-top: 16px; justify-content: flex-end"
    />

    <el-dialog
      v-model="dlg.visible"
      :title="dlg.editing ? '编辑项目' : '新建项目'"
      width="620px"
      draggable
      destroy-on-close
      align-center
      :close-on-click-modal="false"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="190px" class="nowrap-label" @submit.prevent>
        <el-form-item label="区域" prop="region">
          <el-select v-model="form.region" class="money-input" filterable clearable placeholder="请从已有区域中选择">
            <el-option v-for="r in regionChoices" :key="r" :value="r" :label="r" />
          </el-select>
        </el-form-item>
        <el-form-item label="项目名称" prop="name">
          <el-input v-model="form.name" class="name-input" maxlength="200" />
        </el-form-item>
        <el-form-item label="合同价" prop="contractPrice">
          <el-input v-model="form.contractPrice" class="money-input"><template #prepend>¥</template></el-input>
          <div class="formula-bar">
            <el-button type="primary" plain size="small" icon="Cpu" @click="calculate">计算</el-button>
            <el-button link type="primary" size="small" icon="Setting" @click="openFormula">公式维护</el-button>
          </div>
        </el-form-item>
        <el-form-item label="企信实收" prop="qxReceived">
          <el-input v-model="form.qxReceived" class="money-input"><template #prepend>¥</template></el-input>
        </el-form-item>
        <el-form-item label="企信支付下家" prop="qxSubcontractFee">
          <el-input v-model="form.qxSubcontractFee" class="money-input"><template #prepend>¥</template></el-input>
        </el-form-item>
        <el-form-item label="陈沛" prop="chenPei">
          <el-input v-model="form.chenPei" class="money-input"><template #prepend>¥</template></el-input>
        </el-form-item>
        <el-form-item label="企信利润" prop="qxProfit">
          <el-input v-model="form.qxProfit" class="money-input"><template #prepend>¥</template></el-input>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg.visible = false">取消</el-button>
        <el-button type="primary" :loading="dlg.saving" @click="submit">保存</el-button>
      </template>

      <el-dialog v-model="formulaVisible" title="公式维护" width="640px" append-to-body draggable destroy-on-close align-center>
        <el-form label-width="190px" class="nowrap-label formula-form" @submit.prevent>
          <el-form-item label="企信实收">
            <span>= 合同价 × {{ qxReceivedRateText }}</span>
          </el-form-item>
          <el-form-item label="分包费计算方法">
            <el-select v-model="rateForm.mode" style="width: 160px">
              <el-option v-for="m in SUBCONTRACT_MODES" :key="m.value" :label="m.label" :value="m.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="企信支付下家">
            <template v-if="rateForm.mode === 'rate'">
              <span>= 企信实收 ×&nbsp;</span>
              <el-input v-model="rateForm.rate" style="width: 110px" placeholder="0.75" />
            </template>
            <el-input v-else v-model="rateForm.custom" style="width: 200px" placeholder="0.00"><template #prepend>¥</template></el-input>
          </el-form-item>
          <el-form-item label="陈沛">
            <span>= 企信实收 × {{ chenPeiRateText }}</span>
          </el-form-item>
          <el-form-item label="企信利润">
            <span>= 企信实收 − 企信支付下家 − 陈沛</span>
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="resetFormula">恢复默认</el-button>
          <el-button @click="formulaVisible = false">取消</el-button>
          <el-button type="primary" @click="saveFormula">保存</el-button>
        </template>
      </el-dialog>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 标签单行显示，不因拥挤换行（label-width 已按最长的「企信支付下家」留足） */
.nowrap-label :deep(.el-form-item__label) {
  white-space: nowrap;
}
/* 公式维护弹窗里「= 企信实收 × [输入框]」保持同一行；表单弹窗的内容区仍可换行（合同价下方的计算按钮要另起一行） */
.formula-form :deep(.el-form-item__content) {
  flex-wrap: nowrap;
  white-space: nowrap;
}
/* 区域、金额输入框固定宽度；项目名称右侧留白，不贴着弹窗右边 */
.money-input {
  width: 200px;
}
.name-input {
  width: calc(100% - 80px);
}
</style>
