<script setup lang="ts">
import {
  TRANSACTION_TYPES,
  TRANSACTION_TYPE_IS_INFLOW,
  TRANSACTION_TYPE_LABELS,
  type Category,
  type Transaction,
  type TransactionType
} from '@fm/shared';
import { ElMessage, ElMessageBox, type UploadFile, type UploadFiles, type UploadUserFile } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { api, type TransactionSummary } from '@/api';
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

/** 当前筛选条件下（全部页）的收入/支出/盈亏合计，由服务端统计 */
const summary = ref<TransactionSummary>({ income: 0, expense: 0, profit: 0, count: 0 });

function currentFilter() {
  return {
    accountId: filter.accountId || undefined,
    type: filter.type || undefined,
    categoryId: filter.categoryId || undefined,
    counterpartyId: filter.counterpartyId || undefined,
    from: filter.range?.[0],
    to: filter.range?.[1],
    includeVoided: filter.includeVoided
  };
}

async function load() {
  loading.value = true;
  try {
    const [res, sum] = await Promise.all([
      api.transactions.list({ ...currentFilter(), limit: page.size, offset: (page.current - 1) * page.size }),
      api.transactions.summary(currentFilter())
    ]);
    items.value = res.items;
    page.total = res.total;
    summary.value = sum;
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
/** 记一笔时选中的相关文件（保存流水成功后再逐个上传） */
const pendingFiles = ref<UploadUserFile[]>([]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 20;

/** 选择文件时的数量与大小校验：不合格的直接从待上传列表里移除并提示 */
function onFileChange(_file: UploadFile, files: UploadFiles) {
  const ok = files.filter((f) => {
    const size = f.raw?.size ?? f.size ?? 0;
    if (size === 0) {
      ElMessage.warning(`「${f.name}」是空文件，已忽略`);
      return false;
    }
    if (size > MAX_FILE_BYTES) {
      ElMessage.warning(`「${f.name}」超过 20 MB，已忽略`);
      return false;
    }
    return true;
  });
  if (ok.length > MAX_FILES) {
    ElMessage.warning(`一笔流水最多上传 ${MAX_FILES} 个文件`);
    ok.length = MAX_FILES;
  }
  pendingFiles.value = ok;
}
/** 借款/贷款不使用收支分类 */
const hasCategory = computed(() => form.type === 'income' || form.type === 'expense');
const categoryOptions = computed(() =>
  form.type === 'income' ? base.incomeCategories : form.type === 'expense' ? base.expenseCategories : []
);
const accountLabel = computed(() => (TRANSACTION_TYPE_IS_INFLOW[form.type] ? '入账账户' : '出账账户'));

function openDialog() {
  Object.assign(form, { type: 'expense', occurredOn: today(), amount: '', accountId: '', categoryId: '', counterpartyId: '', note: '' });
  pendingFiles.value = [];
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
const submitting = ref(false);

async function submit() {
  if (submitting.value) return; // 防止重复点击产生重复流水
  submitting.value = true;
  try {
    const created = await api.transactions.create({
      type: form.type,
      occurredOn: form.occurredOn,
      amount: toCents(form.amount),
      accountId: form.accountId,
      categoryId: hasCategory.value ? form.categoryId || null : null,
      counterpartyId: form.counterpartyId || null,
      note: form.note
    });
    // 流水已经入账：之后文件上传失败不能当作「记账失败」，否则用户会重复记一笔。逐个上传，失败的单独提示
    const failed: string[] = [];
    for (const f of pendingFiles.value) {
      if (!f.raw) continue;
      try {
        await api.transactions.addAttachment(created.id, f.raw);
      } catch (e) {
        failed.push(`${f.name}（${errorMessage(e)}）`);
      }
    }
    dialog.value = false;
    await Promise.all([load(), base.loadAccounts()]);
    if (failed.length === 0) {
      ElMessage.success('已记账');
    } else {
      ElMessageBox.alert(
        `流水已记账（请勿重复记账），但以下文件上传失败：\n${failed.join('\n')}`,
        '部分文件上传失败',
        { type: 'warning', confirmButtonText: '知道了' }
      ).catch(() => {});
    }
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    submitting.value = false;
  }
}

/** 点击「相关文件」打开：桌面端交给系统默认程序，纯浏览器新开标签页 */
async function openAttachment(id: string) {
  try {
    await api.attachments.open(id);
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}
function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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

    <div class="summary-bar">
      <span class="summary-count">共 {{ page.total }} 笔{{ filter.includeVoided ? '（统计不含已作废）' : '' }}</span>
      <span class="summary-item"><span class="summary-label">收入</span><b class="tx-income">{{ formatMoney(summary.income) }}</b></span>
      <span class="summary-item"><span class="summary-label">支出</span><b class="tx-expense">{{ formatMoney(summary.expense) }}</b></span>
      <span class="summary-item">
        <span class="summary-label">盈亏</span>
        <b :class="summary.profit > 0 ? 'tx-income' : summary.profit < 0 ? 'tx-expense' : ''">{{ formatMoney(summary.profit) }}</b>
      </span>
    </div>
    <el-table :data="items" v-loading="loading" border>
      <el-table-column prop="occurredOn" label="日期" width="130" align="left" header-align="left" />
      <el-table-column label="类型" width="90" align="left" header-align="left">
        <template #default="{ row }">{{ TRANSACTION_TYPE_LABELS[row.type as TransactionType] }}</template>
      </el-table-column>
      <el-table-column label="资金流向（账户）" min-width="220" align="left" header-align="left">
        <template #default="{ row }">{{ flowText(row) }}</template>
      </el-table-column>
      <el-table-column prop="categoryName" label="分类" width="130" align="left" header-align="left" />
      <el-table-column prop="counterparty" label="往来单位" min-width="160" align="left" header-align="left" />
      <el-table-column label="金额" width="160" align="left" header-align="left">
        <template #default="{ row }">
          <span :class="{ 'tx-income': amountOf(row) > 0, 'tx-expense': amountOf(row) < 0 }" :style="row.status === 'voided' ? 'text-decoration: line-through; opacity: .5' : ''">
            {{ formatMoney(amountOf(row)) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="相关文件" min-width="200" align="left" header-align="left">
        <template #default="{ row }">
          <div v-if="(row as Transaction).attachments.length" class="file-list">
            <el-link
              v-for="a in (row as Transaction).attachments"
              :key="a.id"
              type="primary"
              underline="never"
              :title="`${a.fileName}（${formatSize(a.size)}），点击打开`"
              @click="openAttachment(a.id)"
            >
              <el-icon><Paperclip /></el-icon>
              <span class="file-name">{{ a.fileName }}</span>
            </el-link>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90" align="left" header-align="left">
        <template #default="{ row }"><el-button v-if="row.status === 'normal'" link type="danger" @click="voidTx(row)">作废</el-button></template>
      </el-table-column>
    </el-table>

    <el-pagination v-model:current-page="page.current" v-model:page-size="page.size" :total="page.total" layout="total, prev, pager, next, sizes" style="margin-top: 16px; justify-content: flex-end" @change="load" />

    <el-dialog v-model="dialog" title="记一笔" width="520px" draggable destroy-on-close align-center>
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
        <el-form-item label="相关文件">
          <el-upload
            v-model:file-list="pendingFiles"
            multiple
            drag
            :auto-upload="false"
            :limit="MAX_FILES + 1"
            :on-change="onFileChange"
            class="file-upload"
          >
            <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
            <div class="el-upload__text">拖拽文件到此处，或<em>点击选择</em></div>
            <template #tip>
              <div class="form-tip">图片、PDF 或其他文件均可，单个不超过 20 MB，最多 {{ MAX_FILES }} 个；保存流水后一并上传</div>
            </template>
          </el-upload>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!form.amount || !form.accountId" @click="submit">保存</el-button>
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

<style scoped>
.summary-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 28px;
  margin-bottom: 12px;
  padding: 10px 16px;
  background: #fff;
  border: 1px solid var(--el-border-color-light);
  border-radius: 4px;
}
.summary-count,
.summary-label {
  color: var(--el-text-color-secondary);
}
.summary-label {
  margin-right: 8px;
}
.file-list {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}
.file-name {
  max-width: 220px;
  margin-left: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-upload {
  width: 100%;
}
.form-tip {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.5;
}
/* 收入红、支出绿 */
.tx-income {
  color: #f56c6c;
}
.tx-expense {
  color: #67c23a;
}
</style>
