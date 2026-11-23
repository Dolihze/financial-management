<script setup lang="ts">
/**
 * 项目管理层级面包屑：批次管理 → 第N批 → 合同 → （项目）。
 * 每一级可点击回到该层；最后一级为当前页，不可点击。
 * 只负责展示与跳转，数据由各页面传入。
 */
import { useRouter } from 'vue-router';

export interface Crumb {
  label: string;
  /** 不传 = 当前页（或不可跳转） */
  to?: { name: string; params?: { batchId?: string; contractId?: string }; query?: Record<string, string> };
}

defineProps<{ items: Crumb[] }>();
const router = useRouter();
</script>

<template>
  <el-breadcrumb separator="/" class="crumbs">
    <el-breadcrumb-item v-for="(c, i) in items" :key="i">
      <a v-if="c.to" class="crumb-link" href="javascript:void(0)" @click.prevent="router.push(c.to)">{{ c.label }}</a>
      <span v-else class="crumb-current">{{ c.label }}</span>
    </el-breadcrumb-item>
  </el-breadcrumb>
</template>

<style scoped>
.crumbs {
  margin-bottom: 12px;
  font-size: 14px;
}
.crumb-link {
  color: var(--el-color-primary);
  cursor: pointer;
  text-decoration: none;
}
.crumb-link:hover {
  color: var(--el-color-primary-light-3);
}
.crumb-current {
  color: var(--el-text-color-primary);
  font-weight: 600;
}
</style>
