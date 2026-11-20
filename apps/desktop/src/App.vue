<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '@/api';
import { useBaseStore } from '@/stores/base';

const route = useRoute();
const base = useBaseStore();

const ready = ref(false);
const failed = ref(false);

/** 等待本地后端（sidecar）就绪，最多重试约 15 秒 */
async function waitForBackend(): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await api.health()).ok) return true;
    } catch {
      /* 后端尚未启动 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function boot() {
  failed.value = false;
  ready.value = false;
  if (await waitForBackend()) {
    await base.loadAll();
    ready.value = true;
  } else {
    failed.value = true;
  }
}

onMounted(boot);

const menus = [
  { path: '/overview', title: '总览', icon: 'DataBoard' },
  { path: '/transactions', title: '记账流水', icon: 'Tickets' },
  { path: '/accounts', title: '账户管理', icon: 'Wallet' },
  { path: '/import', title: 'Excel 导入', icon: 'Upload' }
];
</script>

<template>
  <el-container style="height: 100%">
    <el-aside width="200px" style="background: #1f2d3d">
      <div style="color: #fff; font-size: 18px; font-weight: 600; padding: 20px 16px">财务管理</div>
      <el-menu :default-active="route.path" router background-color="#1f2d3d" text-color="#bfcbd9" active-text-color="#409eff">
        <el-menu-item v-for="m in menus" :key="m.path" :index="m.path">
          <el-icon><component :is="m.icon" /></el-icon>
          <span>{{ m.title }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header style="background: #fff; display: flex; align-items: center; border-bottom: 1px solid #e4e7ed">
        <b>{{ route.meta.title }}</b>
      </el-header>
      <el-main>
        <el-result v-if="failed" icon="error" title="无法连接本地服务" sub-title="后端服务未能启动，请重启应用">
          <template #extra><el-button type="primary" @click="boot">重试</el-button></template>
        </el-result>
        <div v-else-if="!ready" v-loading="true" style="height: 300px" element-loading-text="正在启动本地服务..." />
        <router-view v-else />
      </el-main>
    </el-container>
  </el-container>
</template>
