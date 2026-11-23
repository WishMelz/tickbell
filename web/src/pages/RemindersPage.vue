<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { QTableColumn } from 'quasar';
import { api, type ChannelView, type ReminderStatusFilter, type ReminderView } from '@/api';
import ReminderEditorDialog from '@/components/reminders/ReminderEditorDialog.vue';
import { confirmDialog } from '@/composables/dialogs';
import { tabbarHidden } from '@/composables/layoutState';
import { notifyError, notifySuccess, useResponsive } from '@/composables/useResponsive';
import { icons } from '@/icons';
import { chipClass, reminderStatus } from '@/utils/status';
import { formatLocal, formatLocalFriendly, formatRelative, repeatText } from '@/utils/time';

const router = useRouter();
const { isMobile, isTablet } = useResponsive();

const loading = ref(true);
const initialized = ref(false);
const reminders = ref<ReminderView[]>([]);
const channels = ref<ChannelView[]>([]);

// 筛选与排序
const search = ref('');
const statusFilter = ref<ReminderStatusFilter | ''>('');
const categoryFilter = ref('');
const tagFilter = ref('');
const sortAsc = ref(true);

// 列表选中（PC QTable 和 移动端多选模式共用 selectedIds）
const selectedIds = ref<string[]>([]);
const mobileSelectMode = ref(false);
const mobileVisibleCount = ref(20);

// 编辑器 & 批量替换渠道弹窗
const editorOpen = ref(false);
const editingReminder = ref<ReminderView | null>(null);
const batchChannelDialog = ref(false);
const batchChannelIds = ref<string[]>([]);
const batchBusy = ref(false);

const statusOptions: Array<{ label: string; value: ReminderStatusFilter | '' }> = [
  { label: '全部状态', value: '' },
  { label: '运行中', value: 'active' },
  { label: '已暂停', value: 'paused' },
  { label: '已完成', value: 'completed' },
];

const channelMap = computed(() => new Map(channels.value.map((c) => [c.id, c])));
const usableChannelOptions = computed(() =>
  channels.value
    .filter((c) => c.supported && c.enabled && c.configured)
    .map((c) => ({ label: c.name, value: c.id })),
);

const knownCategories = ref<string[]>([]);
const knownTags = ref<string[]>([]);

const allCategories = computed(() => {
  const set = new Set<string>(knownCategories.value);
  for (const r of reminders.value) {
    if (r.category) set.add(r.category);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
});

const allTags = computed(() => {
  const set = new Set<string>(knownTags.value);
  for (const r of reminders.value) {
    for (const t of r.tags) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
});

const sortedReminders = computed(() => {
  const list = [...reminders.value];
  list.sort((a, b) => {
    const diff = Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt);
    return sortAsc.value ? diff : -diff;
  });
  return list;
});

const mobileReminders = computed(() => sortedReminders.value.slice(0, mobileVisibleCount.value));
const hasMoreMobile = computed(() => mobileVisibleCount.value < sortedReminders.value.length);

// PC QTable 选中行对象双向同步
const selectedRows = computed<ReminderView[]>({
  get: () => sortedReminders.value.filter((r) => selectedIds.value.includes(r.id)),
  set: (rows) => {
    selectedIds.value = rows.map((r) => r.id);
  },
});

const columns: QTableColumn<ReminderView>[] = [
  { name: 'title', label: '提醒', field: 'title', align: 'left' },
  { name: 'nextRun', label: '下次触发', field: 'nextRunAt', align: 'left', sortable: false },
  { name: 'repeat', label: '重复规则', field: 'isRepeating', align: 'left' },
  { name: 'channels', label: '通知渠道', field: 'channelIds', align: 'left' },
  { name: 'status', label: '状态', field: 'enabled', align: 'left' },
  { name: 'actions', label: '操作', field: 'id', align: 'right' },
];

const pagination = ref({ page: 1, rowsPerPage: 20 });

let loadAbort: AbortController | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

async function loadData(silent = false): Promise<void> {
  loadAbort?.abort();
  loadAbort = new AbortController();
  if (!silent) loading.value = true;
  try {
    const [remList, chList] = await Promise.all([
      api.listReminders(
        {
          search: (search.value ?? '').trim() || undefined,
          status: statusFilter.value || undefined,
          category: categoryFilter.value || undefined,
          tag: tagFilter.value || undefined,
        },
        loadAbort.signal,
      ),
      api.listChannels(),
    ]);
    reminders.value = remList;
    channels.value = chList;
    initialized.value = true;
    // 无筛选条件时同步全量分类与标签，确保筛选时下拉选项完整
    if (!(search.value ?? '').trim() && !statusFilter.value && !categoryFilter.value && !tagFilter.value) {
      knownCategories.value = [...new Set(remList.map((r) => r.category).filter(Boolean))];
      knownTags.value = [...new Set(remList.flatMap((r) => r.tags))];
    }
    // 保留仍在当前列表中的选中项
    const valid = new Set(remList.map((r) => r.id));
    selectedIds.value = selectedIds.value.filter((id) => valid.has(id));
  } catch (error) {
    notifyError(error, '加载提醒列表失败');
  } finally {
    if (!silent) loading.value = false;
  }
}

watch([statusFilter, categoryFilter, tagFilter], () => {
  selectedIds.value = [];
  exitMobileSelect();
  mobileVisibleCount.value = 20;
  void loadData();
});

watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    selectedIds.value = [];
    exitMobileSelect();
    mobileVisibleCount.value = 20;
    void loadData();
  }, 260);
});

