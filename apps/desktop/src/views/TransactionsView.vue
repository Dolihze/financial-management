<script setup lang="ts">
import { TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS, type Transaction, type TransactionType } from '@fm/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '@/api';
import { useBaseStore } from '@/stores/base';
import { errorMessage, formatMoney, toCents, today } from '@/utils/format';

const base = useBaseStore();

const filter = reactive({
  accountId: '' as string,
  type: '' as TransactionType | '',
  keyword: '',
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
      keyword: filter.keyword || undefined,
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
  summary: '',
  accountId: '',
  fromAccountId: '',
  toAccountId: '',
  categoryId: '' as string,
  counterparty: '',
  note: ''
});
const categoryOptions = computed(() =>
  form.type === 'income' ? base.incomeCategories : form.type === 'expense' ? base.expenseCategories : []
);

function openDialog() {
  Object.assign(form, { type: 'expense', occurredOn: today(), amount: '', summary: '', accountId: '', fromAccountId: '', toAccountId: '', categoryId: '', counterparty: '', note: '' });
  dialog.value = true;
}

async function submit() {
  try {
    await api.transactions.create({
      type: form.type,
      occurredOn: form.occurredOn,
      amount: toCents(form.amount),
      summary: form.summary,
      accountId: form.type === 'transfer' ? undefined : form.accountId,
      fromAccountId: form.type === 'transfer' ? form.fromAccountId : undefined,
      toAccountId: form.type === 'transfer' ? form.toAccountId : undefined,
      categoryId: form.categoryId || null,
      counterparty: form.counterparty,
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
  if (tx.type === 'transfer') {
    const from = tx.lines.find((l) => l.amount < 0)?.accountName;
    const to = tx.lines.find((l) => l.amount > 0)?.accountName;
    return `${from} → ${to}`;
  }
  return tx.lines[0]?.accountName ?? '';
}
function amountOf(tx: Transaction): number {
  return tx.type === 'transfer' ? Math.abs(tx.lines[0]?.amount ?? 0) : (tx.lines[0]?.amount ?? 0);
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
      <el-select v-model="filter.type" placeholder="全部类型" clearable style="width: 120px" @change="search">
        <el-option v-for="t in TRANSACTION_TYPES" :key="t" :label="TRANSACTION_TYPE_LABELS[t]" :value="t" />
      </el-select>
      <el-date-picker v-model="filter.range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" @change="search" />
      <el-input v-model="filter.keyword" placeholder="摘要/往来单位/备注" clearable style="width: 200px" @keyup.enter="search" @clear="search" />
      <el-checkbox v-model="filter.includeVoided" @change="search">显示已作废</el-checkbox>
    </div>

    <el-table :data="items" v-loading="loading" border>
      <el-table-column prop="occurredOn" label="日期" width="110" />
      <el-table-column label="类型" width="80">
        <template #default="{ row }">{{ TRANSACTION_TYPE_LABELS[row.type as TransactionType] }}</template>
      </el-table-column>
      <el-table-column prop="summary" label="摘要" min-width="160" />
      <el-table-column label="资金流向（账户）" min-width="200">
        <template #default="{ row }">{{ flowText(row) }}</template>
      </el-table-column>
      <el-table-column prop="categoryName" label="分类" width="120" />
      <el-table-column prop="counterparty" label="往来单位" width="140" />
      <el-table-column label="金额" align="right" width="140">
        <template #default="{ row }">
          <span :class="{ 'money-in': amountOf(row) > 0 && row.type !== 'transfer', 'money-out': amountOf(row) < 0 }" :style="row.status === 'voided' ? 'text-decoration: line-through; opacity: .5' : ''">
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
        <el-form-item label="金额(元)"><el-input v-model="form.amount" placeholder="如 1234.56" /></el-form-item>
        <el-form-item label="摘要"><el-input v-model="form.summary" /></el-form-item>
        <template v-if="form.type !== 'transfer'">
          <el-form-item :label="form.type === 'income' ? '入账账户' : '出账账户'">
            <el-select v-model="form.accountId" style="width: 100%">
              <el-option v-for="a in base.accounts" :key="a.id" :label="`${a.name}（${formatMoney(a.balance)}）`" :value="a.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="分类">
            <el-select v-model="form.categoryId" clearable style="width: 100%">
              <el-option v-for="c in categoryOptions" :key="c.id" :label="c.name" :value="c.id" />
            </el-select>
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="转出账户">
            <el-select v-model="form.fromAccountId" style="width: 100%">
              <el-option v-for="a in base.accounts" :key="a.id" :label="`${a.name}（${formatMoney(a.balance)}）`" :value="a.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="转入账户">
            <el-select v-model="form.toAccountId" style="width: 100%">
              <el-option v-for="a in base.accounts" :key="a.id" :label="a.name" :value="a.id" />
            </el-select>
          </el-form-item>
        </template>
        <el-form-item label="往来单位"><el-input v-model="form.counterparty" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.note" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :disabled="!form.amount || !form.summary.trim()" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
