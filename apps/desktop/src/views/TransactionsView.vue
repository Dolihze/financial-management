<script setup lang="ts">
import {
  TRANSACTION_TYPES,
  TRANSACTION_TYPE_IS_INFLOW,
  TRANSACTION_TYPE_LABELS,
  type Category,
  type Transaction,
  type TransactionAttachment,
  type TransactionType
} from '@fm/shared';
import { ElMessage, ElMessageBox, type UploadFile, type UploadFiles, type UploadUserFile } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { api, type TransactionSummary } from '@/api';
import NameManagerDialog from '@/components/NameManagerDialog.vue';
import { useBaseStore } from '@/stores/base';
import { errorMessage, formatMoney, fromCents, toCents, today } from '@/utils/format';
import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from '@/utils/pagination';
import { monthRange, PERIOD_TABS, presetRange, type PeriodKey } from '@/utils/period';

const base = useBaseStore();

const filter = reactive({
  accountId: '' as string,
  type: '' as TransactionType | '',
  categoryId: '' as string,
  counterpartyId: '' as string,
  /** 当前生效的日期范围，默认本月（null = 全部时间） */
  range: presetRange('month') as [string, string] | null
});

// ---- 日期筛选：本月 / 上月 / 本季度 / 今年 / 自定义（与总览一致） ----
const periodKey = ref<PeriodKey>('month');
/** 自定义范围的「暂存值」：只有点「查询」才会真正用于筛选 */
const customRange = ref<[string, string] | null>(monthRange(0));

function selectPeriod(key: PeriodKey) {
  periodKey.value = key;
  if (key === 'custom') return; // 自定义：等用户选日期后点「查询」
  filter.range = presetRange(key);
  search();
}
function queryCustom() {
  filter.range = customRange.value;
  search();
}
const page = reactive({ current: 1, size: DEFAULT_PAGE_SIZE, total: 0 });
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
    to: filter.range?.[1]
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

// ---- 表头筛选（服务端筛选，每列单选；column-key 即 filter 里的字段名） ----
const typeFilters = TRANSACTION_TYPES.map((t) => ({ text: TRANSACTION_TYPE_LABELS[t], value: t }));
const accountFilters = computed(() => base.accounts.map((a) => ({ text: a.name, value: a.id })));
/** 分类筛选：收入、支出分类可能重名，未选类型时选项文字带上类型区分；已选收入/支出类型时只列出对应类型的分类 */
const categoryFilters = computed(() => {
  const plain = (list: Category[]) => list.map((c) => ({ text: c.name, value: c.id }));
  if (filter.type === 'income') return plain(base.incomeCategories);
  if (filter.type === 'expense') return plain(base.expenseCategories);
  return [
    ...base.incomeCategories.map((c) => ({ text: `${c.name}（收入）`, value: c.id })),
    ...base.expenseCategories.map((c) => ({ text: `${c.name}（支出）`, value: c.id }))
  ];
});
const counterpartyFilters = computed(() => base.counterparties.map((c) => ({ text: c.name, value: c.id })));

/** 受控的已选值：分类被联动清空时，表头的选中状态同步取消 */
const filteredValue = (v: string) => (v ? [v] : []);

function onFilterChange(filters: Record<string, string[]>) {
  const one = (key: string) => filters[key]?.[0] ?? '';
  if ('type' in filters) {
    filter.type = one('type') as TransactionType | '';
    // 换了类型后，已选分类若不属于该类型则不再适用，清空避免带着看不见的筛选条件
    if (filter.type === 'income' || filter.type === 'expense') {
      const list = filter.type === 'income' ? base.incomeCategories : base.expenseCategories;
      if (!list.some((c) => c.id === filter.categoryId)) filter.categoryId = '';
    }
  }
  if ('accountId' in filters) filter.accountId = one('accountId');
  if ('categoryId' in filters) filter.categoryId = one('categoryId');
  if ('counterpartyId' in filters) filter.counterpartyId = one('counterpartyId');
  search();
}
function search() {
  page.current = 1;
  load();
}

