import type { Account, Category, Counterparty } from '@fm/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '@/api';

/** 账户与分类是全局基础数据，多个页面共用 */
export const useBaseStore = defineStore('base', () => {
  const accounts = ref<Account[]>([]);
  const categories = ref<Category[]>([]);
  const counterparties = ref<Counterparty[]>([]);

  const totalBalance = computed(() => accounts.value.reduce((s, a) => s + a.balance, 0));
  const incomeCategories = computed(() => categories.value.filter((c) => c.kind === 'income'));
  const expenseCategories = computed(() => categories.value.filter((c) => c.kind === 'expense'));

  async function loadAccounts() {
    accounts.value = await api.accounts.list();
  }
  async function loadCategories() {
    categories.value = await api.categories.list();
  }
  async function loadCounterparties() {
    counterparties.value = await api.counterparties.list();
  }
  async function loadAll() {
    await Promise.all([loadAccounts(), loadCategories(), loadCounterparties()]);
  }

  return {
    accounts,
    categories,
    counterparties,
    totalBalance,
    incomeCategories,
    expenseCategories,
    loadAccounts,
    loadCategories,
    loadCounterparties,
    loadAll
  };
});
