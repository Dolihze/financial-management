<script setup lang="ts">
import type { Account, Contract, Project, ProjectPostingKind } from '@fm/shared';
import { ElDatePicker, ElMessage, ElMessageBox, ElOption, ElSelect, type FormInstance, type FormRules } from 'element-plus';
import { computed, h, reactive, ref, watch } from 'vue';
import { api } from '@/api';
import YesNoRadio from '@/components/YesNoRadio.vue';
import { errorMessage, formatMoney, fromCents, toCents, today } from '@/utils/format';
import {
  calcFromContractPrice, CHEN_PEI_RATE, DEFAULT_RATES, QX_RECEIVED_RATE, loadRates, parseRate, rateToText, saveRates, SUBCONTRACT_MODES, type FormulaRates, type SubcontractMode
} from '@/utils/projectFormula';

/**
 * 编辑项目（弹窗）：原「项目详情」页的全部功能，搬进弹窗。
 * 保存成功后触发 saved，由父页面刷新列表（删除项目在项目进度表的操作列里）。
 */
const props = defineProps<{ modelValue: boolean; projectId: string }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void; (e: 'saved'): void }>();
const visible = computed({ get: () => props.modelValue, set: (v) => emit('update:modelValue', v) });
const id = computed(() => props.projectId);

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
/** 可选的合同（下拉）与已有区域（下拉）；批次号随所选合同显示，不单独编辑 */
const contracts = ref<Contract[]>([]);
const regionOptions = ref<string[]>([]);
const accountId = ref<string>('');
/** 入账日期（YYYY-MM-DD）：每次打开「切换为是」的弹窗都重置为今天，本次保存里的入账共用 */
const postingDate = ref<string>(today());

/** 表单里金额用「元」的字符串编辑，提交时用 toCents 转整数分，不做浮点运算 */
interface FormState {
  contractId: string;
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
    contractId: '', region: '', name: '',
    contractPrice: '0.00', qxReceived: '0.00', qxSubcontractFee: '0.00', chenPei: '0.00', qxProfit: '0.00',
    paidSubcontractor: false, paidChenPei: false, note: ''
  };
}

