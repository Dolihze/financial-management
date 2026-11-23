<script setup lang="ts">
import type { Account, Project, ProjectPostingKind } from '@fm/shared';
import { ElDatePicker, ElMessage, ElMessageBox, ElOption, ElSelect, type FormInstance, type FormRules } from 'element-plus';
import { computed, h, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api';
import YesNoRadio from '@/components/YesNoRadio.vue';
import { errorMessage, formatMoney, fromCents, toCents, today } from '@/utils/format';
import {
  calcFromContractPrice, CHEN_PEI_RATE, DEFAULT_RATES, QX_RECEIVED_RATE, loadRates, parseRate, rateToText, saveRates, SUBCONTRACT_MODES, type FormulaRates, type SubcontractMode
} from '@/utils/projectFormula';

const route = useRoute();
const router = useRouter();
const id = route.params.id as string;

const loading = ref(false);
const saving = ref(false);
const project = ref<Project | null>(null);
const formRef = ref<FormInstance>();

/**
 * 详情页可切换的「是/否」字段：对应入账方向、金额列（与后端 POSTING_RULES 一致）。
 * 「项目结算」（qxMoneyReceived，企信实收入账）不再在详情页提供，但它已入账时对应金额仍需锁定，所以仍保留在 FLAGS 里供 isPosted 使用。
 */
type FlagKey = 'qxMoneyReceived' | 'paidSubcontractor' | 'paidChenPei';
type ToggleKey = Exclude<FlagKey, 'qxMoneyReceived'>;
type AmountKey = 'qxReceived' | 'qxSubcontractFee' | 'chenPei';
const FLAGS: Record<FlagKey, { label: string; kind: ProjectPostingKind; direction: '收入' | '支出'; amount: AmountKey }> = {
  qxMoneyReceived: { label: '项目结算', kind: 'qx_received', direction: '收入', amount: 'qxReceived' },
  paidSubcontractor: { label: '支付下家', kind: 'paid_subcontractor', direction: '支出', amount: 'qxSubcontractFee' },
  paidChenPei: { label: '支付陈沛', kind: 'paid_chen_pei', direction: '支出', amount: 'chenPei' }
};

/** 该字段当前是否已入账（服务端有对应有效流水）：已入账时金额只读 */
const isPosted = (flag: FlagKey) => project.value?.postedKinds.includes(FLAGS[flag].kind) ?? false;

const accounts = ref<Account[]>([]);
const accountId = ref<string>('');
/** 入账日期（YYYY-MM-DD）：每次打开「切换为是」的弹窗都重置为今天，本次保存里的入账共用 */
const postingDate = ref<string>(today());

/** 表单里金额用「元」的字符串编辑，提交时用 toCents 转整数分，不做浮点运算 */
interface FormState {
  batchNo: number | null;
  region: string;
  name: string;
  contractPrice: string;
  qxReceived: string;
  qxSubcontractFee: string;
  chenPei: string;
  qxProfit: string;
  paidSubcontractor: boolean;
  paidChenPei: boolean;
  note: string;
}
const form = reactive<FormState>(emptyForm());

function emptyForm(): FormState {
  return {
    batchNo: null, region: '', name: '',
    contractPrice: '0.00', qxReceived: '0.00', qxSubcontractFee: '0.00', chenPei: '0.00', qxProfit: '0.00',
    paidSubcontractor: false, paidChenPei: false, note: ''
  };
}

function fillForm(p: Project) {
  Object.assign(form, {
    batchNo: p.batchNo, region: p.region, name: p.name,
    contractPrice: fromCents(p.contractPrice), qxReceived: fromCents(p.qxReceived),
    qxSubcontractFee: fromCents(p.qxSubcontractFee), chenPei: fromCents(p.chenPei), qxProfit: fromCents(p.qxProfit),
    paidSubcontractor: p.paidSubcontractor, paidChenPei: p.paidChenPei, note: p.note
  });
}

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
  contractPrice: [moneyRule('合同价')],
  qxReceived: [moneyRule('企信实收')],
  qxSubcontractFee: [moneyRule('企信支付下家分包费')],
  chenPei: [moneyRule('陈沛')],
  qxProfit: [moneyRule('企信利润')]
};

/** 与服务端当前数据比较，判断是否有未保存的修改 */
const dirty = computed(() => {
  const p = project.value;
  if (!p) return false;
  const cents = (s: string) => {
    try { return toCents(s || '0'); } catch { return NaN; }
  };
  return (
    form.batchNo !== p.batchNo || form.region !== p.region || form.name !== p.name ||
    cents(form.contractPrice) !== p.contractPrice || cents(form.qxReceived) !== p.qxReceived ||
    cents(form.qxSubcontractFee) !== p.qxSubcontractFee || cents(form.chenPei) !== p.chenPei || cents(form.qxProfit) !== p.qxProfit ||
    form.paidSubcontractor !== p.paidSubcontractor || form.paidChenPei !== p.paidChenPei ||
    form.note.trim() !== p.note
  );
});

