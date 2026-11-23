import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { Dark, Dialog, Notify, Quasar } from 'quasar';
import quasarLang from 'quasar/lang/zh-CN';
import quasarIconSet from 'quasar/icon-set/svg-material-symbols-outlined';

import 'quasar/src/css/index.sass';
import './css/app.scss';

import App from './App.vue';
import { router } from './router';
import { onUnauthorized } from './api';
import { useAuthStore } from './stores/auth';
import { useThemeStore } from './stores/theme';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(Quasar, {
  plugins: { Dark, Dialog, Notify },
  lang: quasarLang,
  iconSet: quasarIconSet,
  config: {
    dark: 'auto',
    notify: { position: 'top', timeout: 3000, progress: false },
  },
});
app.use(router);

useThemeStore(pinia).init();

// 任意接口返回 401：清空登录态并回到登录页（登录 / 状态接口除外，见 api/http.ts）
let redirecting = false;
onUnauthorized(() => {
  const auth = useAuthStore(pinia);
  auth.clear();
  const current = router.currentRoute.value;
  if (redirecting || current.name === 'login') return;
  redirecting = true;
  Notify.create({ type: 'warning', message: '登录已失效，请重新登录' });
  void router.replace({ name: 'login', query: { redirect: current.fullPath } }).finally(() => {
    redirecting = false;
  });
});

app.mount('#app');
