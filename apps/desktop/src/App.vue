<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api, getBackendError, getLogPath, resolveBackendBase, revealLog, setBaseUrl, waitBackendReady } from '@/api';
import { useBaseStore } from '@/stores/base';

const route = useRoute();
const base = useBaseStore();

const ready = ref(false);
const failed = ref(false);
const failMessage = ref('后端服务未能启动，请重启应用');
/** 后端日志文件路径（发布版才有），失败页展示给用户，方便把日志发给开发者 */
const logPath = ref<string | null>(null);

async function openLog() {
  try {
    await revealLog();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

/**
 * 启动流程：
 * 1. 向 Tauri 取后端地址（发布版端口是随机的）
 * 2. 等 Rust 发出 backend-ready 事件（端口可连接）
 * 3. 再用 /api/health 确认 HTTP 层真的可用（端口通不等于 Fastify 已完成路由注册）
 */
async function boot() {
  failed.value = false;
  ready.value = false;
  try {
    setBaseUrl(await resolveBackendBase());
    if (!(await waitBackendReady())) {
      // 优先显示 Rust 侧记录的真实原因（进程提前退出、文件缺失、端口被拦截等）
      throw new Error((await getBackendError()) ?? '等待后端启动超时，请检查后端日志');
    }
    // 端口就绪后 HTTP 层几乎立刻可用，这里只做短重试兜底
    for (let i = 0; ; i++) {
      try {
        if ((await api.health()).ok) break;
      } catch (e) {
        if (i >= 10) throw e;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    await base.loadAll();
    ready.value = true;
  } catch (e) {
    failMessage.value = e instanceof Error ? e.message : String(e);
    logPath.value = await getLogPath();
    failed.value = true;
  }
}

onMounted(boot);

const menus = [
  { path: '/overview', title: '总览', icon: 'DataBoard' },
  { path: '/projects', title: '项目管理', icon: 'Briefcase' },
  { path: '/transactions', title: '记账流水', icon: 'Tickets' },
  { path: '/accounts', title: '账户管理', icon: 'Wallet' },
  { path: '/import', title: 'Excel 导入', icon: 'Upload' }
];
</script>

<template>
  <el-container style="height: 100%">
    <el-aside width="200px" style="background: #1f2d3d">
      <div style="color: #fff; font-size: 20px; font-weight: 600; padding: 20px 16px">财务管理</div>
      <el-menu :default-active="(route.meta.menu as string | undefined) ?? route.path" router background-color="#1f2d3d" text-color="#bfcbd9" active-text-color="#409eff">
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
        <el-result v-if="failed" icon="error" title="无法连接本地服务" :sub-title="failMessage">
          <template #extra>
            <el-button type="primary" @click="boot">重试</el-button>
            <el-button v-if="logPath" @click="openLog">打开日志位置</el-button>
            <div v-if="logPath" class="log-path">日志文件：{{ logPath }}</div>
          </template>
        </el-result>
        <div v-else-if="!ready" v-loading="true" style="height: 300px" element-loading-text="正在启动本地服务..." />
        <router-view v-else />
      </el-main>
    </el-container>
  </el-container>
</template>