watch([isMobile, mobileSelectMode], ([mobile, selecting]) => {
  tabbarHidden.value = mobile && selecting;
});

onMounted(() => {
  void loadData();
});

onBeforeUnmount(() => {
  loadAbort?.abort();
  if (searchTimer) clearTimeout(searchTimer);
  tabbarHidden.value = false;
});

// 移动端长按进入多选模式
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
function onCardTouchStart(id: string): void {
  if (!isMobile.value || mobileSelectMode.value) return;
  longPressTimer = setTimeout(() => {
    mobileSelectMode.value = true;
    selectedIds.value = [id];
  }, 450);
}
function clearLongPress(): void {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function toggleSelect(id: string): void {
  if (selectedIds.value.includes(id)) {
    selectedIds.value = selectedIds.value.filter((item) => item !== id);
  } else {
    selectedIds.value = [...selectedIds.value, id];
  }
}

function toggleSelectAllMobile(): void {
  if (selectedIds.value.length === sortedReminders.value.length) {
    selectedIds.value = [];
  } else {
    selectedIds.value = sortedReminders.value.map((r) => r.id);
  }
}

function exitMobileSelect(): void {
  mobileSelectMode.value = false;
  selectedIds.value = [];
}

function openCreate(): void {
  editingReminder.value = null;
  editorOpen.value = true;
}

function openEdit(item: ReminderView): void {
  editingReminder.value = item;
  editorOpen.value = true;
}

function openDeliveries(item: ReminderView): void {
  void router.push({ name: 'deliveries', query: { reminderId: item.id } });
}

async function toggleEnabled(item: ReminderView, resetSlide?: () => void): Promise<void> {
  resetSlide?.();
  try {
    const updated = item.enabled
      ? await api.disableReminder(item.id)
      : await api.enableReminder(item.id);
    const idx = reminders.value.findIndex((r) => r.id === item.id);
    if (idx >= 0) reminders.value[idx] = updated;
    notifySuccess(updated.enabled ? '提醒已启用' : '提醒已暂停');
  } catch (error) {
    notifyError(error, '更新状态失败');
  }
}

async function removeReminder(item: ReminderView, resetSlide?: () => void): Promise<void> {
  resetSlide?.();
  const ok = await confirmDialog({
    title: '删除提醒',
    message: `确定删除“${item.title}”吗？历史发送日志仍会保留。`,
    okLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteReminder(item.id);
    reminders.value = reminders.value.filter((r) => r.id !== item.id);
    selectedIds.value = selectedIds.value.filter((id) => id !== item.id);
    notifySuccess('提醒已删除');
  } catch (error) {
    notifyError(error, '删除失败');
  }
}

async function runBatchAction(action: 'enable' | 'disable' | 'delete'): Promise<void> {
  if (!selectedIds.value.length) return;
  const labelMap = { enable: '启用', disable: '暂停', delete: '删除' };
  const ok = await confirmDialog({
    title: `批量${labelMap[action]}`,
    message: `确定对已选中的 ${selectedIds.value.length} 条提醒执行“${labelMap[action]}”操作吗？`,
    okLabel: labelMap[action],
    danger: action === 'delete',
  });
  if (!ok) return;

  batchBusy.value = true;
  try {
    const res = await api.batchReminders({ ids: selectedIds.value, action });
    notifySuccess(`已${labelMap[action]} ${res.updated} 条${res.skipped ? `，跳过 ${res.skipped} 条` : ''}`);
    selectedIds.value = [];
    exitMobileSelect();
    await loadData(true);
  } catch (error) {
    notifyError(error, '批量操作失败');
  } finally {
    batchBusy.value = false;
  }
}

function openBatchChannels(): void {
  batchChannelIds.value = [];
  batchChannelDialog.value = true;
}

async function confirmBatchChannels(): Promise<void> {
  if (!selectedIds.value.length || !batchChannelIds.value.length) {
    notifyError('请至少选择一个通知渠道');
    return;
  }
  batchBusy.value = true;
  try {
    const res = await api.batchReminders({
      ids: selectedIds.value,
      action: 'channels',
      channelIds: batchChannelIds.value,
    });
    notifySuccess(`已更新 ${res.updated} 条提醒的通知渠道`);
    batchChannelDialog.value = false;
    selectedIds.value = [];
    exitMobileSelect();
    await loadData(true);
  } catch (error) {
    notifyError(error, '替换渠道失败');
  } finally {
    batchBusy.value = false;
  }
}

async function onPullRefresh(done: () => void): Promise<void> {
  await loadData(true);
  done();
}

function channelName(id: string): string {
  return channelMap.value.get(id)?.name ?? '未知渠道';
}

function isChannelUnsupported(id: string): boolean {
  const ch = channelMap.value.get(id);
  return Boolean(ch && !ch.supported);
}

function visibleTags(row: ReminderView): string[] {
  const limit = row.category ? 2 : 3;
  return row.tags.slice(0, limit);
}

function hiddenTags(row: ReminderView): string[] {
  const limit = row.category ? 2 : 3;
  return row.tags.slice(limit);
}

function tooltipContent(text: string): string {
  return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
}
</script>

<template>
  <q-page class="app-page" :class="{ 'has-mobile-batch': isMobile && mobileSelectMode }">
    <!-- 页头（PC 展示标题和新建按钮；移动端由顶栏显示标题 + FAB 新建） -->
    <div v-if="!isMobile" class="app-page-head">
      <div>
        <h1>提醒管理</h1>
        <div class="sub">{{ initialized ? `共 ${reminders.length} 条提醒` : '加载中…' }}</div>
      </div>
      <q-space />
      <q-btn flat round :icon="icons.refresh" aria-label="刷新" :loading="loading" @click="loadData()">
        <q-tooltip>刷新</q-tooltip>
      </q-btn>
      <q-btn unelevated no-caps color="primary" :icon="icons.add" label="新建提醒" @click="openCreate" />
    </div>

    <!-- 筛选栏 -->
    <div class="filter-bar app-card q-pa-sm q-mb-md">
      <q-input
        :model-value="search"
        outlined
        dense
        clearable
        placeholder="搜索标题、正文、分类或标签"
        class="filter-search"
        @update:model-value="search = $event == null ? '' : String($event)"
      >
        <template #prepend><q-icon :name="icons.search" size="18px" /></template>
      </q-input>

      <q-select
        v-model="statusFilter"
        :options="statusOptions"
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
        v-if="allCategories.length"
        v-model="categoryFilter"
        :options="[{ label: '全部分类', value: '' }, ...allCategories.map((c) => ({ label: c, value: c }))]"
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
        v-if="allTags.length"
        v-model="tagFilter"
        :options="[{ label: '全部标签', value: '' }, ...allTags.map((t) => ({ label: `#${t}`, value: t }))]"
        option-label="label"
        option-value="value"
        emit-value
        map-options
        outlined
        dense
        class="filter-select"
        :behavior="isMobile ? 'dialog' : 'menu'"
      />

      <q-btn
        flat
        no-caps
        dense
        class="touch-44"
        :icon="sortAsc ? icons.arrowUp : icons.arrowDown"
        :label="sortAsc ? '按时间升序' : '按时间降序'"
        @click="sortAsc = !sortAsc"
      />

      <q-btn
        v-if="isMobile && sortedReminders.length"
        flat
        no-caps
        dense
        class="touch-44"
        :color="mobileSelectMode ? 'primary' : undefined"
        :icon="icons.checklist"
        :label="mobileSelectMode ? '完成' : '多选'"
        @click="mobileSelectMode ? exitMobileSelect() : (mobileSelectMode = true)"
      />
    </div>

    <!-- PC 批量操作栏 -->
    <div v-if="!isMobile && selectedIds.length" class="batch-bar app-card q-px-md q-py-sm q-mb-md">
      <span class="text-weight-medium">已选 {{ selectedIds.length }} 条</span>
      <q-space />
      <q-btn flat no-caps dense color="positive" :icon="icons.play" label="批量启用" :disable="batchBusy" @click="runBatchAction('enable')" />
      <q-btn flat no-caps dense color="warning" :icon="icons.pause" label="批量暂停" :disable="batchBusy" @click="runBatchAction('disable')" />
      <q-btn flat no-caps dense color="primary" :icon="icons.swap" label="替换渠道" :disable="batchBusy" @click="openBatchChannels" />
      <q-btn flat no-caps dense color="negative" :icon="icons.delete" label="批量删除" :disable="batchBusy" @click="runBatchAction('delete')" />
      <q-btn flat no-caps dense label="取消选择" @click="selectedIds = []" />
    </div>

    <!-- PC 表格 -->
    <q-table
      v-if="!isMobile"
      v-model:selected="selectedRows"
      v-model:pagination="pagination"
      :rows="sortedReminders"
      :columns="columns"
      row-key="id"
      selection="multiple"
      :loading="loading"
      :rows-per-page-options="[10, 20, 50]"
      flat
      class="app-table"
    >
      <template #body-cell-title="props">
        <q-td :props="props" class="title-cell">
          <div class="row-title" @click="openEdit(props.row)">
            {{ props.row.title }}
            <q-tooltip
              anchor="top left"
              self="bottom left"
              :offset="[0, 6]"
              :delay="220"
              class="reminder-preview-tooltip"
            >
              {{ props.row.title }}
            </q-tooltip>
          </div>
          <div v-if="props.row.content" class="row-desc text-muted">
            {{ props.row.content }}
            <q-tooltip
              anchor="bottom left"
              self="top left"
              :offset="[0, 6]"
              :delay="220"
              class="reminder-preview-tooltip"
            >
              {{ tooltipContent(props.row.content) }}
            </q-tooltip>
          </div>
          <div v-if="props.row.category || props.row.tags.length" class="tag-row tag-row--compact">
            <span v-if="props.row.category" class="tag-pill tag-pill--category" :title="props.row.category">
              {{ props.row.category }}
            </span>
            <span v-for="t in visibleTags(props.row)" :key="t" class="tag-pill tag-pill--item" :title="`#${t}`">
              #{{ t }}
            </span>
            <span v-if="hiddenTags(props.row).length" class="tag-pill tag-pill--more">
              +{{ hiddenTags(props.row).length }}
              <q-tooltip anchor="top middle" self="bottom middle" :offset="[0, 6]">
                {{ hiddenTags(props.row).map((t) => `#${t}`).join(' · ') }}
              </q-tooltip>
            </span>
          </div>
        </q-td>
      </template>

      <template #body-cell-nextRun="props">
        <q-td :props="props">
          <div class="text-weight-medium">{{ formatLocal(props.row.nextRunLocal) }}</div>
          <div class="text-caption text-muted">
            {{ props.row.timezone }}
            <span v-if="!props.row.completed"> · {{ formatRelative(props.row.nextRunAt) }}</span>
          </div>
        </q-td>
      </template>

      <template #body-cell-repeat="props">
        <q-td :props="props">
          <span>{{ repeatText(props.row.isRepeating, props.row.repeatEvery, props.row.repeatUnit) }}</span>
        </q-td>
      </template>

      <template #body-cell-channels="props">
        <q-td :props="props">
          <div class="tag-row">
            <span
              v-for="cid in props.row.channelIds"
              :key="cid"
              class="tag-pill"
              :class="{ 'text-warning': isChannelUnsupported(cid) }"
            >
              {{ channelName(cid) }}
            </span>
          </div>
        </q-td>
      </template>

      <template #body-cell-status="props">
        <q-td :props="props">
          <span :class="chipClass(reminderStatus(props.row).tone)">
            {{ reminderStatus(props.row).label }}
          </span>
        </q-td>
      </template>

      <template #body-cell-actions="props">
        <q-td :props="props" class="actions-cell">
          <q-btn flat round dense :icon="icons.edit" aria-label="编辑" @click="openEdit(props.row)">
            <q-tooltip>编辑</q-tooltip>
          </q-btn>
          <q-btn
            v-if="!props.row.completed"
            flat
            round
            dense
            :color="props.row.enabled ? 'warning' : 'positive'"
            :icon="props.row.enabled ? icons.pause : icons.play"
            :aria-label="props.row.enabled ? '暂停' : '启用'"
            @click="toggleEnabled(props.row)"
          >
            <q-tooltip>{{ props.row.enabled ? '暂停' : '启用' }}</q-tooltip>
          </q-btn>
          <q-btn flat round dense :icon="icons.history" aria-label="查看日志" @click="openDeliveries(props.row)">
            <q-tooltip>查看发送日志</q-tooltip>
          </q-btn>
          <q-btn flat round dense color="negative" :icon="icons.delete" aria-label="删除" @click="removeReminder(props.row)">
            <q-tooltip>删除</q-tooltip>
          </q-btn>
        </q-td>
      </template>

      <template #no-data>
        <div v-if="loading || !initialized" class="q-py-xl flex flex-center full-width">
          <q-spinner color="primary" size="28px" />
        </div>
        <div v-else class="empty-state full-width">
          <div class="empty-icon"><q-icon :name="icons.alarm" size="30px" /></div>
          <h3>暂无提醒</h3>
          <p>点击右上角“新建提醒”创建第一条定时通知。</p>
          <q-btn unelevated no-caps color="primary" :icon="icons.add" label="新建提醒" @click="openCreate" />
        </div>
      </template>
    </q-table>

    <!-- 移动端：下拉刷新 + 卡片列表（左滑启停/删除，长按多选，平板双列） -->
    <q-pull-to-refresh v-else @refresh="onPullRefresh">
      <div v-if="(loading || !initialized) && !reminders.length" class="q-py-xl flex flex-center">
        <q-spinner color="primary" size="32px" />
      </div>

      <div v-else-if="!sortedReminders.length" class="empty-state app-card">
        <div class="empty-icon"><q-icon :name="icons.alarm" size="30px" /></div>
        <h3>暂无提醒</h3>
        <p>点击右下角按钮创建第一条提醒。</p>
        <q-btn unelevated no-caps color="primary" class="touch-44" :icon="icons.add" label="新建提醒" @click="openCreate" />
      </div>

      <div v-else class="mobile-grid" :class="{ 'mobile-grid--tablet': isTablet }">
        <q-slide-item
          v-for="item in mobileReminders"
          :key="item.id"
          class="slide-wrap"
          :left-color="item.enabled ? 'warning' : 'positive'"
          right-color="negative"
          @left="({ reset }) => (!item.completed ? toggleEnabled(item, reset) : reset())"
          @right="({ reset }) => removeReminder(item, reset)"
        >
          <template v-if="!mobileSelectMode && !item.completed" #left>
            <div class="row items-center q-gutter-xs">
              <q-icon :name="item.enabled ? icons.pause : icons.play" />
              <span>{{ item.enabled ? '暂停' : '启用' }}</span>
            </div>
          </template>
          <template v-if="!mobileSelectMode" #right>
            <div class="row items-center q-gutter-xs">
              <q-icon :name="icons.delete" />
              <span>删除</span>
            </div>
          </template>

          <div
            class="app-card reminder-card"
            :class="{ 'reminder-card--selected': selectedIds.includes(item.id) }"
            @touchstart.passive="onCardTouchStart(item.id)"
            @touchend="clearLongPress"
            @touchmove="clearLongPress"
            @click="mobileSelectMode ? toggleSelect(item.id) : openEdit(item)"
          >
            <div class="card-top">
              <q-checkbox
                v-if="mobileSelectMode"
                :model-value="selectedIds.includes(item.id)"
                dense
                class="q-mr-xs"
                @update:model-value="toggleSelect(item.id)"
                @click.stop
              />
              <div class="card-title">{{ item.title }}</div>
              <span :class="chipClass(reminderStatus(item).tone)">
                {{ reminderStatus(item).label }}
              </span>
            </div>

            <div v-if="item.content" class="card-content text-muted">{{ item.content }}</div>

            <div class="card-meta">
              <span class="meta-item">
                <q-icon :name="icons.schedule" size="15px" />
                {{ formatLocalFriendly(item.nextRunLocal) }}
              </span>
              <span class="meta-item text-faint">{{ item.timezone }}</span>
              <span class="meta-item">
                <q-icon :name="icons.repeat" size="15px" />
                {{ repeatText(item.isRepeating, item.repeatEvery, item.repeatUnit) }}
              </span>
            </div>

            <div class="card-bottom">
              <div class="tag-row">
                <span v-if="item.category" class="tag-pill tag-pill--category">{{ item.category }}</span>
                <span v-for="cid in item.channelIds" :key="cid" class="tag-pill">{{ channelName(cid) }}</span>
              </div>
              <div v-if="!mobileSelectMode" class="card-actions" @click.stop>
                <q-btn flat round dense class="touch-44" :icon="icons.history" aria-label="日志" @click="openDeliveries(item)" />
                <q-btn
                  v-if="!item.completed"
                  flat
                  round
                  dense
                  class="touch-44"
                  :color="item.enabled ? 'warning' : 'positive'"
                  :icon="item.enabled ? icons.pause : icons.play"
                  :aria-label="item.enabled ? '暂停' : '启用'"
                  @click="toggleEnabled(item)"
                />
              </div>
            </div>
          </div>
        </q-slide-item>
      </div>

      <div v-if="hasMoreMobile" class="q-mt-md flex flex-center">
        <q-btn flat no-caps color="primary" class="touch-44" label="加载更多" @click="mobileVisibleCount += 20" />
      </div>
    </q-pull-to-refresh>

    <!-- 移动端 FAB 新建 -->
    <q-page-sticky v-if="isMobile && !mobileSelectMode" position="bottom-right" :offset="[18, 18]">
      <q-btn fab color="primary" :icon="icons.add" aria-label="新建提醒" @click="openCreate" />
    </q-page-sticky>

    <!-- 移动端底部批量操作栏 -->
    <div v-if="isMobile && mobileSelectMode" class="mobile-batch-bar">
      <div class="mobile-batch-inner">
        <q-btn flat dense no-caps class="touch-44" :icon="icons.selectAll" :label="`全选(${selectedIds.length})`" @click="toggleSelectAllMobile" />
        <q-space />
        <q-btn flat dense no-caps class="touch-44" color="positive" label="启用" :disable="!selectedIds.length || batchBusy" @click="runBatchAction('enable')" />
        <q-btn flat dense no-caps class="touch-44" color="warning" label="暂停" :disable="!selectedIds.length || batchBusy" @click="runBatchAction('disable')" />
        <q-btn flat dense no-caps class="touch-44" color="primary" label="渠道" :disable="!selectedIds.length || batchBusy" @click="openBatchChannels" />
        <q-btn flat dense no-caps class="touch-44" color="negative" label="删除" :disable="!selectedIds.length || batchBusy" @click="runBatchAction('delete')" />
      </div>
    </div>

    <!-- 提醒编辑器 -->
    <ReminderEditorDialog
      v-model="editorOpen"
      :reminder="editingReminder"
      :channels="channels"
      :existing-categories="allCategories"
      :existing-tags="allTags"
      @saved="loadData(true)"
    />

    <!-- 批量替换渠道弹窗 -->
    <q-dialog v-model="batchChannelDialog">
      <q-card class="batch-dialog-card">
        <q-card-section>
          <div class="text-h6">批量替换通知渠道</div>
          <div class="text-caption text-muted q-mt-xs">
            将所选 {{ selectedIds.length }} 条提醒的通知渠道统一替换为以下渠道：
          </div>
        </q-card-section>
        <q-card-section class="q-pt-none">
          <q-select
            v-model="batchChannelIds"
            :options="usableChannelOptions"
            option-label="label"
            option-value="value"
            emit-value
            map-options
            multiple
            use-chips
            outlined
            dense
            label="选择可用渠道 *"
            :behavior="isMobile ? 'dialog' : 'menu'"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps label="取消" :disable="batchBusy" @click="batchChannelDialog = false" />
          <q-btn unelevated no-caps color="primary" label="确认替换" :loading="batchBusy" @click="confirmBatchChannels" />
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
.filter-search {
  flex: 1 1 220px;
  min-width: 180px;
}
.filter-select {
  min-width: 128px;
}
.batch-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.title-cell {
  max-width: 360px;
  white-space: normal;
}
.row-title {
  font-weight: 600;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  &:hover {
    color: var(--q-primary);
  }
}
.row-desc {
  font-size: 12.5px;
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  cursor: default;
}
.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
}
.tag-row--compact {
  flex-wrap: nowrap;
  align-items: center;
  overflow: hidden;
}
.tag-pill--category {
  max-width: 110px;
  flex-shrink: 0;
  font-size: 11.5px;
  font-weight: 550;
  padding: 0 7px;
  background: color-mix(in srgb, var(--q-primary) 10%, transparent);
  border-color: color-mix(in srgb, var(--q-primary) 24%, transparent);
  color: var(--q-primary);
}
.tag-pill--item {
  max-width: 108px;
  min-width: 0;
  font-size: 11.5px;
  padding: 0 7px;
}
.tag-pill--more {
  flex-shrink: 0;
  font-size: 11.5px;
  font-weight: 600;
  padding: 0 7px;
  color: var(--app-text-3);
  cursor: default;
}
.actions-cell {
  white-space: nowrap;
}

.mobile-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}
.mobile-grid--tablet {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.slide-wrap {
  border-radius: var(--app-radius);
  overflow: hidden;
  background: transparent;
}
.reminder-card {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.reminder-card--selected {
  border-color: var(--q-primary);
  background: var(--app-selected);
}
.card-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.card-title {
  flex: 1;
  font-size: 15.5px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.card-content {
  font-size: 13px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  font-size: 12.5px;
  color: var(--app-text-2);
}
.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.card-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.card-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.mobile-batch-inner {
  display: flex;
  align-items: center;
  gap: 4px;
}
.has-mobile-batch {
  padding-bottom: calc(80px + var(--safe-bottom));
}
.batch-dialog-card {
  width: 420px;
  max-width: 92vw;
  background: var(--app-surface);
  color: var(--app-text);
}
</style>
