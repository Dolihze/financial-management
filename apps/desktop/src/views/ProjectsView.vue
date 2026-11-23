<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import SettledProjectsTable from '@/components/SettledProjectsTable.vue';
import UnsettledProjectsTable from '@/components/UnsettledProjectsTable.vue';

const router = useRouter();
const tab = ref<'settled' | 'unsettled'>('settled');
</script>

<template>
  <div>
    <!-- 「去导入」放到顶部标题栏右侧 -->
    <Teleport to="#header-actions">
      <el-button icon="Upload" @click="router.push({ name: 'import' })">去导入</el-button>
    </Teleport>

    <el-tabs v-model="tab" type="card" class="project-tabs">
      <el-tab-pane label="已结算" name="settled">
        <SettledProjectsTable />
      </el-tab-pane>
      <el-tab-pane label="未结算" name="unsettled" lazy>
        <UnsettledProjectsTable />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
/* 卡片式 Tab：放大、带边框；未选中浅灰底，选中白底 + 蓝色顶边，一眼能分清 */
.project-tabs {
  --el-tabs-header-height: 52px;
}
.project-tabs :deep(.el-tabs__header) {
  margin-bottom: 16px;
}
.project-tabs :deep(.el-tabs__nav) {
  border: 1px solid var(--el-border-color);
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  overflow: hidden;
}
.project-tabs :deep(.el-tabs__item) {
  min-width: 140px;
  padding: 0 32px;
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-regular);
  background: #e9edf3;
  border-left: 1px solid var(--el-border-color) !important;
  border-top: 3px solid transparent;
}
.project-tabs :deep(.el-tabs__item:first-child) {
  border-left: none !important;
}
.project-tabs :deep(.el-tabs__item:hover) {
  color: var(--el-color-primary);
  background: #f2f5fa;
}
.project-tabs :deep(.el-tabs__item.is-active) {
  color: var(--el-color-primary);
  background: #fff;
  border-top-color: var(--el-color-primary);
}
.project-tabs :deep(.el-tabs--card > .el-tabs__header) {
  border-bottom-color: var(--el-border-color);
}
</style>