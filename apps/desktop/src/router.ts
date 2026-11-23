import { createRouter, createWebHashHistory } from 'vue-router';

// Tauri 打包后使用 file/自定义协议，hash 路由最稳妥
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/overview' },
    { path: '/overview', name: 'overview', component: () => import('@/views/OverviewView.vue'), meta: { title: '总览' } },
    // 「项目管理」是二级菜单：合同管理 / 项目进度。/projects 本身重定向到项目进度
    { path: '/projects', redirect: '/projects/progress' },
    // 注意：静态路径 contracts / progress 必须写在 /projects/:id 之前，否则会被当成项目 id
    {
      path: '/projects/contracts',
      name: 'contracts',
      component: () => import('@/views/ContractsView.vue'),
      meta: { title: '合同管理', menu: '/projects/contracts' }
    },
    {
      path: '/projects/contracts/:id',
      name: 'contract-detail',
      component: () => import('@/views/ContractDetailView.vue'),
      meta: { title: '合同详情', menu: '/projects/contracts' }
    },
    // 路由名沿用 'projects'：ProjectDetailView / ProjectImportPanel 里的 router.push({ name: 'projects' }) 无需改动
    {
      path: '/projects/progress',
      name: 'projects',
      component: () => import('@/views/ProjectsView.vue'),
      meta: { title: '项目进度', menu: '/projects/progress' }
    },
    {
      path: '/projects/:id',
      name: 'project-detail',
      component: () => import('@/views/ProjectDetailView.vue'),
      meta: { title: '项目详情', menu: '/projects/progress' }
    },
    { path: '/transactions', name: 'transactions', component: () => import('@/views/TransactionsView.vue'), meta: { title: '记账流水' } },
    { path: '/accounts', name: 'accounts', component: () => import('@/views/AccountsView.vue'), meta: { title: '账户管理' } },
    { path: '/import', name: 'import', component: () => import('@/views/ImportView.vue'), meta: { title: 'Excel 导入' } }
  ]
});
