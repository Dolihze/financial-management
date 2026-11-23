<script setup lang="ts">
import type { Account } from '@fm/shared';
import { onMounted, ref } from 'vue';
import { api } from '@/api';
import { formatMoney, today } from '@/utils/format';

/**
 * 结算入账信息：项目归入合同 = 结算（项目结算置为是，并按企信实收记一笔收入）。
 * 入账账户必选；入账日期默认当天。账户列表在组件挂载时加载（弹窗 destroy-on-close，每次打开都是最新余额）。
 */
const accountId = defineModel<string>('accountId', { required: true });
const date = defineModel<string>('date', { required: true });

const accounts = ref<Account[]>([]);
onMounted(async () => {
  if (!date.value) date.value = today();
  accounts.value = await api.accounts.list();
  // 只有一个账户时默认选中，减少操作
  if (!accountId.value && accounts.value.length === 1) accountId.value = accounts.value[0]!.id;
});
</script>

<template>
  <div class="settlement">
    <el-select v-model="accountId" placeholder="请选择入账账户" style="width: 260px">
      <el-option v-for="a in accounts" :key="a.id" :value="a.id" :label="`${a.name}（余额 ${formatMoney(a.balance)}）`" />
    </el-select>
    <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" :clearable="false" placeholder="入账日期" style="width: 160px" />
  </div>
</template>

<style scoped>
.settlement {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
