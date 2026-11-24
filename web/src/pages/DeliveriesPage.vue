<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { QTableColumn } from 'quasar';
import { api, type ChannelView, type DeliveryStatus, type DeliveryView } from '@/api';
import { notifyError, notifySuccess, useResponsive } from '@/composables/useResponsive';
import { icons } from '@/icons';
import { useSettingsStore } from '@/stores/settings';
import { chipClass, DELIVERY_STATUS, DELIVERY_STATUS_OPTIONS } from '@/utils/status';
import { formatInstant } from '@/utils/time';

const route = useRoute();
const router = useRouter();
const { isMobile } = useResponsive();
const settings = useSettingsStore();
const isDemo = computed(() => Boolean(settings.demo?.enabled));

const loading = ref(true);
const initialized = ref(false);
const items = ref<DeliveryView[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const channels = ref<ChannelView[]>([]);

const reminderId = ref(typeof route.query.reminderId === 'string' ? route.query.reminderId : '');
const channelId = ref('');
const status = ref<DeliveryStatus | ''>('');

const retryingId = ref<string | null>(null);
const detailItem = ref<DeliveryView | null>(null);

const columns: QTableColumn<DeliveryView>[] = [
  { name: 'reminder', label: '提醒', field: 'reminderTitle', align: 'left' },
  { name: 'channel', label: '渠道', field: 'channelName', align: 'left' },
  { name: 'status', label: '状态', field: 'status', align: 'left' },
  { name: 'attempts', label: '尝试', field: 'attempts', align: 'center' },
  { name: 'time', label: '计划 / 创建时间', field: 'createdAt', align: 'left' },
  { name: 'error', label: '说明', field: 'error', align: 'left' },
  { name: 'actions', label: '操作', field: 'id', align: 'right' },
];

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const hasMoreMobile = computed(() => items.value.length < total.value);

async function loadChannels(): Promise<void> {
  try {
    channels.value = await api.listChannels();
  } catch {
    // 渠道筛选辅助，不阻塞日志加载
  }
}

async function loadPage(append = false, silent = false): Promise<void> {
  if (!silent) loading.value = true;
  try {
    const res = await api.listDeliveries({
      reminderId: reminderId.value || undefined,
      channelId: channelId.value || undefined,
      status: status.value || undefined,
      page: page.value,
      pageSize: pageSize.value,
    });
    items.value = append ? [...items.value, ...res.items] : res.items;
    total.value = res.total;
    initialized.value = true;
  } catch (error) {
    notifyError(error, '加载发送日志失败');
  } finally {
    if (!silent) loading.value = false;
  }
}

watch(
  () => route.query.reminderId,
  (val) => {
    const next = typeof val === 'string' ? val : '';
    if (next !== reminderId.value) {
      reminderId.value = next;
      page.value = 1;
      void loadPage(false);
    }
  },
);

watch([channelId, status], () => {
  page.value = 1;
  void loadPage(false);
});

onMounted(() => {
  void loadChannels();
  void loadPage(false);
});

function clearReminderFilter(): void {
  reminderId.value = '';
  page.value = 1;
  void router.replace({ name: 'deliveries' });
  void loadPage(false);
}

function goPage(nextPage: number): void {
  page.value = nextPage;
  void loadPage(false);
}

function loadMoreMobile(): void {
  if (loading.value || !hasMoreMobile.value) return;
  page.value += 1;
  void loadPage(true);
}

async function handleRetry(row: DeliveryView): Promise<void> {
  retryingId.value = row.id;
  try {
    const updated = await api.retryDelivery(row.id);
    const idx = items.value.findIndex((d) => d.id === row.id);
    if (idx >= 0) items.value[idx] = updated;
    if (detailItem.value?.id === row.id) detailItem.value = updated;
    if (updated.status === 'sent') {
      notifySuccess('手动重试发送成功');
    } else {
      notifyError(updated.error || '手动重试仍失败');
    }
  } catch (error) {
    notifyError(error, '重试请求失败');
  } finally {
    retryingId.value = null;
  }
}

async function onPullRefresh(done: () => void): Promise<void> {
  page.value = 1;
  await loadPage(false, true);
  done();
}
</script>

<template>
  <q-page class="app-page">
    <div v-if="!isMobile" class="app-page-head">
      <div>
        <h1>发送日志</h1>
        <div class="sub">{{ initialized ? `共 ${total} 条投递记录` : '加载中…' }}</div>
      </div>
      <q-space />
      <q-btn flat round :icon="icons.refresh" aria-label="刷新" :loading="loading" @click="loadPage(false)">
        <q-tooltip>刷新</q-tooltip>
      </q-btn>
    </div>

    <div class="filter-bar app-card q-pa-sm q-mb-md">
      <q-select
        v-model="channelId"
        :options="[{ label: '全部渠道', value: '' }, ...channels.map((c) => ({ label: c.name, value: c.id }))]"
        option-label="label"
        option-value="value"
        emit-value
        map-options
        outlined
        dense
        class="filter-select"
        :behavior="isMobile ? 'dialog' : 'menu'"
      />

      <q-select
        v-model="status"
        :options="DELIVERY_STATUS_OPTIONS"
        option-label="label"
        option-value="value"
        emit-value
        map-options
        outlined
        dense
        class="filter-select"
        :behavior="isMobile ? 'dialog' : 'menu'"
      />

      <q-chip v-if="reminderId" removable color="primary" text-color="white" @remove="clearReminderFilter">
        已按提醒筛选
      </q-chip>
    </div>

    <!-- PC 表格 -->
    <template v-if="!isMobile">
      <q-table
        :rows="items"
        :columns="columns"
        row-key="id"
        :loading="loading"
        hide-pagination
        :rows-per-page-options="[0]"
        flat
        class="app-table"
      >
        <template #body-cell-reminder="props">
          <q-td :props="props" class="wrap-cell">
            <div class="text-weight-medium">{{ props.row.reminderTitle }}</div>
          </q-td>
        </template>

        <template #body-cell-channel="props">
          <q-td :props="props">
            <div>{{ props.row.channelName }}</div>
            <div class="text-caption text-faint">{{ props.row.channelType }}</div>
          </q-td>
        </template>

        <template #body-cell-status="props">
          <q-td :props="props">
            <span :class="chipClass(DELIVERY_STATUS[props.row.status as DeliveryStatus].tone)">
              {{ DELIVERY_STATUS[props.row.status as DeliveryStatus].label }}
            </span>
            <div v-if="props.row.status === 'retrying' && props.row.nextRetryAt" class="text-caption text-muted q-mt-xs">
              下次：{{ formatInstant(props.row.nextRetryAt) }}
            </div>
          </q-td>
        </template>

        <template #body-cell-time="props">
          <q-td :props="props">
            <div>计划：{{ formatInstant(props.row.scheduledAt) }}</div>
            <div class="text-caption text-muted">创建：{{ formatInstant(props.row.createdAt) }}</div>
          </q-td>
        </template>

        <template #body-cell-error="props">
          <q-td :props="props" class="error-cell">
            <span v-if="props.row.error" class="text-negative">{{ props.row.error }}</span>
            <span v-else-if="props.row.httpStatus" class="text-muted">HTTP {{ props.row.httpStatus }}</span>
            <span v-else class="text-faint">—</span>
          </q-td>
        </template>

        <template #body-cell-actions="props">
          <q-td :props="props" class="actions-cell">
            <q-btn
              v-if="props.row.status === 'failed' && !isDemo"
              flat
              dense
              no-caps
              color="primary"
              :icon="icons.retry"
              label="重试"
              :loading="retryingId === props.row.id"
              @click="handleRetry(props.row)"
            />
            <q-btn flat dense no-caps label="详情" @click="detailItem = props.row" />
          </q-td>
        </template>

        <template #no-data>
          <div v-if="loading || !initialized" class="q-py-xl flex flex-center full-width">
            <q-spinner color="primary" size="28px" />
          </div>
          <div v-else class="empty-state full-width">
            <div class="empty-icon"><q-icon :name="icons.history" size="30px" /></div>
            <h3>暂无发送记录</h3>
            <p>提醒到期触发后，投递记录会显示在这里。</p>
          </div>
        </template>
      </q-table>

      <div v-if="total > pageSize" class="q-mt-md flex flex-center">
        <q-pagination :model-value="page" :max="totalPages" :max-pages="7" direction-links @update:model-value="goPage" />
      </div>
    </template>

    <!-- 移动端卡片列表 -->
    <q-pull-to-refresh v-else @refresh="onPullRefresh">
      <div v-if="(loading || !initialized) && !items.length" class="q-py-xl flex flex-center">
        <q-spinner color="primary" size="32px" />
      </div>

      <div v-else-if="!items.length" class="empty-state app-card">
        <div class="empty-icon"><q-icon :name="icons.history" size="30px" /></div>
        <h3>暂无发送记录</h3>
      </div>

      <div v-else class="delivery-cards">
        <div v-for="item in items" :key="item.id" class="app-card delivery-card" @click="detailItem = item">
          <div class="d-head">
            <div class="d-title">{{ item.reminderTitle }}</div>
            <span :class="chipClass(DELIVERY_STATUS[item.status].tone)">{{ DELIVERY_STATUS[item.status].label }}</span>
          </div>
          <div class="d-meta text-muted">
            <span>{{ item.channelName }}（{{ item.channelType }}）</span>
            <span>第 {{ item.attempts }} 次</span>
          </div>
          <div class="d-meta text-faint">
            <span>{{ formatInstant(item.createdAt) }}</span>
            <span v-if="item.status === 'retrying' && item.nextRetryAt">下次重试：{{ formatInstant(item.nextRetryAt) }}</span>
          </div>
          <div v-if="item.error" class="d-err text-negative">{{ item.error }}</div>
          <div v-if="item.status === 'failed' && !isDemo" class="q-pt-xs" @click.stop>
            <q-btn
              outline
              dense
              no-caps
              color="primary"
              class="touch-44"
              :icon="icons.retry"
              label="手动重试"
              :loading="retryingId === item.id"
              @click="handleRetry(item)"
            />
          </div>
        </div>
      </div>

      <div v-if="hasMoreMobile" class="q-mt-md flex flex-center">
        <q-btn flat no-caps color="primary" class="touch-44" label="加载更多" :loading="loading" @click="loadMoreMobile" />
      </div>
    </q-pull-to-refresh>

    <!-- 日志详情弹窗 -->
    <q-dialog :model-value="Boolean(detailItem)" :position="isMobile ? 'bottom' : 'standard'" @update:model-value="detailItem = null">
      <q-card v-if="detailItem" class="detail-card">
        <q-card-section class="row items-center">
          <div class="text-subtitle1 text-weight-bold col">投递详情</div>
          <q-btn flat round dense :icon="icons.close" @click="detailItem = null" />
        </q-card-section>
        <q-separator />
        <q-card-section class="detail-body">
          <div class="kv"><span>提醒</span><strong>{{ detailItem.reminderTitle }}</strong></div>
          <div class="kv"><span>渠道</span><strong>{{ detailItem.channelName }}（{{ detailItem.channelType }}）</strong></div>
          <div class="kv">
            <span>状态</span>
            <span :class="chipClass(DELIVERY_STATUS[detailItem.status].tone)">{{ DELIVERY_STATUS[detailItem.status].label }}</span>
          </div>
          <div class="kv"><span>事件 ID</span><code>{{ detailItem.eventId }}</code></div>
          <div class="kv"><span>计划时间</span><span>{{ formatInstant(detailItem.scheduledAt) }}</span></div>
          <div v-if="detailItem.sentAt" class="kv"><span>送达时间</span><span>{{ formatInstant(detailItem.sentAt) }}</span></div>
          <div v-if="detailItem.nextRetryAt" class="kv"><span>下次重试</span><span>{{ formatInstant(detailItem.nextRetryAt) }}</span></div>
          <div class="kv"><span>尝试次数</span><span>{{ detailItem.attempts }}</span></div>
          <div v-if="detailItem.httpStatus !== null" class="kv"><span>HTTP 状态</span><span>{{ detailItem.httpStatus }}</span></div>
          <div v-if="detailItem.error" class="kv kv--col">
            <span>错误信息</span>
            <pre class="code-box text-negative">{{ detailItem.error }}</pre>
          </div>
          <div v-if="detailItem.responseSummary" class="kv kv--col">
            <span>响应摘要</span>
            <pre class="code-box">{{ detailItem.responseSummary }}</pre>
          </div>
        </q-card-section>
        <q-card-actions v-if="detailItem.status === 'failed' && !isDemo" align="right">
          <q-btn
            unelevated
            no-caps
            color="primary"
            :icon="icons.retry"
            label="手动重试"
            :loading="retryingId === detailItem.id"
            @click="handleRetry(detailItem)"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<style scoped lang="scss">
.filter-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.filter-select {
  min-width: 140px;
}
.wrap-cell {
  max-width: 240px;
  white-space: normal;
}
.error-cell {
  max-width: 280px;
  white-space: normal;
  font-size: 12.5px;
}
.actions-cell {
  white-space: nowrap;
}
.delivery-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.delivery-card {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.d-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.d-title {
  flex: 1;
  font-weight: 600;
  font-size: 15px;
}
.d-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12.5px;
}
.d-err {
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.detail-card {
  width: 520px;
  max-width: 100vw;
  background: var(--app-surface);
  color: var(--app-text);
  padding-bottom: var(--safe-bottom);
}
.detail-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 70vh;
  overflow-y: auto;
}
.kv {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13.5px;
  > span:first-child {
    color: var(--app-text-2);
    flex-shrink: 0;
  }
  code {
    font-size: 12px;
    background: var(--app-code-bg);
    padding: 2px 6px;
    border-radius: 4px;
    word-break: break-all;
  }
}
.kv--col {
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
}
.code-box {
  margin: 0;
  padding: 10px;
  border-radius: 8px;
  background: var(--app-code-bg);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 180px;
  overflow-y: auto;
}
</style>