/**
 * 切换 是/否 时的二次确认：
 * - 切到「是」：提示会入账（生成一笔流水），并让用户选择入账账户（账户必填）；
 * - 切到「否」：若该字段已入账，提示会从账单中回退（对应流水作废）；
 *   若只是历史标记（无流水，如 Excel 导入的「是」），提示只修改标记、不影响账务。
 * 这里只确认并改表单，真正的入账/回退在点「保存」时由后端在同一事务里完成。
 */
async function confirmFlag(flag: ToggleKey, next: boolean): Promise<boolean> {
  const meta = FLAGS[flag];
  const amountText = formatMoney(toCentsSafe(form[meta.amount]));
  try {
    if (next) {
      // 之前已选过账户就默认带上，减少重复操作
      if (!accountId.value && accounts.value.length === 1) accountId.value = accounts.value[0]!.id;
      postingDate.value = today(); // 日期默认当天，不沿用上次选的日期，避免误入账到旧日期
      await ElMessageBox({
        title: `确认切换「${meta.label}」为「是」？`,
        showCancelButton: true,
        confirmButtonText: '确认切换',
        cancelButtonText: '取消',
        type: 'warning',
        message: () =>
          h('div', null, [
            h('p', { style: 'margin:0 0 8px' }, `切换为「是」并保存后，会入账一笔${meta.direction}：${amountText}。请确认不是误操作。`),
            h('div', { style: 'display:flex;align-items:center;gap:8px' }, [
              h('span', null, '入账账户：'),
              h(
                ElSelect,
                {
                  modelValue: accountId.value,
                  'onUpdate:modelValue': (v: string) => (accountId.value = v),
                  placeholder: '请选择账户',
                  style: 'width:260px'
                },
                () => accounts.value.map((a) => h(ElOption, { key: a.id, value: a.id, label: `${a.name}（余额 ${formatMoney(a.balance)}）` }))
              )
            ]),
            h('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:8px' }, [
              h('span', null, '入账日期：'),
              h(ElDatePicker, {
                modelValue: postingDate.value,
                'onUpdate:modelValue': (v: string | null) => (postingDate.value = v ?? ''),
                type: 'date',
                valueFormat: 'YYYY-MM-DD',
                format: 'YYYY-MM-DD',
                clearable: false,
                placeholder: '请选择日期',
                style: 'width:260px'
              })
            ])
          ]),
        beforeClose: (action, _inst, done) => {
          if (action === 'confirm' && !accountId.value) {
            ElMessage.warning('请选择入账账户');
            return; // 不关闭弹窗
          }
          if (action === 'confirm' && !/^\d{4}-\d{2}-\d{2}$/.test(postingDate.value)) {
            ElMessage.warning('请选择入账日期');
            return;
          }
          done();
        }
      });
    } else if (isPosted(flag)) {
      await ElMessageBox.confirm(
        `切换为「否」并保存后，之前入账的这笔${meta.direction}（${amountText}）会从账单中回退（对应流水作废，账户余额随之恢复）。请确认不是误操作。`,
        `确认切换「${meta.label}」为「否」？`,
        { type: 'warning', confirmButtonText: '确认切换', cancelButtonText: '取消' }
      );
    } else {
      await ElMessageBox.confirm(
        `「${meta.label}」目前只是一个标记（没有对应的入账流水），切换为「否」只会修改标记，不影响账务。`,
        `确认切换「${meta.label}」为「否」？`,
        { type: 'info', confirmButtonText: '确认切换', cancelButtonText: '取消' }
      );
    }
    return true;
  } catch {
    return false; // 用户取消：保持原值
  }
}

function toCentsSafe(s: string): number {
  try {
    return toCents(s || '0');
  } catch {
    return 0;
  }
}

/** 本次保存中，哪些字段是从否切到是（需要入账） */
const newlyPosted = computed(() => {
  const p = project.value;
  if (!p) return [] as ToggleKey[];
  return (['paidSubcontractor', 'paidChenPei'] as ToggleKey[]).filter((k) => form[k] && !p[k]);
});
/**
 * 「支付下家 / 支付陈沛」两项只对已结算的项目有意义：未结算项目（未归入合同、且项目结算为否）隐藏。
 * 例外：只要任意一项已勾选或已入账，就照常显示，避免把已有的数据藏起来。
 * 隐藏只影响界面；表单状态与提交值保持不变，所以保存不会改变这两项（也不会误回退已入账的流水）。
 */
