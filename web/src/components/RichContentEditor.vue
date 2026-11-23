<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import { icons } from '@/icons';
import {
  CONTENT_HTML_LIMIT,
  CONTENT_TEXT_LIMIT,
  contentHtmlToText,
  safeContentLink,
  sanitizeContentHtml,
} from '@/utils/content';

const props = defineProps<{
  modelValue: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  'text-change': [value: string];
}>();

const linkOpen = ref(false);
const linkUrl = ref('');
const linkError = ref('');

const plainLength = computed(() => contentHtmlToText(sanitizeContentHtml(props.modelValue)).length);
const htmlTooLarge = computed(() => props.modelValue.length > CONTENT_HTML_LIMIT);
const invalid = computed(() => plainLength.value > CONTENT_TEXT_LIMIT || htmlTooLarge.value);

const editor = useEditor({
  extensions: [
    StarterKit.configure({
      heading: false,
      codeBlock: false,
      code: false,
      horizontalRule: false,
      link: {
        openOnClick: false,
        protocols: ['http', 'https', 'mailto'],
        isAllowedUri: (value) => safeContentLink(value) !== null,
      },
    }),
  ],
  content: sanitizeContentHtml(props.modelValue),
  editable: !props.disabled,
  editorProps: {
    attributes: {
      role: 'textbox',
      'aria-label': '提醒内容',
      'aria-multiline': 'true',
      class: 'rich-content rich-editor-surface',
    },
    transformPastedHTML: sanitizeContentHtml,
  },
  onUpdate({ editor: instance }) {
    const html = sanitizeContentHtml(instance.getHTML());
    emit('update:modelValue', html);
    emit('text-change', contentHtmlToText(html));
  },
});

watch(
  () => props.modelValue,
  (value) => {
    const instance = editor.value;
    if (!instance) return;
    const clean = sanitizeContentHtml(value);
    if (sanitizeContentHtml(instance.getHTML()) !== clean) {
      instance.commands.setContent(clean, { emitUpdate: false });
    }
  },
);

watch(
  () => props.disabled,
  (val) => {
    editor.value?.setEditable(!val);
  },
);

onBeforeUnmount(() => {
  editor.value?.destroy();
});

const formatTools = computed(() => [
  { label: '加粗', icon: icons.bold, active: editor.value?.isActive('bold'), run: () => editor.value?.chain().focus().toggleBold().run() },
  { label: '斜体', icon: icons.italic, active: editor.value?.isActive('italic'), run: () => editor.value?.chain().focus().toggleItalic().run() },
  { label: '下划线', icon: icons.underline, active: editor.value?.isActive('underline'), run: () => editor.value?.chain().focus().toggleUnderline().run() },
  { label: '删除线', icon: icons.strike, active: editor.value?.isActive('strike'), run: () => editor.value?.chain().focus().toggleStrike().run() },
  { label: '无序列表', icon: icons.bulletList, active: editor.value?.isActive('bulletList'), run: () => editor.value?.chain().focus().toggleBulletList().run() },
  { label: '有序列表', icon: icons.orderedList, active: editor.value?.isActive('orderedList'), run: () => editor.value?.chain().focus().toggleOrderedList().run() },
  { label: '引用', icon: icons.quote, active: editor.value?.isActive('blockquote'), run: () => editor.value?.chain().focus().toggleBlockquote().run() },
]);

function openLinkEditor(): void {
  editor.value?.chain().focus().extendMarkRange('link').run();
  linkUrl.value = String(editor.value?.getAttributes('link').href ?? '');
  linkError.value = '';
  linkOpen.value = true;
}

function applyLink(): void {
  const href = safeContentLink(linkUrl.value.trim());
  if (!href) {
    linkError.value = '请输入完整的 http、https 或 mailto 地址';
    return;
  }
  if (editor.value?.state.selection.empty) {
    editor.value
      .chain()
      .focus()
      .insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] })
      .run();
  } else {
    editor.value?.chain().focus().setLink({ href }).run();
  }
  linkOpen.value = false;
}

function removeLink(): void {
  editor.value?.chain().focus().extendMarkRange('link').unsetLink().run();
  linkOpen.value = false;
}
</script>

