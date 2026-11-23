import { createRouter, createWebHashHistory } from 'vue-router';

// Tauri 打包后使用 file/自定义协议，hash 路由最稳妥
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/overview' },
    { path: '/overview', name: 'overview', component: () => import('@/views/OverviewView.vue'), meta: { title: '总览' } },
    // 「项目管理」是多层级结构：批次管理 → 合同管理 → 项目进度（编辑项目是项目进度页里的弹窗）。
    // 菜单只有「项目管理」一项，所有层级页面都用 meta.menu 指向它来高亮。
    { path: '/projects', redirect: '/projects/batches' },
    {
      path: '/projects/batches',
      name: 'batches',
      component: () => import('@/views/BatchesView.vue'),
      meta: { title: '批次管理', menu: '/projects' }
    },
    {
      path: '/projects/batches/:batchId',
      name: 'contracts',
      component: () => import('@/views/ContractsView.vue'),
      meta: { title: '合同管理', menu: '/projects' }
    },
    {
      path: '/projects/batches/:batchId/contracts/:contractId',
      name: 'projects',
      component: () => import('@/views/ProjectsView.vue'),
      meta: { title: '项目进度', menu: '/projects' }
    },
    { path: '/transactions', name: 'transactions', component: () => import('@/views/TransactionsView.vue'), meta: { title: '记账流水' } },
    { path: '/accounts', name: 'accounts', component: () => import('@/views/AccountsView.vue'), meta: { title: '账户管理' } },
    { path: '/import', name: 'import', component: () => import('@/views/ImportView.vue'), meta: { title: 'Excel 导入' } }
  ]
});
