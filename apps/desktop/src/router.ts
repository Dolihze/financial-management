import { createRouter, createWebHashHistory } from 'vue-router';

// Tauri 打包后使用 file/自定义协议，hash 路由最稳妥
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/overview' },
    { path: '/overview', name: 'overview', component: () => import('@/views/OverviewView.vue'), meta: { title: '总览' } },
    // 「项目管理」是二级菜单：正在结算中 / 未结算项目 / 存档。
    // 正在结算中是多层级结构：批次管理 → 合同管理 → 项目进度（编辑项目是项目进度页里的弹窗），
    // 其所有层级页面都用 meta.menu 指向 /projects/settled 来高亮「正在结算中」。
    // 存档与它结构完全一致，复用同样三个页面组件，只是 meta.sealed = true（整批只读），菜单高亮「存档」。
    { path: '/projects', redirect: '/projects/batches' },
    { path: '/projects/settled', redirect: '/projects/batches' },
    {
      path: '/projects/batches',
      name: 'batches',
      component: () => import('@/views/BatchesView.vue'),
      meta: { title: '正在结算中 / 批次管理', menu: '/projects/settled' }
    },
    {
      path: '/projects/batches/:batchId',
      name: 'contracts',
      component: () => import('@/views/ContractsView.vue'),
      meta: { title: '正在结算中 / 合同管理', menu: '/projects/settled' }
    },
    {
      path: '/projects/batches/:batchId/contracts/:contractId',
      name: 'projects',
      component: () => import('@/views/ProjectsView.vue'),
      meta: { title: '正在结算中 / 项目进度', menu: '/projects/settled' }
    },
    {
      path: '/projects/unsettled',
      name: 'unsettled-projects',
      component: () => import('@/views/UnsettledProjectsView.vue'),
      meta: { title: '未结算项目', menu: '/projects/unsettled' }
    },
    {
      path: '/projects/archive',
      name: 'archive-batches',
      component: () => import('@/views/BatchesView.vue'),
      meta: { title: '存档 / 批次管理', menu: '/projects/archive', sealed: true }
    },
    {
      path: '/projects/archive/:batchId',
      name: 'archive-contracts',
      component: () => import('@/views/ContractsView.vue'),
      meta: { title: '存档 / 合同管理', menu: '/projects/archive', sealed: true }
    },
    {
      path: '/projects/archive/:batchId/contracts/:contractId',
      name: 'archive-projects',
      component: () => import('@/views/ProjectsView.vue'),
      meta: { title: '存档 / 项目进度', menu: '/projects/archive', sealed: true }
    },
    { path: '/transactions', name: 'transactions', component: () => import('@/views/TransactionsView.vue'), meta: { title: '记账流水' } },
    { path: '/accounts', name: 'accounts', component: () => import('@/views/AccountsView.vue'), meta: { title: '账户管理' } },
    { path: '/import', name: 'import', component: () => import('@/views/ImportView.vue'), meta: { title: 'Excel 导入' } }
  ]
});