<template>
  <div class="rich-editor" :class="{ 'rich-editor--invalid': invalid }">
    <div class="rich-toolbar" role="toolbar" aria-label="文本格式">
      <q-btn
        v-for="tool in formatTools"
        :key="tool.label"
        flat
        dense
        round
        size="sm"
        class="tool-btn"
        :class="{ 'tool-btn--active': tool.active }"
        :icon="tool.icon"
        :aria-label="tool.label"
        :disable="disabled || !editor"
        @mousedown.prevent
        @click="tool.run"
      >
        <q-tooltip>{{ tool.label }}</q-tooltip>
      </q-btn>

      <q-separator vertical inset class="q-mx-xs" />

      <q-btn
        flat
        dense
        round
        size="sm"
        class="tool-btn"
        :class="{ 'tool-btn--active': editor?.isActive('link') }"
        :icon="icons.link"
        aria-label="链接"
        :disable="disabled || !editor"
        @mousedown.prevent
        @click="openLinkEditor"
      >
        <q-tooltip>插入 / 编辑链接</q-tooltip>
      </q-btn>
      <q-btn
        flat
        dense
        round
        size="sm"
        class="tool-btn"
        :icon="icons.clearFormat"
        aria-label="清除格式"
        :disable="disabled || !editor"
        @mousedown.prevent
        @click="editor?.chain().focus().unsetAllMarks().clearNodes().run()"
      >
        <q-tooltip>清除格式</q-tooltip>
      </q-btn>

      <q-separator vertical inset class="q-mx-xs" />

      <q-btn
        flat
        dense
        round
        size="sm"
        class="tool-btn"
        :icon="icons.undo"
        aria-label="撤销"
        :disable="disabled || !editor?.can().undo()"
        @mousedown.prevent
        @click="editor?.chain().focus().undo().run()"
      >
        <q-tooltip>撤销</q-tooltip>
      </q-btn>
      <q-btn
        flat
        dense
        round
        size="sm"
        class="tool-btn"
        :icon="icons.redo"
        aria-label="重做"
        :disable="disabled || !editor?.can().redo()"
        @mousedown.prevent
        @click="editor?.chain().focus().redo().run()"
      >
        <q-tooltip>重做</q-tooltip>
      </q-btn>
    </div>

    <div v-if="linkOpen" class="link-bar">
      <q-input
        v-model="linkUrl"
        dense
        outlined
        type="url"
        placeholder="https://example.com"
        class="col"
        :disable="disabled"
        @keydown.enter.prevent="applyLink"
        @keydown.esc.prevent="linkOpen = false"
      />
      <q-btn flat dense round color="primary" :icon="icons.check" aria-label="应用链接" @click="applyLink" />
      <q-btn flat dense round color="negative" :icon="icons.unlink" aria-label="移除链接" @click="removeLink" />
      <q-btn flat dense round :icon="icons.close" aria-label="取消" @click="linkOpen = false" />
    </div>
    <div v-if="linkOpen && linkError" class="link-error">{{ linkError }}</div>

    <EditorContent :editor="editor" class="editor-host" />

    <div class="editor-footer" :class="{ 'text-negative': invalid }">
      <span v-if="htmlTooLarge">富文本格式过多，请精简</span>
      <span v-else class="text-faint">通知发送时会自动转换为纯文本</span>
      <span>{{ plainLength }} / {{ CONTENT_TEXT_LIMIT }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.rich-editor {
  border: 1px solid var(--app-border-strong);
  border-radius: var(--app-radius-sm);
  background: var(--app-surface);
  overflow: hidden;
  transition: border-color 0.15s;

  &:focus-within {
    border-color: var(--q-primary);
  }
}
.rich-editor--invalid {
  border-color: var(--q-negative);
}
.rich-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  background: var(--app-surface-2);
  border-bottom: 1px solid var(--app-border);
  flex-wrap: wrap;
}
.tool-btn {
  flex: 0 0 auto;
  min-width: 34px;
  min-height: 34px;
  color: var(--app-text-2);
}
.tool-btn--active {
  background: var(--app-selected);
  color: var(--q-primary);
}
.link-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: var(--app-surface-2);
  border-bottom: 1px solid var(--app-border);
}
.link-error {
  padding: 0 10px 8px;
  font-size: 12px;
  color: var(--q-negative);
  background: var(--app-surface-2);
  border-bottom: 1px solid var(--app-border);
}
.editor-host {
  :deep(.ProseMirror) {
    min-height: 120px;
    max-height: 280px;
    overflow-y: auto;
    padding: 12px;
    outline: none;
    color: var(--app-text);
  }
}
.editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--app-text-3);
  border-top: 1px solid var(--app-border);
  background: var(--app-surface-2);
}
</style>
