<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api, type ProxyProtocol, type ProxyTestResult, type ProxyView } from '@/api';
import { confirmDialog } from '@/composables/dialogs';
import { notifyError, notifySuccess, useResponsive } from '@/composables/useResponsive';
import { icons } from '@/icons';

const { isMobile } = useResponsive();

const loading = ref(false);
const proxies = ref<ProxyView[]>([]);
const testingId = ref<string | null>(null);
const testResults = ref<Record<string, ProxyTestResult>>({});

const protocolOptions: Array<{ label: string; value: ProxyProtocol }> = [
  { label: 'HTTP', value: 'http' },
  { label: 'HTTPS', value: 'https' },
  { label: 'SOCKS5', value: 'socks5' },
];

// ---------- 新增/编辑弹窗 ----------
const dialogOpen = ref(false);
const editingProxy = ref<ProxyView | null>(null);
const saving = ref(false);
const dialogTesting = ref(false);
const dialogTestResult = ref<ProxyTestResult | null>(null);

const form = reactive<{
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: number | null;
  username: string;
  password: string;
  clearPassword: boolean;
}>({
  name: '',
  protocol: 'socks5',
  host: '',
  port: 7890,
  username: '',
  password: '',
  clearPassword: false,
});

const isEdit = computed(() => editingProxy.value !== null);

function rowResult(id: string): ProxyTestResult | undefined {
  return testResults.value[id];
}

async function loadProxies(): Promise<void> {
  loading.value = true;
  try {
    proxies.value = await api.listProxies();
  } catch (error) {
    notifyError(error, '加载代理配置失败');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadProxies();
});

defineExpose({
  reload: loadProxies,
});

function openCreate(): void {
  editingProxy.value = null;
  form.name = '';
  form.protocol = 'socks5';
  form.host = '';
  form.port = 7890;
  form.username = '';
  form.password = '';
  form.clearPassword = false;
  dialogTestResult.value = null;
  dialogOpen.value = true;
}

function openEdit(item: ProxyView): void {
  editingProxy.value = item;
  form.name = item.name;
  form.protocol = item.protocol;
  form.host = item.host;
  form.port = item.port;
  form.username = item.username;
  form.password = '';
  form.clearPassword = false;
  dialogTestResult.value = null;
  dialogOpen.value = true;
}

