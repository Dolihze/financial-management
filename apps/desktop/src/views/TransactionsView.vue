<script setup lang="ts">
import {
  TRANSACTION_TYPES,
  TRANSACTION_TYPE_IS_INFLOW,
  TRANSACTION_TYPE_LABELS,
  type Category,
  type Transaction,
  type TransactionType
} from '@fm/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '@/api';
import NameManagerDialog from '@/components/NameManagerDialog.vue';
import { useBaseStore } from '@/stores/base';
import { errorMessage, formatMoney, toCents, today } from '@/utils/format';

const base = useBaseStore();

const filter = reactive({
  accountId: '' as string,
  type: '' as TransactionType | '',
  categoryId: '' as string,
  counterpartyId: '' as string,
  range: null as [string, string] | null,
  includeVoided: false
});
const page = reactive({ current: 1, size: 20, total: 0 });
const items = ref<Transaction[]>([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    const res = await api.transactions.list({
      accountId: filter.accountId || undefined,
      type: filter.type || undefined,
      categoryId: filter.categoryId || undefined,
      counterpartyId: filter.counterpartyId || undefined,
      from: filter.range?.[0],
      to: filter.range?.[1],
      includeVoided: filter.includeVoided,
      limit: page.size,
      offset: (page.current - 1) * page.size
    });
    items.value = res.items;
    page.total = res.total;
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    loading.value = false;
  }
}

/** 分类筛选只在类型为收入/支出时显示，并只列出对应类型的分类；其余类型（全部/借款/贷款）不显示 */
const filterCategories = computed(() =>
  filter.type === 'income' ? base.incomeCategories : filter.type === 'expense' ? base.expenseCategories : null
);

function onTypeChange() {
  // 分类筛选被隐藏或换了类型后，已选分类不再适用，必须清空，避免带着看不见的筛选条件
  if (!filterCategories.value?.some((c) => c.id === filter.categoryId)) filter.categoryId = '';
  search();
}
function search() {
  page.current = 1;
  load();
}

// ---- 新增 ----
const dialog = ref(false);
const form = reactive({
  type: 'expense' as TransactionType,
  occurredOn: today(),
  amount: '',
  accountId: '',
  categoryId: '' as string,
  counterpartyId: '' as string,
  note: ''
});
/** 借款/贷款不使用收支分类 */
const hasCategory = computed(() => form.type === 'income' || form.type === 'expense');
const categoryOptions = computed(() =>
  form.type === 'income' ? base.incomeCategories : form.type === 'expense' ? base.expenseCategories : []
);
const accountLabel = computed(() => (TRANSACTION_TYPE_IS_INFLOW[form.type] ? '入账账户' : '出账账户'));

function openDialog() {
  Object.assign(form, { type: 'expense', occurredOn: today(), amount: '', accountId: '', categoryId: '', counterpartyId: '', note: '' });
  dialog.value = true;
}

// ---- 管理收入/支出分类 / 往来单位（二级弹窗，复用 NameManagerDialog） ----
/** 分类管理弹窗当前针对的类型：随打开时的记账类型（收入/支出）确定 */
const catKind = ref<'income' | 'expense'>('income');
const catDialog = ref(false);
const cpDialog = ref(false);

async function createCategory(name: string) {
  const created = await api.categories.create({ name, kind: catKind.value });
  await base.loadCategories();
  form.categoryId = created.id; // 新增后直接选中，方便继续记账
}
async function renameCategory(id: string, name: string) {
  await api.categories.update(id, { name });
  await Promise.all([base.loadCategories(), load()]); // 列表中的分类名同步刷新
}
async function removeCategory(id: string) {
  await api.categories.remove(id);
  if (form.categoryId === id) form.categoryId = ''; // 当前表单已选中的分类被删除
  await Promise.all([base.loadCategories(), load()]);
}
const managedCategories = computed(() => (catKind.value === 'income' ? base.incomeCategories : base.expenseCategories));
const categoryUsedHint = () => `这些流水将改为「${catKind.value === 'income' ? '其他收入' : '其他支出'}」`;
function openCategoryManager() {
  catKind.value = form.type === 'expense' ? 'expense' : 'income';
  catDialog.value = true;
}

