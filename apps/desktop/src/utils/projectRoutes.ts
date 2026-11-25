import { computed } from 'vue';
import { useRoute } from 'vue-router';

/**
 * 「正在结算中」与「存档」共用批次 → 合同 → 项目三个页面组件，两边结构完全一致：
 * 存档页由路由 meta.sealed = true 标识，页面整体只读（隐藏所有新增 / 编辑 / 删除 / 上传入口），层级跳转走存档自己的路由名。
 * 只读只是界面层的约束；后端对存档批次同样拒绝一切写操作（409 BATCH_SEALED）。
 */
export function useProjectRoutes() {
  const route = useRoute();
  /** 当前是否在存档页（只读） */
  const sealed = computed(() => route.meta.sealed === true);
  /** 层级路由名：批次列表 / 合同列表 / 项目列表 */
  const names = computed(() =>
    sealed.value
      ? { batches: 'archive-batches', contracts: 'archive-contracts', projects: 'archive-projects' }
      : { batches: 'batches', contracts: 'contracts', projects: 'projects' }
  );
  /** 面包屑第一级的名称 */
  const rootLabel = computed(() => (sealed.value ? '存档' : '正在结算中'));
  return { sealed, names, rootLabel };
}
