<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { requestScheduler } from '../services/requestScheduler';
import type { RequestSchedulerStatus } from '../services/requestContext';
import {
  globalRequestSpeedSettings,
  saveRequestSpeedSettings,
  type RequestSpeedMode,
} from '../services/requestSpeedSettings';

const props = defineProps<{ modelValue: RequestSpeedMode; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: RequestSpeedMode] }>();

const modes: Array<{ value: RequestSpeedMode; label: string; description: string }> = [
  { value: 'auto', label: '自动', description: '根据服务端状态自动升降速' },
  { value: 'conservative', label: '保守', description: '最低请求频率，适合账号保护优先' },
  { value: 'balanced', label: '均衡', description: '适中的扫描速度和请求间隔' },
  { value: 'fast', label: '快速', description: '更快读取，仍强制写入单并发和退避' },
];

const schedulerStatus = ref<RequestSchedulerStatus>(requestScheduler.getStatus());
const unsubscribe = requestScheduler.subscribe((status) => { schedulerStatus.value = status; });
onBeforeUnmount(unsubscribe);

const operationMode = computed({
  get: () => props.modelValue,
  set: (value: RequestSpeedMode) => emit('update:modelValue', value),
});
const globalEnabled = computed({
  get: () => globalRequestSpeedSettings.value.globalEnabled,
  set: (enabled: boolean) => saveRequestSpeedSettings(enabled, globalRequestSpeedSettings.value.globalMode),
});
const globalMode = computed({
  get: () => globalRequestSpeedSettings.value.globalMode,
  set: (mode: RequestSpeedMode) => saveRequestSpeedSettings(globalRequestSpeedSettings.value.globalEnabled, mode),
});
const statusText = computed(() => {
  const status = schedulerStatus.value;
  if (status.state === 'backoff' && status.retryAt) {
    return `退避保护中，预计 ${Math.max(1, Math.ceil((status.retryAt - Date.now()) / 1_000))} 秒后恢复`;
  }
  const adaptive = status.effectiveLevel
    ? `自动当前：${status.effectiveLevel === 'fast' ? '快速' : status.effectiveLevel === 'balanced' ? '均衡' : '保守'}，读取并发 ${status.readConcurrency || 1}，任务窗口 ${status.acceptedTaskWindow || 1}`
    : '';
  if (status.state === 'throttled') return `安全排队中（${status.queued} 个请求）${adaptive ? `；${adaptive}` : ''}`;
  if (status.state === 'running') return `请求处理中（运行 ${status.active}，排队 ${status.queued}）${adaptive ? `；${adaptive}` : ''}`;
  return adaptive || '请求调度器空闲';
});
</script>

<template>
  <section class="gya-speed-control" aria-label="请求速度设置">
    <div class="gya-speed-row">
      <label><b>本次操作档位</b>
        <select v-model="operationMode" :disabled="disabled">
          <option v-for="mode in modes" :key="mode.value" :value="mode.value">{{ mode.label }} — {{ mode.description }}</option>
        </select>
      </label>
      <small>开始扫描或执行后冻结，仅影响当前面板。</small>
    </div>
    <div class="gya-speed-global">
      <label class="gya-speed-check"><input v-model="globalEnabled" type="checkbox" :disabled="disabled"> 启用全局默认</label>
      <select v-model="globalMode" :disabled="disabled || !globalEnabled" aria-label="全局默认档位">
        <option v-for="mode in modes" :key="mode.value" :value="mode.value">{{ mode.label }}</option>
      </select>
      <small>全局默认只初始化新打开的面板，不覆盖本次选择。</small>
    </div>
    <div class="gya-speed-status" :class="`state-${schedulerStatus.state}`">
      <span class="gya-speed-dot" aria-hidden="true"></span>{{ statusText }}
    </div>
  </section>
</template>

<style scoped>
.gya-speed-control{display:grid;gap:8px;margin:10px 0 14px;padding:10px 12px;border:1px solid #dbeafe;border-radius:8px;background:#f8fbff;color:#334155}.gya-speed-row,.gya-speed-global{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.gya-speed-row label{display:flex;align-items:center;gap:8px}.gya-speed-control select{max-width:420px;border:1px solid #cbd5e1;border-radius:6px;padding:6px 8px;background:#fff}.gya-speed-control small{color:#64748b}.gya-speed-check{display:flex;align-items:center;gap:5px}.gya-speed-status{display:flex;align-items:center;gap:7px;font-size:12px;color:#475569}.gya-speed-dot{width:8px;height:8px;border-radius:50%;background:#94a3b8}.state-running .gya-speed-dot{background:#16a34a}.state-throttled .gya-speed-dot{background:#d97706}.state-backoff{color:#b45309}.state-backoff .gya-speed-dot{background:#dc2626}@media(max-width:620px){.gya-speed-row,.gya-speed-global{align-items:stretch;flex-direction:column}.gya-speed-row label{align-items:stretch;flex-direction:column}.gya-speed-control select{max-width:none;width:100%}}
</style>