async function createCounterparty(name: string) {
  const created = await api.counterparties.create({ name });
  await base.loadCounterparties();
  form.counterpartyId = created.id;
}
async function renameCounterparty(id: string, name: string) {
  await api.counterparties.update(id, { name });
  await Promise.all([base.loadCounterparties(), load()]);
}
async function removeCounterparty(id: string) {
  await api.counterparties.remove(id);
  if (form.counterpartyId === id) form.counterpartyId = '';
  await Promise.all([base.loadCounterparties(), load()]);
}
const counterpartyUsedHint = () => '这些流水将不再关联该往来单位（流水上已记录的名称仍会保留显示）';
async function submit() {
  try {
    await api.transactions.create({
      type: form.type,
      occurredOn: form.occurredOn,
      amount: toCents(form.amount),
      accountId: form.accountId,
      categoryId: hasCategory.value ? form.categoryId || null : null,
      counterpartyId: form.counterpartyId || null,
      note: form.note
    });
    dialog.value = false;
    ElMessage.success('已记账');
    await Promise.all([load(), base.loadAccounts()]);
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}

async function voidTx(tx: Transaction) {
  try {
    const { value } = await ElMessageBox.prompt('作废后该笔不再计入余额，但记录会保留以供审计。请填写原因：', '作废交易', {
      inputPlaceholder: '作废原因'
    });
    await api.transactions.void(tx.id, value);
    ElMessage.success('已作废');
    await Promise.all([load(), base.loadAccounts()]);
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(errorMessage(e));
  }
}

/** 展示"钱从哪来/到哪去" */
function flowText(tx: Transaction): string {
  return tx.lines[0]?.accountName ?? '';
}
function amountOf(tx: Transaction): number {
  return tx.lines[0]?.amount ?? 0;
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-toolbar">
      <el-button type="primary" icon="Plus" @click="openDialog">记一笔</el-button>
      <el-select v-model="filter.accountId" placeholder="全部账户" clearable style="width: 180px" @change="search">
        <el-option v-for="a in base.accounts" :key="a.id" :label="a.name" :value="a.id" />
      </el-select>
      <el-select v-model="filter.type" placeholder="全部类型" clearable style="width: 120px" @change="onTypeChange">
        <el-option v-for="t in TRANSACTION_TYPES" :key="t" :label="TRANSACTION_TYPE_LABELS[t]" :value="t" />
      </el-select>
      <el-select v-if="filterCategories" v-model="filter.categoryId" placeholder="全部分类" clearable filterable style="width: 130px" @change="search">
        <el-option v-for="c in filterCategories" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-select v-model="filter.counterpartyId" placeholder="全部往来单位" clearable filterable style="width: 150px" @change="search">
        <el-option v-for="c in base.counterparties" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-date-picker
        v-model="filter.range"
        type="daterange"
        unlink-panels
        value-format="YYYY-MM-DD"
        range-separator="~"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        style="width: 240px"
        @change="search"
      />
      <el-checkbox v-model="filter.includeVoided" @change="search">显示已作废</el-checkbox>
    </div>

    <el-table :data="items" v-loading="loading" border>
      <el-table-column prop="occurredOn" label="日期" width="110" />
      <el-table-column label="类型" width="80">
        <template #default="{ row }">{{ TRANSACTION_TYPE_LABELS[row.type as TransactionType] }}</template>
      </el-table-column>
      <el-table-column label="资金流向（账户）" min-width="200">
        <template #default="{ row }">{{ flowText(row) }}</template>
      </el-table-column>
      <el-table-column prop="categoryName" label="分类" width="120" />
      <el-table-column prop="counterparty" label="往来单位" width="140" />
      <el-table-column label="金额" align="right" width="140">
        <template #default="{ row }">
          <span :class="{ 'money-in': amountOf(row) > 0, 'money-out': amountOf(row) < 0 }" :style="row.status === 'voided' ? 'text-decoration: line-through; opacity: .5' : ''">
            {{ formatMoney(amountOf(row)) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="80">
        <template #default="{ row }"><el-tag v-if="row.status === 'voided'" type="info" size="small">已作废</el-tag></template>
      </el-table-column>
      <el-table-column label="操作" width="80">
        <template #default="{ row }"><el-button v-if="row.status === 'normal'" link type="danger" @click="voidTx(row)">作废</el-button></template>
      </el-table-column>
    </el-table>

    <el-pagination v-model:current-page="page.current" v-model:page-size="page.size" :total="page.total" layout="total, prev, pager, next, sizes" style="margin-top: 16px; justify-content: flex-end" @change="load" />

    <el-dialog v-model="dialog" title="记一笔" width="520px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="类型">
          <el-radio-group v-model="form.type">
            <el-radio-button v-for="t in TRANSACTION_TYPES" :key="t" :value="t">{{ TRANSACTION_TYPE_LABELS[t] }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="日期"><el-date-picker v-model="form.occurredOn" type="date" value-format="YYYY-MM-DD" style="width: 100%" /></el-form-item>
        <el-form-item label="金额(元)"><el-input v-model="form.amount" /></el-form-item>
        <el-form-item :label="accountLabel">
          <el-select v-model="form.accountId" style="width: 100%">
            <el-option v-for="a in base.accounts" :key="a.id" :label="`${a.name}（${formatMoney(a.balance)}）`" :value="a.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="hasCategory" label="分类">
          <el-select v-model="form.categoryId" clearable style="width: 100%">
            <el-option v-for="c in categoryOptions" :key="c.id" :label="c.name" :value="c.id" />
            <template #footer>
              <el-button link type="primary" icon="Setting" @click="openCategoryManager">{{ form.type === 'income' ? '管理收入分类' : '管理支出分类' }}</el-button>
            </template>
          </el-select>
        </el-form-item>
        <el-form-item label="往来单位">
          <el-select v-model="form.counterpartyId" clearable filterable style="width: 100%">
            <el-option v-for="c in base.counterparties" :key="c.id" :label="c.name" :value="c.id" />
            <template #footer>
              <el-button link type="primary" icon="Setting" @click="cpDialog = true">管理往来单位</el-button>
            </template>
          </el-select>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="form.note" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :disabled="!form.amount || !form.accountId" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 二级弹窗：管理收入/支出分类 与 往来单位 -->
    <NameManagerDialog
      v-model="catDialog"
      :title="catKind === 'income' ? '管理收入分类' : '管理支出分类'"
      noun="分类"
      :items="managedCategories"
      :used-hint="categoryUsedHint"
      :on-create="createCategory"
      :on-rename="renameCategory"
      :on-remove="removeCategory"
    />
    <NameManagerDialog
      v-model="cpDialog"
      title="管理往来单位"
      noun="往来单位"
      :items="base.counterparties"
      :used-hint="counterpartyUsedHint"
      :on-create="createCounterparty"
      :on-rename="renameCounterparty"
      :on-remove="removeCounterparty"
    />
  </div>
</template>