function fillForm(p: Project) {
  Object.assign(form, {
    contractId: p.contractId ?? '', region: p.region, name: p.name,
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
  qxSubcontractFee: [moneyRule('企信支付下家')],
  chenPei: [moneyRule('陈沛')],
  qxProfit: [moneyRule('企信利润')]
};

/** 合同下拉选项：确保项目当前合同一定在列表里（即使列表加载不全也能正常显示） */
const contractOptions = computed(() => {
  const p = project.value;
  if (p?.contractId && !contracts.value.some((c) => c.id === p.contractId)) {
    return [...contracts.value, { id: p.contractId, contractNo: p.contractNo } as Contract];
  }
  return contracts.value;
});
/** 区域下拉选项：已有区域 + 当前输入值（新输入的区域也要能显示） */
const regionChoices = computed(() =>
  form.region && !regionOptions.value.includes(form.region) ? [...regionOptions.value, form.region] : regionOptions.value
);
/** 批次号只读，随当前所选合同显示（0 号「未分批」兜底批次显示为未分批） */
const batchText = computed(() => {
  const c = contracts.value.find((x) => x.id === form.contractId);
  if (!c) return project.value?.batchNo === null || project.value?.batchNo === undefined ? '（未分批）' : `第 ${project.value.batchNo} 批`;
  return c.batchNo === 0 ? '（未分批）' : `第 ${c.batchNo} 批`;
});

/** 与服务端当前数据比较，判断是否有未保存的修改 */
const dirty = computed(() => {
  const p = project.value;
  if (!p) return false;
  const cents = (s: string) => {
    try { return toCents(s || '0'); } catch { return NaN; }
  };
  return (
    form.contractId !== (p.contractId ?? '') || form.region !== p.region || form.name !== p.name ||
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
      // 支出方向叫「出账」账户/日期，收入方向叫「入账」
      const verb = meta.direction === '支出' ? '出账' : '入账';
      await ElMessageBox({
        title: `确认切换「${meta.label}」为「是」？`,
        showCancelButton: true,
        draggable: true,
        confirmButtonText: '确认切换',
        cancelButtonText: '取消',
        type: 'warning',
        message: () =>
          h('div', null, [
            h('p', { style: 'margin:0 0 8px' }, `切换为「是」并保存后，会产生一笔${meta.direction}：${amountText}。请确认不是误操作。`),
            h('div', { style: 'display:flex;align-items:center;gap:8px' }, [
              h('span', null, `${verb}账户：`),
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
              h('span', null, `${verb}日期：`),
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
            ElMessage.warning(`请选择${verb}账户`);
            return; // 不关闭弹窗
          }
          if (action === 'confirm' && !/^\d{4}-\d{2}-\d{2}$/.test(postingDate.value)) {
            ElMessage.warning(`请选择${verb}日期`);
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
  project.value = null;
  accountId.value = '';
  try {
    const [p, accs, cons, regions] = await Promise.all([
      api.projects.get(id.value), api.accounts.list(), api.contracts.list(), api.projects.regions()
    ]);
    project.value = p;
    accounts.value = accs;
    contracts.value = cons;
    regionOptions.value = regions;
    fillForm(p);
    formRef.value?.clearValidate();
  } catch (e) {
    ElMessage.error(errorMessage(e));
    visible.value = false; // 项目不存在（已被删除等）：关掉弹窗，不留一个空弹窗
  } finally {
    loading.value = false;
  }
}

// 每次打开都重新拉取最新数据，避免带着上次未保存的残留
watch(
  () => props.modelValue,
  (open) => {
    if (open) load();
  }
);

async function save() {
  if (!(await formRef.value?.validate().catch(() => false))) return;
  if (newlyPosted.value.length > 0 && !accountId.value) {
    ElMessage.warning('切换为「是」需要出账，请重新切换并选择出账账户');
    return;
  }
  const before = project.value?.postedKinds ?? [];
  saving.value = true;
  try {
    project.value = await api.projects.update(id.value, {
      // 未归入合同的项目不能在这里选合同（下拉禁用），所以不带 contractId
      ...(form.contractId ? { contractId: form.contractId } : {}),
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
    regionOptions.value = await api.projects.regions();
    const after = project.value.postedKinds;
    const posted = after.filter((k) => !before.includes(k));
    const reverted = before.filter((k) => !after.includes(k));
    const notes: string[] = [];
    if (posted.length) notes.push(`已入账 ${posted.length} 笔`);
    if (reverted.length) notes.push(`已回退 ${reverted.length} 笔`);
    ElMessage.success(notes.length ? `已保存，${notes.join('，')}` : '已保存');
    visible.value = false;
    emit('saved');
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    saving.value = false;
  }
}

/** 关闭前确认：有未保存的修改时提示（点遮罩/右上角叉/取消都会走这里） */
async function beforeClose(done: () => void) {
  if (dirty.value) {
    try {
      await ElMessageBox.confirm('有未保存的修改，确定放弃吗？', '提示', { type: 'warning', confirmButtonText: '放弃', cancelButtonText: '继续编辑' });
    } catch {
      return;
    }
  }
  done();
}
const cancel = () => beforeClose(() => (visible.value = false));

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
</script>

<template>
  <el-dialog
    v-model="visible"
    title="编辑项目"
    width="820px"
    draggable
    destroy-on-close
    align-center
    :close-on-click-modal="false"
    :before-close="beforeClose"
  >
    <div v-loading="loading" class="body">
      <el-form v-if="project" ref="formRef" :model="form" :rules="rules" label-width="190px" class="project-form" @submit.prevent>
        <el-form-item label="合同编号">
          <el-select
            v-model="form.contractId"
            class="short-input"
            filterable
            placeholder="（未归入合同）"
            :disabled="!project.contractId"
          >
            <el-option v-for="c in contractOptions" :key="c.id" :value="c.id" :label="c.contractNo" />
          </el-select>
        </el-form-item>
        <el-form-item label="批次号">
          <el-input class="short-input" :model-value="batchText" disabled />
        </el-form-item>
        <el-form-item label="区域" prop="region">
          <el-select
            v-model="form.region"
            class="short-input"
            filterable
            allow-create
            default-first-option
            clearable
            placeholder="请选择或输入区域"
          >
            <el-option v-for="r in regionChoices" :key="r" :value="r" :label="r" />
          </el-select>
        </el-form-item>
        <el-form-item label="项目名称" prop="name">
          <el-input v-model="form.name" class="name-input" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" maxlength="100" />
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
        <el-form-item label="企信支付下家" prop="qxSubcontractFee">
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
    </div>
    <template #footer>
      <el-button @click="cancel">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!project || !dirty" @click="save">确定</el-button>
    </template>

    <el-dialog v-model="formulaVisible" title="公式维护" width="520px" append-to-body draggable destroy-on-close align-center>
      <el-form label-width="150px" @submit.prevent>
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
</template>

<style scoped>
/* 表单较长时在弹窗内部滚动，页脚按钮始终可见 */
.body {
  max-height: 68vh;
  min-height: 120px;
  overflow-y: auto;
  padding-right: 8px;
}
/* 金额输入框：宽度约为原来的 1/3 */
.money-input {
  width: 200px;
}
/* 合同编号 / 批次号 / 区域：宽度约为原来的 1/3 */
.short-input {
  width: 200px;
}
/* 项目名称：右侧留出空白，不贴着弹窗右边 */
.name-input {
  width: calc(100% - 80px);
}
/* 标签单行显示，不因拥挤换行（label-width 已按最长的「企信支付下家」留足） */
.project-form :deep(.el-form-item__label) {
  white-space: nowrap;
}
</style>
