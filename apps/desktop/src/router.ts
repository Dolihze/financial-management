import { createRouter, createWebHashHistory } from 'vue-router';

// Tauri 打包后使用 file/自定义协议，hash 路由最稳妥
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/overview' },
    { path: '/overview', name: 'overview', component: () => import('@/views/OverviewView.vue'), meta: { title: '总览' } },
    { path: '/projects', name: 'projects', component: () => import('@/views/ProjectsView.vue'), meta: { title: '项目管理', menu: '/projects' } },
    {
      path: '/projects/:id',
      name: 'project-detail',
      component: () => import('@/views/ProjectDetailView.vue'),
      meta: { title: '项目详情', menu: '/projects' }
    },
    { path: '/transactions', name: 'transactions', component: () => import('@/views/TransactionsView.vue'), meta: { title: '记账流水' } },
    { path: '/accounts', name: 'accounts', component: () => import('@/views/AccountsView.vue'), meta: { title: '账户管理' } },
    { path: '/import', name: 'import', component: () => import('@/views/ImportView.vue'), meta: { title: 'Excel 导入' } }
  ]
});
