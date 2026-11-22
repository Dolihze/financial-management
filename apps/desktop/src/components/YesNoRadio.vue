<script setup lang="ts">
/**
 * 「是 / 否」单选：两个互斥的 radio，始终有且只有一个被选中。
 *
 * 可选的切换确认：传入 confirm 函数后，用户点击切换时先调用它，返回 true 才真正改值；
 * 返回 false（用户取消）时保持原值，radio 选中状态不变。
 * el-radio 没有 before-change 钩子，所以这里不直接 v-model 绑定，而是拦截点击。
 */
const props = defineProps<{
  /** 切换前的确认；参数是目标值（true=是，false=否） */
  confirm?: (next: boolean) => Promise<boolean> | boolean;
}>();
const model = defineModel<boolean>({ required: true });

async function onSelect(next: boolean) {
  if (next === model.value) return;
  if (props.confirm && !(await props.confirm(next))) return; // 取消：不改值
  model.value = next;
}
</script>

<template>
  <el-radio-group :model-value="model" class="yes-no" @update:model-value="(v: unknown) => onSelect(v === true)">
    <el-radio :value="true">是</el-radio>
    <el-radio :value="false">否</el-radio>
  </el-radio-group>
</template>

<style scoped>
/* el-radio 默认右外边距 32px，收紧两个选项之间的距离 */
.yes-no :deep(.el-radio) {
  margin-right: 12px;
}
.yes-no :deep(.el-radio:last-child) {
  margin-right: 0;
}
</style>
