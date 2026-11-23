<script setup lang="ts">
import { computed, watchEffect } from 'vue';
import { useQuasar } from 'quasar';

const $q = useQuasar();
const mobile = computed(() => $q.screen.lt.md);

// 把 mobile / desktop 类放在 body 上：QDialog、QMenu 等会 teleport 到 body，也要继承移动端样式（输入框 16px 等）
watchEffect(() => {
  document.body.classList.toggle('mobile', mobile.value);
  document.body.classList.toggle('desktop', !mobile.value);
});
</script>

<template>
  <router-view />
</template>
