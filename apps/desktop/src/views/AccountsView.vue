<script setup lang="ts">
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, type AccountType, type ActiveAccountType } from '@fm/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, reactive, ref } from 'vue';
import { api } from '@/api';
import { useBaseStore } from '@/stores/base';
import { errorMessage, formatMoney, toCents } from '@/utils/format';

const base = useBaseStore();
const dialog = ref(false);
const form = reactive({ type: 'bank' as ActiveAccountType, name: '', bankName: '', accountNo: '', opening: '0', note: '' });
const isBank = computed(() => form.type === 'bank');
const canSubmit = computed(
  () => !!form.name.trim() && (!isBank.value || (!!form.bankName.trim() && !!form.accountNo.trim()))
);

function openDialog() {
  Object.assign(form, { type: 'bank', name: '', bankName: '', accountNo: '', opening: '0', note: '' });
  dialog.value = true;
}

async function submit() {
  try {
    await api.accounts.create({
      name: form.name,
      type: form.type,
      openingBalance: toCents(form.opening || '0'),
      ...(isBank.value ? { bankName: form.bankName, accountNo: form.accountNo } : {}),
      note: form.note
    });
    dialog.value = false;
    await base.loadAccounts();
    ElMessage.success('账户已创建');
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}

async function archive(id: string, name: string) {
  try {
    await ElMessageBox.confirm(`确认归档账户「${name}」？归档后不能再记账（仅余额为 0 的账户可归档）。`, '归档账户', { type: 'warning' });
    await api.accounts.archive(id);
    await base.loadAccounts();
    ElMessage.success('已归档');
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(errorMessage(e));
  }
}
</script>

<template>
  <div>
    <div class="page-toolbar">
      <el-button type="primary" icon="Plus" @click="openDialog">新增账户</el-button>
      <span class="spacer" />
      <span>合计：<b>{{ formatMoney(base.totalBalance) }}</b></span>
    </div>

    <el-table :data="base.accounts" border>
      <el-table-column prop="name" label="账户名称" min-width="210" />
      <el-table-column label="类型" width="130">
        <template #default="{ row }">{{ ACCOUNT_TYPE_LABELS[row.type as AccountType] }}</template>
      </el-table-column>
      <el-table-column prop="bankName" label="开户银行" min-width="230" />
      <el-table-column prop="accountNo" label="银行卡号" min-width="230" />
      <el-table-column label="期初余额" align="right" width="170">
        <template #default="{ row }">{{ formatMoney(row.openingBalance) }}</template>
      </el-table-column>
      <el-table-column label="当前余额" align="right" width="170">
        <template #default="{ row }"><b>{{ formatMoney(row.balance) }}</b></template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="200" show-overflow-tooltip />
      <el-table-column label="操作" width="100">
        <template #default="{ row }"><el-button link type="danger" @click="archive(row.id, row.name)">归档</el-button></template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" title="新增账户" width="500px" draggable destroy-on-close align-center>
      <el-form :model="form" label-width="110px">
        <el-form-item label="账户类型">
          <el-select v-model="form.type" style="width: 100%">
            <el-option v-for="t in ACCOUNT_TYPES" :key="t" :value="t" :label="ACCOUNT_TYPE_LABELS[t]" />
          </el-select>
        </el-form-item>
        <el-form-item label="账户名称"><el-input v-model="form.name" /></el-form-item>
        <template v-if="isBank">
          <el-form-item label="开户银行"><el-input v-model="form.bankName" /></el-form-item>
          <el-form-item label="银行卡号"><el-input v-model="form.accountNo" /></el-form-item>
        </template>
        <el-form-item label="余额"><el-input v-model="form.opening" placeholder="元，如 10000.00" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.note" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :disabled="!canSubmit" @click="submit">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>
