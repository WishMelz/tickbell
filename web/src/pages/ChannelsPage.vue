<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type ChannelType, type ChannelView, type ProxyView } from '@/api';
import ChannelEditorDialog from '@/components/channels/ChannelEditorDialog.vue';
import { confirmDialog } from '@/composables/dialogs';
import { notifyError, notifySuccess, useResponsive } from '@/composables/useResponsive';
import { channelBrand, icons } from '@/icons';
import { chipClass } from '@/utils/status';
import { formatInstant } from '@/utils/time';
import { useSettingsStore } from '@/stores/settings';

const { isMobile } = useResponsive();
const settings = useSettingsStore();
const loading = ref(true);
const initialized = ref(false);
const channels = ref<ChannelView[]>([]);
const channelTypes = ref<ChannelType[]>([]);
const proxies = ref<ProxyView[]>([]);
const typeFilter = ref('');
const proxiesSupported = computed(() => settings.capabilities.proxies);

const editorOpen = ref(false);
const editingChannel = ref<ChannelView | null>(null);
const testingId = ref<string | null>(null);

const presentTypes = computed(() => {
  const counts = new Map<string, number>();
  for (const ch of channels.value) {
    counts.set(ch.type, (counts.get(ch.type) ?? 0) + 1);
  }
  return [...counts.entries()].map(([t, count]) => ({
    value: t,
    label: channelTypes.value.find((m) => m.type === t)?.name ?? t,
    count,
    brand: channelBrand(t, channelTypes.value.find((m) => m.type === t)?.icon),
  }));
});

const visibleChannels = computed(() =>
  typeFilter.value ? channels.value.filter((c) => c.type === typeFilter.value) : channels.value,
);

const supportedTypesLabel = computed(() => {
  if (!channelTypes.value.length) return '管理多种通知渠道实例，支持独立配置与在线测试。';
  return `已内置 ${channelTypes.value.map((t) => t.name).join('、')}，共 ${channelTypes.value.length} 种渠道。`;
});

async function loadData(silent = false): Promise<void> {
  if (!silent) loading.value = true;
  try {
    await settings.loadCapabilities();
    const [chList, types, proxyList] = await Promise.all([
      api.listChannels(),
      api.channelTypes(),
      settings.capabilities.proxies ? api.listProxies() : Promise.resolve([]),
    ]);
    channels.value = chList;
    channelTypes.value = types;
    proxies.value = proxyList;
    initialized.value = true;
    if (typeFilter.value && !chList.some((c) => c.type === typeFilter.value)) {
      typeFilter.value = '';
    }
  } catch (error) {
    notifyError(error, '加载通知渠道失败');
  } finally {
    if (!silent) loading.value = false;
  }
}

onMounted(() => {
  void loadData();
});

function typeMeta(type: string): ChannelType | undefined {
  return channelTypes.value.find((t) => t.type === type);
}

function openCreate(): void {
  editingChannel.value = null;
  editorOpen.value = true;
}

function openEdit(channel: ChannelView): void {
  editingChannel.value = channel;
  editorOpen.value = true;
}

async function handleTest(channel: ChannelView): Promise<void> {
  testingId.value = channel.id;
  try {
    const res = await api.testChannel(channel.id);
    if (res.ok) {
      notifySuccess(`“${channel.name}”测试发送成功`);
    } else {
      notifyError(res.error || `发送失败（HTTP ${res.httpStatus ?? '未知'}）`);
    }
  } catch (error) {
    notifyError(error, '测试发送失败');
  } finally {
    testingId.value = null;
  }
}