const showPaidFlags = computed(() => {
  const p = project.value;
  if (!p) return false;
  const unsettled = !p.contractId && !p.qxMoneyReceived;
  if (!unsettled) return true;
  return p.paidSubcontractor || p.paidChenPei || isPosted('paidSubcontractor') || isPosted('paidChenPei');
});

async function load() {
  loading.value = true;
  try {
    const [p, accs] = await Promise.all([api.projects.get(id), api.accounts.list()]);
    project.value = p;
    accounts.value = accs;
    fillForm(p);
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!(await formRef.value?.validate().catch(() => false))) return;
  if (newlyPosted.value.length > 0 && !accountId.value) {
    ElMessage.warning('切换为「是」需要入账，请重新切换并选择入账账户');
    return;
  }
  const before = project.value?.postedKinds ?? [];
  saving.value = true;
  try {
    project.value = await api.projects.update(id, {
      batchNo: form.batchNo,
      region: form.region.trim(),
      name: form.name.trim(),
      contractPrice: toCents(form.contractPrice),
      qxReceived: toCents(form.qxReceived),
      qxSubcontractFee: toCents(form.qxSubcontractFee),
      chenPei: toCents(form.chenPei),
      qxProfit: toCents(form.qxProfit),
      paidSubcontractor: form.paidSubcontractor,
      paidChenPei: form.paidChenPei,
      note: form.note.trim(),
      // 只有本次有字段从否切到是（需要入账）时才带账户
      ...(newlyPosted.value.length > 0 ? { postingAccountId: accountId.value, postingDate: postingDate.value } : {})
    });
    fillForm(project.value);
    // 入账/回退会改变账户余额，刷新账户列表供下次选择
    accounts.value = await api.accounts.list();
    const after = project.value.postedKinds;
    const posted = after.filter((k) => !before.includes(k));
    const reverted = before.filter((k) => !after.includes(k));
    const notes: string[] = [];
    if (posted.length) notes.push(`已入账 ${posted.length} 笔`);
    if (reverted.length) notes.push(`已回退 ${reverted.length} 笔`);
    ElMessage.success(notes.length ? `已保存，${notes.join('，')}` : '已保存');
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    saving.value = false;
  }
}

function reset() {
  if (project.value) fillForm(project.value);
  formRef.value?.clearValidate();
}

async function remove() {
  try {
    await ElMessageBox.confirm(
      `确认删除项目「${project.value?.name ?? ''}」？删除后将不再显示在项目列表中。`,
      '删除项目',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
    );
  } catch {
    return; // 用户取消
  }
  try {
    await api.projects.archive(id);
    ElMessage.success('已删除');
    router.replace({ name: 'projects' });
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}

async function back() {
  if (dirty.value) {
    try {
      await ElMessageBox.confirm('有未保存的修改，确认离开？', '提示', { type: 'warning', confirmButtonText: '离开', cancelButtonText: '继续编辑' });
    } catch {
      return;
    }
  }
  router.push({ name: 'projects' });
}

// ---------- 公式计算 ----------
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
  rates.value = { subcontractMode: rateForm.mode, subcontractRate: rate, subcontractCustom: toCents(rateForm.custom) };
  saveRates(rates.value);
  formulaVisible.value = false;
  ElMessage.success('公式已保存');
}

