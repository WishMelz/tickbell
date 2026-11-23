<script setup lang="ts">
import { computed } from 'vue';
import { icons } from '@/icons';
import { THEME_OPTIONS, useThemeStore, type ThemeMode } from '@/stores/theme';

const theme = useThemeStore();
const iconFor: Record<ThemeMode, string> = { light: icons.themeLight, dark: icons.themeDark, auto: icons.themeAuto };
const current = computed(() => THEME_OPTIONS.find((o) => o.value === theme.mode)?.label ?? '');
</script>

<template>
  <q-btn flat round class="touch-44" :icon="iconFor[theme.mode]" :aria-label="`主题：${current}，点击切换`">
    <q-menu anchor="bottom right" self="top right" class="theme-menu" auto-close>
      <q-list style="min-width: 160px">
        <q-item
          v-for="option in THEME_OPTIONS"
          :key="option.value"
          clickable
          :active="theme.mode === option.value"
          active-class="text-primary"
          style="min-height: 44px"
          @click="theme.setMode(option.value)"
        >
          <q-item-section avatar style="min-width: 36px"><q-icon :name="iconFor[option.value]" /></q-item-section>
          <q-item-section>{{ option.label }}</q-item-section>
          <q-item-section v-if="theme.mode === option.value" side><q-icon :name="icons.check" color="primary" /></q-item-section>
        </q-item>
      </q-list>
    </q-menu>
  </q-btn>
</template>
