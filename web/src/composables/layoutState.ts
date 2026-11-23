import { ref } from 'vue';

/** 布局级共享状态：移动端多选时隐藏底部标签栏，让批量操作栏占据底部 */
export const tabbarHidden = ref(false);