/** 支持直接粘贴完整代理 URL（如 socks5://user:pass@127.0.0.1:1080）自动拆分 */
function tryParsePastedUrl(value: string | number | null): void {
  const text = String(value ?? '').trim();
  if (!text.includes('://')) return;
  try {
    const normalized = text.replace(/^socks5h:\/\//i, 'socks5://');
    const parsed = new URL(normalized);
    const proto = parsed.protocol.replace(/:$/, '').toLowerCase();
    if (proto === 'http' || proto === 'https' || proto === 'socks5') {
      form.protocol = proto;
      form.host = parsed.hostname;
      if (parsed.port) {
        form.port = Number(parsed.port);
      } else {
        form.port = proto === 'https' ? 443 : proto === 'socks5' ? 1080 : 8080;
      }
      if (parsed.username) form.username = decodeURIComponent(parsed.username);
      if (parsed.password) {
        form.password = decodeURIComponent(parsed.password);
        form.clearPassword = false;
      }
    }
  } catch {
    // 保留原输入，由提交校验提示
  }
}

function validateForm(requireName: boolean): boolean {
  const name = form.name.trim();
  if (requireName && (!name || name.length > 80)) {
    notifyError('代理名称长度必须为 1 到 80 个字符');
    return false;
  }
  const host = form.host.trim();
  if (!host || /[\s/?#@]/.test(host) || host.includes('://')) {
    notifyError('请填写有效的代理主机地址（域名或 IP）');
    return false;
  }
  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    notifyError('代理端口需为 1 到 65535 的整数');
    return false;
  }
  return true;
}

async function handleSave(): Promise<void> {
  if (!validateForm(true)) return;
  saving.value = true;
  try {
    const payload = {
      name: form.name.trim(),
      protocol: form.protocol,
      host: form.host.trim(),
      port: Number(form.port),
      username: form.username.trim(),
      password: form.clearPassword ? '' : form.password,
      clearPassword: form.clearPassword,
      enabled: true,
    };
    const saved = editingProxy.value
      ? await api.updateProxy(editingProxy.value.id, payload)
      : await api.createProxy(payload);
    if (dialogTestResult.value) {
      testResults.value[saved.id] = dialogTestResult.value;
    }
    notifySuccess(editingProxy.value ? '代理配置已更新' : '代理配置已添加');
    dialogOpen.value = false;
    await loadProxies();
  } catch (error) {
    notifyError(error, '保存代理配置失败');
  } finally {
    saving.value = false;
  }
}

async function handleDialogTest(): Promise<void> {
  if (!validateForm(false)) return;
  dialogTesting.value = true;
  dialogTestResult.value = null;
  try {
    const res = await api.testAdhocProxy({
      id: editingProxy.value?.id,
      protocol: form.protocol,
      host: form.host.trim(),
      port: Number(form.port),
      username: form.username.trim(),
      password: form.clearPassword ? '' : form.password,
      clearPassword: form.clearPassword,
    });
    dialogTestResult.value = res;
    if (res.ok) {
      notifySuccess(`代理校验通过（${res.latencyMs}ms）`);
    } else {
      notifyError(res.error || '代理校验失败');
    }
  } catch (error) {
    notifyError(error, '代理校验失败');
  } finally {
    dialogTesting.value = false;
  }
}

async function handleRowTest(item: ProxyView): Promise<void> {
  testingId.value = item.id;
  try {
    const res = await api.testProxy(item.id);
    testResults.value = { ...testResults.value, [item.id]: res };
    if (res.ok) {
      notifySuccess(`代理“${item.name}”校验通过（${res.latencyMs}ms）`);
    } else {
      notifyError(`代理“${item.name}”校验失败：${res.error || '连接失败'}`);
    }
  } catch (error) {
    notifyError(error, '代理校验失败');
  } finally {
    testingId.value = null;
  }
}

async function handleDelete(item: ProxyView): Promise<void> {
  const hint = item.channelCount > 0
    ? `当前有 ${item.channelCount} 个通知渠道正在使用该代理，删除后它们将自动恢复为直连。`
    : '删除后不可恢复。';
  const ok = await confirmDialog({
    title: '删除代理配置',
    message: `确定删除代理“${item.name}”吗？${hint}`,
    okLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteProxy(item.id);
    proxies.value = proxies.value.filter((p) => p.id !== item.id);
    notifySuccess('代理已删除');
  } catch (error) {
    notifyError(error, '删除代理失败');
  }
}
</script>

<template>
  <div class="app-card q-pa-md">
    <div class="card-head">
      <q-icon :name="icons.dns" size="20px" color="primary" />
      <div class="col">
        <h3 class="section-title">网络代理</h3>
        <div class="text-muted text-caption">
          统一配置 HTTP / HTTPS / SOCKS5 代理并校验连通性；具体是否在推送时使用，请在「通知渠道」中下拉选择。
        </div>
      </div>
      <q-btn
        unelevated
        no-caps
        color="primary"
        class="touch-44"
        :icon="icons.add"
        label="添加代理"
        @click="openCreate"
      />
    </div>

    <!-- 代理列表 -->
    <div v-if="loading && !proxies.length" class="q-py-lg flex flex-center">
      <q-spinner color="primary" size="24px" />
    </div>

    <div v-else-if="!proxies.length" class="empty-proxy q-mt-md text-muted text-caption">
      尚未配置代理。点击右上角「添加代理」添加 HTTP / HTTPS / SOCKS5 代理后，即可在各通知渠道中下拉选用。
    </div>

    <div v-else class="proxy-list q-mt-md">
      <div v-for="item in proxies" :key="item.id" class="proxy-row">
        <div class="proxy-info">
          <div class="proxy-title-line">
            <span class="proxy-name">{{ item.name }}</span>
            <span class="tag-pill proto-pill">{{ item.protocol.toUpperCase() }}</span>
            <span v-if="item.username || item.hasPassword" class="tag-pill">已设认证</span>
            <span v-if="item.channelCount > 0" class="tag-pill">已被 {{ item.channelCount }} 个渠道使用</span>
          </div>
          <div class="proxy-endpoint text-muted">
            {{ item.protocol }}://{{ item.host }}:{{ item.port }}
          </div>
          <div
            v-if="rowResult(item.id)"
            class="proxy-test-msg text-caption"
            :class="rowResult(item.id)?.ok ? 'text-positive' : 'text-negative'"
          >
            <q-icon
              :name="rowResult(item.id)?.ok ? icons.checkCircle : icons.error"
              size="15px"
              class="q-mr-xs"
            />
            <span v-if="rowResult(item.id)?.ok">
              校验通过 · {{ rowResult(item.id)?.latencyMs }} ms
            </span>
            <span v-else>
              校验失败（{{ rowResult(item.id)?.latencyMs }} ms）：{{ rowResult(item.id)?.error }}
            </span>
          </div>
        </div>

        <div class="proxy-actions">
          <q-btn
            flat
            no-caps
            dense
            size="sm"
            color="primary"
            class="proxy-test-btn"
            :icon="icons.send"
            label="校验"
            :loading="testingId === item.id"
            @click="handleRowTest(item)"
          />
          <q-btn
            flat
            round
            dense
            size="sm"
            class="proxy-icon-btn"
            :icon="icons.edit"
            aria-label="编辑代理"
            @click="openEdit(item)"
          >
            <q-tooltip>编辑</q-tooltip>
          </q-btn>
          <q-btn
            flat
            round
            dense
            size="sm"
            color="negative"
            class="proxy-icon-btn"
            :icon="icons.delete"
            aria-label="删除代理"
            @click="handleDelete(item)"
          >
            <q-tooltip>删除</q-tooltip>
          </q-btn>
        </div>
      </div>
    </div>

    <!-- 添加 / 编辑代理弹窗 -->
    <q-dialog v-model="dialogOpen" :maximized="isMobile">
      <q-card class="proxy-dialog-card">
        <div class="dialog-head">
          <div class="dialog-title">{{ isEdit ? '编辑代理' : '添加代理' }}</div>
          <q-btn flat round dense :icon="icons.close" aria-label="关闭" :disable="saving" @click="dialogOpen = false" />
        </div>

        <q-separator />

        <div class="dialog-body">
          <q-input
            v-model="form.name"
            outlined
            dense
            maxlength="80"
            label="代理名称 *"
            placeholder="例如：本地 Clash、香港节点"
            :disable="saving"
          />

          <div class="addr-grid">
            <q-select
              v-model="form.protocol"
              :options="protocolOptions"
              option-label="label"
              option-value="value"
              emit-value
              map-options
              outlined
              dense
              label="协议 *"
              :disable="saving"
            />
            <q-input
              v-model="form.host"
              outlined
              dense
              label="主机地址 *"
              placeholder="127.0.0.1 或粘贴完整代理 URL"
              :disable="saving"
              @update:model-value="tryParsePastedUrl"
            />
            <q-input
              v-model.number="form.port"
              type="number"
              outlined
              dense
              :min="1"
              :max="65535"
              label="端口 *"
              :disable="saving"
            />
          </div>

          <div class="auth-grid">
            <q-input
              v-model="form.username"
              outlined
              dense
              autocomplete="off"
              label="用户名（可选）"
              :disable="saving"
            />
            <q-input
              v-model="form.password"
              type="password"
              outlined
              dense
              autocomplete="new-password"
              :label="isEdit && editingProxy?.hasPassword ? '密码（留空保持原密码）' : '密码（可选）'"
              :disable="saving || form.clearPassword"
            />
          </div>

          <q-checkbox
            v-if="isEdit && editingProxy?.hasPassword"
            v-model="form.clearPassword"
            dense
            label="清空已保存的代理密码"
            :disable="saving"
          />

          <q-banner
            v-if="dialogTestResult"
            rounded
            class="dialog-test-banner"
            :class="dialogTestResult.ok ? 'dialog-test-banner--ok' : 'dialog-test-banner--err'"
          >
            <template #avatar>
              <q-icon
                :name="dialogTestResult.ok ? icons.checkCircle : icons.error"
                :color="dialogTestResult.ok ? 'positive' : 'negative'"
                size="20px"
              />
            </template>
            <div v-if="dialogTestResult.ok">
              校验通过，耗时 {{ dialogTestResult.latencyMs }} ms
            </div>
            <div v-else>
              校验失败（{{ dialogTestResult.latencyMs }} ms）：{{ dialogTestResult.error }}
            </div>
          </q-banner>
        </div>

        <q-separator />

        <div class="dialog-foot">
          <q-btn
            outline
            no-caps
            color="primary"
            class="touch-44"
            :icon="icons.send"
            label="校验连接"
            :loading="dialogTesting"
            :disable="saving"
            @click="handleDialogTest"
          />
          <q-space />
          <q-btn flat no-caps label="取消" :disable="saving" @click="dialogOpen = false" />
          <q-btn unelevated no-caps color="primary" label="保存" :loading="saving" @click="handleSave" />
        </div>
      </q-card>
    </q-dialog>
  </div>
</template>

<style scoped lang="scss">
.card-head {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 10px;
}
.empty-proxy {
  padding: 14px;
  border-radius: var(--app-radius-sm);
  border: 1px dashed var(--app-border);
  background: var(--app-surface-2);
}
.proxy-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 290px;
  overflow-y: auto;
  padding-right: 2px;
}
.proxy-row {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--app-radius-sm);
  border: 1px solid var(--app-border);
  background: var(--app-surface-2);
}
.proxy-info {
  min-width: 0;
  flex: 1 1 240px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.proxy-title-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.proxy-name {
  font-size: 14px;
  font-weight: 600;
}
.proto-pill {
  font-weight: 600;
  font-size: 11px;
  padding: 0 7px;
  color: var(--q-primary);
  background: color-mix(in srgb, var(--q-primary) 10%, transparent);
  border-color: color-mix(in srgb, var(--q-primary) 24%, transparent);
}
.proxy-endpoint {
  font-size: 12.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  word-break: break-all;
}
.proxy-test-msg {
  display: inline-flex;
  align-items: center;
  margin-top: 2px;
}
.proxy-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.proxy-test-btn {
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  font-weight: 550;
  background: color-mix(in srgb, var(--q-primary) 11%, transparent);
  :deep(.q-icon) {
    font-size: 15px;
    margin-right: 4px;
  }
}
.proxy-icon-btn {
  width: 30px;
  height: 30px;
  color: var(--app-text-2);
  &:hover {
    background: var(--app-surface-3);
  }
}
.proxy-dialog-card {
  width: 520px;
  max-width: 96vw;
  background: var(--app-surface);
  color: var(--app-text);
  display: flex;
  flex-direction: column;
}
.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
}
.dialog-title {
  font-size: 16px;
  font-weight: 600;
}
.dialog-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.addr-grid {
  display: grid;
  grid-template-columns: 110px 1fr 100px;
  gap: 10px;
  @media (max-width: 540px) {
    grid-template-columns: 1fr;
  }
}
.auth-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  @media (max-width: 540px) {
    grid-template-columns: 1fr;
  }
}
.dialog-test-banner {
  font-size: 13px;
  color: var(--app-text);
}
.dialog-test-banner--ok {
  background: color-mix(in srgb, var(--q-positive) 14%, transparent);
}
.dialog-test-banner--err {
  background: color-mix(in srgb, var(--q-negative) 12%, transparent);
}
.dialog-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
}
</style>