async function handleDelete(channel: ChannelView): Promise<void> {
  const ok = await confirmDialog({
    title: '删除通知渠道',
    message: `确定删除渠道“${channel.name}”吗？如已被提醒或日志引用则无法删除。`,
    okLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteChannel(channel.id);
    channels.value = channels.value.filter((c) => c.id !== channel.id);
    notifySuccess('渠道已删除');
  } catch (error) {
    notifyError(error, '删除渠道失败');
  }
}

async function onPullRefresh(done: () => void): Promise<void> {
  await loadData(true);
  done();
}
</script>

<template>
  <q-page class="app-page">
    <div v-if="!isMobile" class="app-page-head">
      <div>
        <h1>通知渠道</h1>
        <div class="sub">{{ supportedTypesLabel }}</div>
      </div>
      <q-space />
      <q-btn flat round :icon="icons.refresh" aria-label="刷新" :loading="loading" @click="loadData()">
        <q-tooltip>刷新</q-tooltip>
      </q-btn>
      <q-btn unelevated no-caps color="primary" :icon="icons.add" label="新建渠道" @click="openCreate" />
    </div>

    <!-- 当已创建多种类型渠道时展示类型筛选条 -->
    <div v-if="presentTypes.length > 1" class="type-filter-wrap q-mb-md">
      <div class="type-filter" role="tablist" aria-label="按渠道类型筛选">
        <button
          type="button"
          role="tab"
          class="type-tab"
          :class="{ 'type-tab--active': typeFilter === '' }"
          :aria-selected="typeFilter === ''"
          @click="typeFilter = ''"
        >
          <span>全部</span>
          <span class="type-count">{{ channels.length }}</span>
        </button>
        <button
          v-for="item in presentTypes"
          :key="item.value"
          type="button"
          role="tab"
          class="type-tab"
          :class="{ 'type-tab--active': typeFilter === item.value }"
          :aria-selected="typeFilter === item.value"
          @click="typeFilter = item.value"
        >
          <q-icon :name="item.brand.icon" size="15px" :style="{ color: item.brand.color }" />
          <span>{{ item.label }}</span>
          <span class="type-count">{{ item.count }}</span>
        </button>
      </div>
    </div>

    <q-pull-to-refresh :disable="!isMobile" @refresh="onPullRefresh">
      <div v-if="(loading || !initialized) && !channels.length" class="q-py-xl flex flex-center">
        <q-spinner color="primary" size="32px" />
      </div>

      <div v-else-if="!visibleChannels.length" class="empty-state app-card">
        <div class="empty-icon"><q-icon :name="icons.notifications" size="30px" /></div>
        <h3>{{ channels.length ? '该类型下暂无渠道' : '还没有通知渠道' }}</h3>
        <p>支持 Bark、Telegram、企业微信、钉钉、飞书、Server酱与通用 Webhook。</p>
        <q-btn unelevated no-caps color="primary" class="touch-44" :icon="icons.add" label="新建通知渠道" @click="openCreate" />
      </div>

      <div v-else class="channel-grid">
        <div v-for="ch in visibleChannels" :key="ch.id" class="app-card channel-card">
          <div class="ch-head">
            <div
              class="ch-icon"
              :style="{
                color: channelBrand(ch.type, typeMeta(ch.type)?.icon).color,
                background: channelBrand(ch.type, typeMeta(ch.type)?.icon).bg,
              }"
            >
              <q-icon :name="channelBrand(ch.type, typeMeta(ch.type)?.icon).icon" size="21px" />
            </div>
            <div class="ch-title-wrap">
              <div class="ch-name">{{ ch.name }}</div>
              <div class="ch-type text-muted">
                {{ typeMeta(ch.type)?.name ?? ch.type }}
              </div>
            </div>
            <span v-if="!ch.supported" :class="chipClass('warning')">暂不支持的类型</span>
            <span v-else-if="!ch.configured" :class="chipClass('negative')">未配置</span>
            <span v-else-if="ch.enabled" :class="chipClass('positive')">已启用</span>
            <span v-else :class="chipClass('grey')">已停用</span>
          </div>

          <div class="ch-meta text-muted">
            <template v-if="ch.supported && ch.summary?.length">
              <div v-for="line in ch.summary" :key="line.label" class="meta-line">
                {{ line.label }}：{{ line.value }}
              </div>
            </template>
            <div v-if="ch.proxyId && ch.proxyName" class="meta-line" :class="{ 'text-warning': ch.proxyEnabled === false }">
              网络代理：{{ ch.proxyName }}（{{ ch.proxyProtocol?.toUpperCase() }}{{ ch.proxyEnabled === false ? ' · 已停用' : '' }}）
            </div>
            <div v-else-if="!ch.supported" class="meta-line text-warning">
              当前未注册该渠道插件，已保留原配置并强制停用。
            </div>
            <div class="meta-line text-faint">更新于 {{ formatInstant(ch.updatedAt) }}</div>
          </div>

          <div class="ch-actions">
            <q-btn
              v-if="ch.supported"
              flat
              no-caps
              dense
              color="primary"
              class="touch-44"
              :icon="icons.send"
              label="测试"
              :loading="testingId === ch.id"
              :disable="!ch.configured"
              @click="handleTest(ch)"
            />
            <q-btn flat no-caps dense class="touch-44" :icon="icons.edit" label="编辑" @click="openEdit(ch)" />
            <q-space />
            <q-btn flat round dense color="negative" class="touch-44" :icon="icons.delete" aria-label="删除" @click="handleDelete(ch)" />
          </div>
        </div>
      </div>
    </q-pull-to-refresh>

    <q-page-sticky v-if="isMobile" position="bottom-right" :offset="[18, 18]">
      <q-btn fab color="primary" :icon="icons.add" aria-label="新建渠道" @click="openCreate" />
    </q-page-sticky>

    <ChannelEditorDialog
      v-model="editorOpen"
      :channel="editingChannel"
      :channel-types="channelTypes"
      :proxies="proxies"
      :show-proxy="proxiesSupported"
      @saved="loadData(true)"
    />
  </q-page>
</template>

<style scoped lang="scss">
.type-filter-wrap {
  display: flex;
}
.type-filter {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px;
  border-radius: 12px;
  background: var(--app-surface);
  border: 1px solid var(--app-border);
}
.type-tab {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--app-text-2);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
  &:hover {
    background: var(--app-surface-2);
    color: var(--app-text);
  }
}
.type-tab--active {
  background: var(--app-selected);
  color: var(--q-primary);
  font-weight: 600;
  &:hover {
    background: var(--app-selected);
    color: var(--q-primary);
  }
  .type-count {
    background: color-mix(in srgb, var(--q-primary) 16%, transparent);
    color: var(--q-primary);
  }
}
.type-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: var(--app-surface-2);
  color: var(--app-text-3);
}
.channel-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
  @media (max-width: 600px) {
    grid-template-columns: 1fr;
  }
}
.channel-card {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ch-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ch-icon {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: var(--app-selected);
  color: var(--q-primary);
  flex-shrink: 0;
}
.ch-title-wrap {
  flex: 1;
  min-width: 0;
}
.ch-name {
  font-size: 15.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch-type {
  font-size: 12.5px;
}
.ch-meta {
  font-size: 12.5px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 44px;
}
.meta-line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--app-border);
}
</style>
