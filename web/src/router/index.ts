import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

declare module 'vue-router' {
  interface RouteMeta {
    title?: string;
    public?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/pages/LoginPage.vue'),
    meta: { title: '登录', public: true },
  },
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    children: [
      { path: '', redirect: { name: 'reminders' } },
      { path: 'reminders', name: 'reminders', component: () => import('@/pages/RemindersPage.vue'), meta: { title: '提醒' } },
      { path: 'channels', name: 'channels', component: () => import('@/pages/ChannelsPage.vue'), meta: { title: '通知渠道' } },
      { path: 'deliveries', name: 'deliveries', component: () => import('@/pages/DeliveriesPage.vue'), meta: { title: '发送日志' } },
      { path: 'settings', name: 'settings', component: () => import('@/pages/SettingsPage.vue'), meta: { title: '系统设置' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: { name: 'reminders' } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.checked) {
    try {
      await auth.ensureStatus();
    } catch {
      // 后端不可用：公开页面照常进入，其他页面去登录页（登录页会显示错误并允许重试）
      if (!to.meta.public) return { name: 'login', query: { redirect: to.fullPath } };
      return true;
    }
  }
  if (to.meta.public) {
    if (to.name === 'login' && auth.authenticated) {
      const redirect = typeof to.query.redirect === 'string' && to.query.redirect.startsWith('/') ? to.query.redirect : '/reminders';
      return redirect;
    }
    return true;
  }
  if (!auth.authenticated) return { name: 'login', query: to.fullPath && to.fullPath !== '/' ? { redirect: to.fullPath } : {} };
  return true;
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · TickBell` : 'TickBell';
});
