import { createRouter, createWebHashHistory } from 'vue-router';

// Tauri 打包后使用 file/自定义协议，hash 路由最稳妥
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/overview' },
    { path: '/overview', name: 'overview', component: () => import('@/views/OverviewView.vue'), meta: { title: '总览' } },
    // 「项目管理」是多层级结构：批次管理 → 合同管理 → 项目进度（项目详情 / 合同编辑 是各层的子页）。
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
    {
      path: '/projects/batches/:batchId/contracts/:contractId/edit',
      name: 'contract-detail',
      component: () => import('@/views/ContractDetailView.vue'),
      meta: { title: '编辑合同', menu: '/projects' }
    },
    // 项目详情用 /projects/item/:id：与上面的静态路径不会冲突。
    // 带 ?batchId=&contractId= 时，返回按钮回到对应合同的项目进度；否则回到批次管理
    {
      path: '/projects/item/:id',
      name: 'project-detail',
      component: () => import('@/views/ProjectDetailView.vue'),
      meta: { title: '项目详情', menu: '/projects' }
    },
    { path: '/transactions', name: 'transactions', component: () => import('@/views/TransactionsView.vue'), meta: { title: '记账流水' } },
    { path: '/accounts', name: 'accounts', component: () => import('@/views/AccountsView.vue'), meta: { title: '账户管理' } },
    { path: '/import', name: 'import', component: () => import('@/views/ImportView.vue'), meta: { title: 'Excel 导入' } }
  ]
});