// ---- 新增 / 编辑（同一个弹窗） ----
const dialog = ref(false);
/** 正在编辑的流水；为空表示新增 */
const editingId = ref<string | null>(null);
const form = reactive({
  type: 'expense' as TransactionType,
  occurredOn: today(),
  amount: '',
  accountId: '',
  categoryId: '' as string,
  counterpartyId: '' as string,
  note: ''
});
/** 记一笔/编辑时选中的相关文件（保存流水成功后再逐个上传） */
const pendingFiles = ref<UploadUserFile[]>([]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 20;

/** 编辑弹窗里「已上传文件」：取列表中实时的流水，删除后刷新列表时同步更新 */
const editingFiles = computed<TransactionAttachment[]>(() => {
  if (!editingId.value) return [];
  return items.value.find((t) => t.id === editingId.value)?.attachments ?? [];
});
/** 还能再选几个文件（已上传 + 待上传 不超过上限） */
const fileQuota = computed(() => Math.max(0, MAX_FILES - editingFiles.value.length));

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
  // 编辑时要把已上传的文件数一并算进上限
  const quota = fileQuota.value;
  if (ok.length > quota) {
    ElMessage.warning(`一笔流水最多上传 ${MAX_FILES} 个文件`);
    ok.length = quota;
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
  editingId.value = null;
  Object.assign(form, { type: 'expense', occurredOn: today(), amount: '', accountId: '', categoryId: '', counterpartyId: '', note: '' });
  pendingFiles.value = [];
  dialog.value = true;
}

function openEdit(tx: Transaction) {
  editingId.value = tx.id;
  Object.assign(form, {
    type: tx.type,
    occurredOn: tx.occurredOn,
    // 金额以分存储，展示为元（正数）；用 fromCents 转换，不做浮点运算
    amount: fromCents(Math.abs(amountOf(tx))),
    accountId: tx.lines[0]?.accountId ?? '',
    categoryId: tx.categoryId ?? '',
    counterpartyId: tx.counterpartyId ?? '',
    note: tx.note
  });
  pendingFiles.value = [];
  dialog.value = true;
}

/** 切换类型时，已选分类可能不属于新类型（收入/支出分类不同），清空避免提交非法分类 */
function onFormTypeChange() {
  if (!categoryOptions.value.some((c) => c.id === form.categoryId)) form.categoryId = '';
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
    const editing = !!editingId.value;
    const body = {
      type: form.type,
      occurredOn: form.occurredOn,
      amount: toCents(form.amount),
      accountId: form.accountId,
      categoryId: hasCategory.value ? form.categoryId || null : null,
      counterpartyId: form.counterpartyId || null,
      note: form.note
    };
    const saved = editingId.value
      ? await api.transactions.update(editingId.value, body)
      : await api.transactions.create(body);
    // 流水已经保存：之后文件上传失败不能当作「保存失败」，否则用户会重复提交。逐个上传，失败的单独提示
    const failed: string[] = [];
    for (const f of pendingFiles.value) {
      if (!f.raw) continue;
      try {
        await api.transactions.addAttachment(saved.id, f.raw);
      } catch (e) {
        failed.push(`${f.name}（${errorMessage(e)}）`);
      }
    }
    dialog.value = false;
    await Promise.all([load(), base.loadAccounts()]);
    if (failed.length === 0) {
      ElMessage.success(editing ? '已保存' : '已记账');
    } else {
      ElMessageBox.alert(
        `流水已${editing ? '保存' : '记账'}（请勿重复提交），但以下文件上传失败：\n${failed.join('\n')}`,
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

/** 删除已上传文件：二次确认后立即生效（后端软删除，保留记录与磁盘文件），不依赖「保存」 */
async function removeAttachment(a: TransactionAttachment) {
  try {
    await ElMessageBox.confirm(`确定删除文件「${a.fileName}」吗？`, '删除文件', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    });
  } catch {
    return; // 取消
  }
  await withBusy(a.id, async () => {
    await api.transactions.removeAttachment(a.id);
    await load();
    ElMessage.success('已删除文件');
  });
}

/** 「相关文件」弹窗：展示某笔流水上传的全部文件 */
const filesDialog = ref(false);
const filesOf = ref<Transaction | null>(null);
function showFiles(tx: Transaction) {
  filesOf.value = tx;
  filesDialog.value = true;
}

/** 正在打开/下载的文件 id：期间禁用对应按钮，避免大文件重复点击 */
const busyFiles = ref<Set<string>>(new Set());
async function withBusy(id: string, fn: () => Promise<void>) {
  if (busyFiles.value.has(id)) return;
  busyFiles.value = new Set(busyFiles.value).add(id);
  try {
    await fn();
  } catch (e) {
    ElMessage.error(errorMessage(e));
  } finally {
    const next = new Set(busyFiles.value);
    next.delete(id);
    busyFiles.value = next;
  }
}

/** 点击文件名：用系统默认程序打开（图片->看图软件，PDF/Excel/Word->对应软件），不会下载 */
const openAttachment = (a: TransactionAttachment) => withBusy(a.id, () => api.attachments.open(a));

/** 点击「下载」：弹出系统另存为对话框，把文件保存到所选位置 */
const downloadAttachment = (a: TransactionAttachment) =>
  withBusy(a.id, async () => {
    if (await api.attachments.download(a)) ElMessage.success('已保存');
  });
/** ISO 时间（UTC）显示为本地时间 YYYY-MM-DD HH:mm */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function removeTx(tx: Transaction) {
  try {
    await ElMessageBox.confirm(
      `确定删除这笔流水（${tx.occurredOn}，${TRANSACTION_TYPE_LABELS[tx.type]} ${formatMoney(Math.abs(amountOf(tx)))}）吗？删除后账户余额随之恢复，该笔的相关文件也会一并删除。`,
      '删除流水',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    );
  } catch {
    return; // 取消
  }
  try {
    await api.transactions.remove(tx.id);
    ElMessage.success('已删除');
    // 当前页最后一条被删后回到上一页，避免停在空页
    if (items.value.length === 1 && page.current > 1) page.current -= 1;
    await Promise.all([load(), base.loadAccounts()]);
  } catch (e) {
    ElMessage.error(errorMessage(e));
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
      <div class="period-tabs">
        <span
          v-for="t in PERIOD_TABS"
          :key="t.key"
          class="period-tab"
          :class="{ active: periodKey === t.key }"
          @click="selectPeriod(t.key)"
        >{{ t.label }}</span>
      </div>
      <template v-if="periodKey === 'custom'">
        <el-date-picker
          v-model="customRange"
          type="daterange"
          unlink-panels
          clearable
          value-format="YYYY-MM-DD"
          range-separator="~"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
        />
        <el-button type="primary" :loading="loading" @click="queryCustom">查询</el-button>
        <el-text v-if="!customRange" type="info" size="small">未选日期：显示全部时间</el-text>
      </template>
    </div>

    <div class="summary-bar">
      <span class="summary-count">共 {{ page.total }} 笔</span>
      <span class="summary-item"><span class="summary-label">收入</span><b class="tx-income">{{ formatMoney(summary.income) }}</b></span>
      <span class="summary-item"><span class="summary-label">支出</span><b class="tx-expense">{{ formatMoney(summary.expense) }}</b></span>
      <span class="summary-item">
        <span class="summary-label">盈亏</span>
        <b :class="summary.profit > 0 ? 'tx-income' : summary.profit < 0 ? 'tx-expense' : ''">{{ formatMoney(summary.profit) }}</b>
      </span>
    </div>
    <el-table :data="items" v-loading="loading" border class="tx-table" @filter-change="onFilterChange">
      <el-table-column prop="occurredOn" label="日期" width="130" align="left" header-align="left" />
      <el-table-column
        column-key="type"
        label="类型"
        width="110"
        align="left"
        header-align="left"
        :filters="typeFilters"
        :filter-method="() => true"
        :filter-multiple="false"
        :filtered-value="filteredValue(filter.type)"
      >
        <template #default="{ row }">{{ TRANSACTION_TYPE_LABELS[row.type as TransactionType] }}</template>
      </el-table-column>
      <el-table-column
        column-key="accountId"
        label="资金流向（账户）"
        min-width="240"
        align="left"
        header-align="left"
        :filters="accountFilters"
        :filter-method="() => true"
        :filter-multiple="false"
        :filtered-value="filteredValue(filter.accountId)"
      >
        <template #default="{ row }">{{ flowText(row) }}</template>
      </el-table-column>
      <el-table-column
        prop="categoryName"
        column-key="categoryId"
        label="分类"
        width="130"
        align="left"
        header-align="left"
        :filters="categoryFilters"
        :filter-method="() => true"
        :filter-multiple="false"
        :filtered-value="filteredValue(filter.categoryId)"
      />
      <el-table-column
        prop="counterparty"
        column-key="counterpartyId"
        label="往来单位"
        min-width="170"
        align="left"
        header-align="left"
        :filters="counterpartyFilters"
        :filter-method="() => true"
        :filter-multiple="false"
        :filtered-value="filteredValue(filter.counterpartyId)"
      />
      <el-table-column label="金额" width="160" align="left" header-align="left">
        <template #default="{ row }">
          <span :class="{ 'tx-income': amountOf(row) > 0, 'tx-expense': amountOf(row) < 0 }">
            {{ formatMoney(amountOf(row)) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="相关文件" width="160" align="left" header-align="left">
        <template #default="{ row }">
          <el-button v-if="(row as Transaction).attachments.length" link type="primary" @click="showFiles(row)">
            <el-icon><Paperclip /></el-icon>
            <span class="file-link-text">查看文件（{{ (row as Transaction).attachments.length }}）</span>
          </el-button>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120" align="left" header-align="left">
        <template #default="{ row }">
          <el-tooltip v-if="(row as Transaction).linkedToProject" content="由项目入账自动生成，请在项目中把对应字段切换为「否」回退" placement="top">
            <span class="linked-hint">项目入账</span>
          </el-tooltip>
          <template v-else>
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="removeTx(row)">删除</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination v-model:current-page="page.current" v-model:page-size="page.size" :page-sizes="PAGE_SIZES" :total="page.total" layout="total, prev, pager, next, sizes" style="margin-top: 16px; justify-content: flex-end" @size-change="page.current = 1" @change="load" />

    <el-dialog v-model="dialog" :title="editingId ? '编辑流水' : '记一笔'" width="520px" draggable destroy-on-close align-center>
      <el-form :model="form" label-width="90px">
        <el-form-item label="类型">
          <el-radio-group v-model="form.type" @change="onFormTypeChange">
            <el-radio-button v-for="t in TRANSACTION_TYPES" :key="t" :value="t">{{ TRANSACTION_TYPE_LABELS[t] }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="日期" required><el-date-picker v-model="form.occurredOn" type="date" value-format="YYYY-MM-DD" style="width: 100%" /></el-form-item>
        <el-form-item label="金额(元)" required><el-input v-model="form.amount" /></el-form-item>
        <el-form-item :label="accountLabel" required>
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
        <!-- 编辑时：已上传的文件，可查看（打开）、下载、删除；删除立即生效 -->
        <el-form-item v-if="editingFiles.length" label="已传文件">
          <ul class="uploaded-list">
            <li v-for="a in editingFiles" :key="a.id" class="uploaded-item">
              <el-link class="file-link" type="primary" underline="never" :title="`点击用系统软件打开：${a.fileName}`" :disabled="busyFiles.has(a.id)" @click="openAttachment(a)">
                <el-icon><Paperclip /></el-icon>
                <span class="file-name">{{ a.fileName }}</span>
              </el-link>
              <span class="file-size">{{ formatSize(a.size) }}</span>
              <el-button link type="primary" size="small" :disabled="busyFiles.has(a.id)" @click="downloadAttachment(a)">下载</el-button>
              <el-button link type="danger" size="small" :disabled="busyFiles.has(a.id)" @click="removeAttachment(a)">删除</el-button>
            </li>
          </ul>
        </el-form-item>
        <el-form-item :label="editingId ? '补传文件' : '相关文件'">
          <el-upload
            v-model:file-list="pendingFiles"
            multiple
            drag
            :auto-upload="false"
            :limit="MAX_FILES + 1"
            :disabled="fileQuota === 0"
            :on-change="onFileChange"
            class="compact-upload"
          >
            <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
            <div class="el-upload__text">拖拽文件到此处，或<em>点击选择</em></div>
            <template #tip>
              <div class="form-tip">图片、PDF 或其他文件均可，单个不超过 20 MB，最多 {{ MAX_FILES }} 个；保存流水后{{ editingId ? '上传新选的文件' : '一并上传' }}</div>
            </template>
          </el-upload>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!form.amount || !form.accountId" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 相关文件列表：点击文件名用系统默认程序打开，「下载」另存到本机 -->
    <el-dialog v-model="filesDialog" title="相关文件" width="640px" draggable align-center>
      <el-table :data="filesOf?.attachments ?? []" size="small" border max-height="360" empty-text="暂无文件">
        <el-table-column label="文件名" min-width="240" align="left" header-align="left">
          <template #default="{ row }">
            <el-link class="file-link" type="primary" underline="never" :title="`点击用系统软件打开：${row.fileName}`" :disabled="busyFiles.has(row.id)" @click="openAttachment(row)">
              <el-icon><Paperclip /></el-icon>
              <span class="file-name">{{ row.fileName }}</span>
            </el-link>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="90" align="left" header-align="left">
          <template #default="{ row }">{{ formatSize(row.size) }}</template>
        </el-table-column>
        <el-table-column label="上传时间" width="160" align="left" header-align="left">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="80" align="left" header-align="left">
          <template #default="{ row }">
            <el-button link type="primary" :loading="busyFiles.has(row.id)" @click="downloadAttachment(row)">下载</el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="filesDialog = false">关闭</el-button>
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
.file-link-text {
  margin-left: 4px;
}
/* 时间段 Tab：文字 + 选中底部蓝条（与总览一致） */
.period-tabs {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
.period-tab {
  position: relative;
  padding: 0 14px;
  line-height: 32px;
  cursor: pointer;
  color: var(--el-text-color-regular);
  user-select: none;
}
.period-tab:hover {
  color: var(--el-color-primary);
}
.period-tab.active {
  color: var(--el-color-primary);
  font-weight: 600;
}
.period-tab.active::after {
  content: '';
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: -2px;
  height: 2px;
  border-radius: 1px;
  background: var(--el-color-primary);
}
/* 日期范围选择器宽度：用官方变量控制，并禁止在 flex 行里被拉伸 */
.page-toolbar :deep(.el-date-editor.el-input__wrapper) {
  --el-date-editor-width: 350px;
  width: 350px;
  flex: none;
}
/* 表头文字 + 筛选箭头始终同一行：不换行，空间不足时文字省略而不是把箭头挤到下一行 */
.tx-table :deep(th.el-table__cell > .cell) {
  display: flex;
  align-items: center;
  white-space: nowrap;
}
.tx-table :deep(th.el-table__cell > .cell .caret-wrapper),
.tx-table :deep(th.el-table__cell > .cell .el-table__column-filter-trigger) {
  flex: none;
}
.tx-table :deep(th.el-table__cell > .cell .el-table__column-filter-trigger) {
  margin-left: 4px;
}
/* 文件名过长时显示省略号：链接占满单元格宽度（min-width: 0 允许 flex 子项收缩），文字在链接内部截断 */
.file-link {
  display: flex;
  justify-content: flex-start;
  max-width: 100%;
}
.file-link :deep(.el-link__inner) {
  display: flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
}
.file-name {
  flex: 1;
  min-width: 0;
  margin-left: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.linked-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  cursor: help;
}
.uploaded-list {
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 140px;
  overflow-y: auto;
}
.uploaded-item {
  display: flex;
  align-items: center;
  gap: 8px;
  line-height: 28px;
}
.uploaded-item .file-link {
  flex: 1;
  min-width: 0;
}
.file-size {
  flex: none;
  font-size: 12px;
  color: var(--el-text-color-secondary);
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
