<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { icons } from '@/icons';
import { GITHUB_REPO_LABEL, GITHUB_REPO_URL } from '@/constants/project';
import ThemeToggle from '@/components/ThemeToggle.vue';
import { useResponsive, notifyError } from '@/composables/useResponsive';
import { confirmDialog } from '@/composables/dialogs';
import { tabbarHidden } from '@/composables/layoutState';
import { useAuthStore } from '@/stores/auth';
import { useSettingsStore } from '@/stores/settings';

const { isMobile } = useResponsive();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const settings = useSettingsStore();

const MINI_KEY = 'tickbell-drawer-mini';
const drawerOpen = ref(true);
const mini = ref(localStorage.getItem(MINI_KEY) === '1');
watch(mini, (value) => localStorage.setItem(MINI_KEY, value ? '1' : '0'));

const nav = [
  { name: 'reminders', label: '提醒', icon: icons.alarm },
  { name: 'channels', label: '渠道', icon: icons.notifications },
  { name: 'deliveries', label: '日志', icon: icons.history },
  { name: 'settings', label: '设置', icon: icons.settings },
] as const;

const title = computed(() => route.meta.title ?? 'TickBell');

// 进入主框架后预加载全局时区（提醒编辑器、设置页都要用）
settings.load().catch(() => undefined);

async function logout(): Promise<void> {
  const ok = await confirmDialog({ title: '退出登录', message: '确定退出当前账号吗？', okLabel: '退出' });
  if (!ok) return;
  try {
    await auth.logout();
  } catch (error) {
    notifyError(error, '退出失败');
  }
  await router.replace({ name: 'login' });
}
</script>

<template>
  <q-layout view="hHh LpR fFf" class="main-layout">
    <q-header class="app-header">
      <q-toolbar class="app-toolbar">
        <template v-if="!isMobile">
          <q-btn flat round class="touch-44" :icon="mini ? icons.menu : icons.menuOpen" :aria-label="mini ? '展开菜单' : '折叠菜单'" @click="mini = !mini" />
          <div class="brand">
            <span class="brand-mark"><q-icon :name="icons.notificationsActive" size="20px" /></span>
            <span class="brand-name">TickBell</span>
          </div>
          <q-separator vertical inset class="q-mx-md" />
        </template>
        <q-toolbar-title class="app-title">{{ title }}</q-toolbar-title>
        <ThemeToggle />
        <q-btn v-if="!isMobile" flat no-caps class="q-ml-xs" :icon="icons.logout" label="退出" @click="logout" />
      </q-toolbar>
    </q-header>

    <q-drawer
      v-if="!isMobile"
      v-model="drawerOpen"
      show-if-above
      behavior="desktop"
      :mini="mini"
      :width="220"
      :mini-width="72"
      class="app-drawer"
    >
      <div class="drawer-inner">
        <q-list class="nav-list">
          <q-item
            v-for="item in nav"
            :key="item.name"
            :to="{ name: item.name }"
            clickable
            v-ripple
            class="nav-item"
            active-class="nav-item--active"
          >
            <q-item-section avatar><q-icon :name="item.icon" size="22px" /></q-item-section>
            <q-item-section>{{ item.label }}</q-item-section>
            <q-tooltip v-if="mini" anchor="center right" self="center left" :offset="[8, 0]">{{ item.label }}</q-tooltip>
          </q-item>
        </q-list>

        <div class="drawer-footer">
          <q-item
            tag="a"
            :href="GITHUB_REPO_URL"
            target="_blank"
            rel="noopener noreferrer"
            clickable
            v-ripple
            class="nav-item drawer-github"
            :aria-label="`GitHub 仓库 ${GITHUB_REPO_LABEL}`"
          >
            <q-item-section avatar><q-icon :name="icons.github" size="20px" /></q-item-section>
            <q-item-section>GitHub</q-item-section>
            <q-tooltip anchor="center right" self="center left" :offset="[8, 0]">{{ GITHUB_REPO_LABEL }}</q-tooltip>
          </q-item>
        </div>
      </div>
    </q-drawer>

    <q-footer v-if="isMobile && !tabbarHidden" class="app-tabbar">
      <nav class="tabbar" aria-label="主导航">
        <router-link
          v-for="item in nav"
          :key="item.name"
          :to="{ name: item.name }"
          class="tabbar-item"
          active-class="tabbar-item--active"
          v-ripple
        >
          <q-icon :name="item.icon" size="24px" />
          <span>{{ item.label }}</span>
        </router-link>
      </nav>
    </q-footer>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<style scoped lang="scss">
.app-header {
  background: var(--app-surface);
  color: var(--app-text);
  border-bottom: 1px solid var(--app-border);
  padding-top: var(--safe-top);
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
}
.app-toolbar {
  min-height: var(--app-header-h);
  gap: 4px;
}
.app-title {
  font-size: 17px;
  font-weight: 600;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: 4px;
  .brand-mark {
    width: 32px;
    height: 32px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: var(--q-primary);
    color: #fff;
  }
  .brand-name {
    font-weight: 650;
    font-size: 16px;
  }
}
.app-drawer {
  :deep(.q-drawer) {
    background: var(--app-surface);
    border-right: 1px solid var(--app-border);
  }
  :deep(.q-drawer__content) {
    height: 100%;
  }
}
.drawer-inner {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.nav-list {
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.drawer-footer {
  margin-top: auto;
  padding: 10px;
  border-top: 1px solid var(--app-border);
}
.drawer-github {
  text-decoration: none;
  color: var(--app-text-3);
  &:hover {
    color: var(--app-text);
  }
}
.nav-item {
  border-radius: 10px;
  min-height: 46px;
  color: var(--app-text-2);
  font-weight: 550;
  :deep(.q-item__section--avatar) {
    min-width: 40px;
  }
}
.nav-item--active {
  background: var(--app-selected);
  color: var(--q-primary);
}

.app-tabbar {
  background: var(--app-surface);
  color: var(--app-text-2);
  border-top: 1px solid var(--app-border);
  padding-bottom: var(--safe-bottom);
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
}
.tabbar {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  height: var(--app-tabbar-h);
}
.tabbar-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 44px;
  color: var(--app-text-3);
  text-decoration: none;
  font-size: 11.5px;
  font-weight: 550;
}
.tabbar-item--active {
  color: var(--q-primary);
}
</style>
