import { createPinia } from 'pinia';
import ElementPlus, { ElMessageBox } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import 'element-plus/dist/index.css';
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import './styles.css';

// 全局让 ElMessageBox（confirm / alert / prompt）默认可拖动；el-dialog 在各处单独加 draggable。
// ElMessageBox 没有全局默认配置，因此这里包装 alert/confirm/prompt 的 options 参数。
for (const kind of ['alert', 'confirm', 'prompt'] as const) {
  const origin = ElMessageBox[kind] as (...args: any[]) => Promise<unknown>;
  (ElMessageBox as any)[kind] = (message: unknown, title?: unknown, options?: unknown, ...rest: unknown[]) => {
    if (title && typeof title === 'object') return origin(message, { draggable: true, ...(title as object) }, options, ...rest);
    return origin(message, title, { draggable: true, ...((options as object) ?? {}) }, ...rest);
  };
}

const app = createApp(App);
for (const [name, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(name, component);
}
app.use(createPinia()).use(router).use(ElementPlus, { locale: zhCn }).mount('#app');