function resetFormula() {
  fillRateForm(DEFAULT_RATES);
}
/** 按合同价和公式计算四个金额；已入账的字段金额锁定，跳过 */
function calculate() {
  let price: number;
  try {
    if (!/^\d+(\.\d{1,2})?$/.test(form.contractPrice.trim())) throw new Error();
    price = toCents(form.contractPrice);
  } catch {
    ElMessage.warning('请先输入正确的合同价（非负，最多两位小数）');
    return;
  }
  const r = calcFromContractPrice(price, rates.value);
  const skipped: string[] = [];
  const apply = (flag: FlagKey, value: number) => {
    if (isPosted(flag)) skipped.push(FLAGS[flag].label);
    else form[FLAGS[flag].amount] = fromCents(value);
  };
  apply('qxMoneyReceived', r.qxReceived);
  apply('paidSubcontractor', r.qxSubcontractFee);
  apply('paidChenPei', r.chenPei);
  form.qxProfit = fromCents(r.qxProfit);
  if (skipped.length) {
    ElMessage.warning(`已计算；${skipped.join('、')}对应金额已入账，未改动（企信利润按新公式值更新，请留意是否一致）`);
  } else {
    ElMessage.success('已按公式计算，请确认后保存');
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <div class="page-toolbar">
      <el-button icon="Back" @click="back">返回项目列表</el-button>
      <span class="spacer" />
      <el-button type="danger" plain icon="Delete" :disabled="!project" @click="remove">删除</el-button>
      <el-button :disabled="!project || !dirty" @click="reset">重置</el-button>
      <el-button type="primary" icon="Check" :loading="saving" :disabled="!project || !dirty" @click="save">保存</el-button>
    </div>

    <el-card v-if="project" shadow="never">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="150px" style="max-width: 760px" @submit.prevent>
        <el-form-item label="合同编号">
          <el-input :model-value="project.contractNo || '（未归入合同）'" disabled />
          <div class="form-hint">合同归属请在「合同管理」中维护</div>
        </el-form-item>
        <el-form-item label="批次号" prop="batchNo">
          <el-input-number v-model="form.batchNo" :min="0" :step="1" :precision="0" controls-position="right" placeholder="如 15" />
        </el-form-item>
        <el-form-item label="区域" prop="region">
          <el-input v-model="form.region" maxlength="50" />
        </el-form-item>
        <el-form-item label="项目名称" prop="name">
          <el-input v-model="form.name" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" maxlength="100" />
          <el-text type="info" size="small">
            项目名称是 Excel 导入时匹配项目的依据；手工修改的内容会在再次导入同名项目时被 Excel 的值覆盖。
          </el-text>
        </el-form-item>
        <el-form-item label="合同价" prop="contractPrice">
          <el-input v-model="form.contractPrice" class="money-input"><template #prepend>¥</template></el-input>
          <div class="formula-bar">
            <el-button type="primary" plain size="small" icon="Cpu" @click="calculate">计算</el-button>
            <el-button link type="primary" size="small" icon="Setting" @click="openFormula">公式维护</el-button>
          </div>
        </el-form-item>
        <el-form-item label="企信实收" prop="qxReceived">
          <el-input v-model="form.qxReceived" class="money-input" :disabled="isPosted('qxMoneyReceived')"><template #prepend>¥</template></el-input>
          <el-text v-if="isPosted('qxMoneyReceived')" type="warning" size="small">
            该金额已入账（有对应的收入流水），不能在这里修改
          </el-text>
        </el-form-item>
        <el-form-item label="企信支付下家分包费" prop="qxSubcontractFee">
          <el-input v-model="form.qxSubcontractFee" class="money-input" :disabled="isPosted('paidSubcontractor')"><template #prepend>¥</template></el-input>
          <el-text v-if="isPosted('paidSubcontractor')" type="warning" size="small">
            已入账，如需修改金额请先将「支付下家」切换为「否」回退入账
          </el-text>
        </el-form-item>
        <el-form-item label="陈沛" prop="chenPei">
          <el-input v-model="form.chenPei" class="money-input" :disabled="isPosted('paidChenPei')"><template #prepend>¥</template></el-input>
          <el-text v-if="isPosted('paidChenPei')" type="warning" size="small">
            已入账，如需修改金额请先将「支付陈沛」切换为「否」回退入账
          </el-text>
        </el-form-item>
        <el-form-item label="企信利润" prop="qxProfit">
          <el-input v-model="form.qxProfit" class="money-input"><template #prepend>¥</template></el-input>
        </el-form-item>
        <el-form-item v-if="showPaidFlags" label="支付下家">
          <YesNoRadio v-model="form.paidSubcontractor" :confirm="(n) => confirmFlag('paidSubcontractor', n)" />
        </el-form-item>
        <el-form-item v-if="showPaidFlags" label="支付陈沛">
          <YesNoRadio v-model="form.paidChenPei" :confirm="(n) => confirmFlag('paidChenPei', n)" />
        </el-form-item>
        <el-form-item label="备注" prop="note">
          <el-input v-model="form.note" type="textarea" :rows="3" maxlength="500" show-word-limit />
        </el-form-item>
      </el-form>
    </el-card>
    <el-dialog v-model="formulaVisible" title="公式维护" width="520px" append-to-body>
      <el-form label-width="150px" @submit.prevent>
        <el-form-item label="企信实收">
          <span>= 合同价 × {{ qxReceivedRateText }}</span>
        </el-form-item>
        <el-form-item label="分包费计算方法">
          <el-select v-model="rateForm.mode" style="width: 160px">
            <el-option v-for="m in SUBCONTRACT_MODES" :key="m.value" :label="m.label" :value="m.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="企信支付下家分包费">
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
          <span>= 企信实收 − 企信支付下家分包费 − 陈沛</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="resetFormula">恢复默认</el-button>
        <el-button @click="formulaVisible = false">取消</el-button>
        <el-button type="primary" @click="saveFormula">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 金额输入框：宽度约为原来的 1/3 */
.money-input {
  width: 200px;
}
.form-hint {
  width: 100%;
  margin-top: 4px;
  font-size: 14px;
  line-height: 1.4;
  color: var(--el-text-color-secondary);
}
</style>
