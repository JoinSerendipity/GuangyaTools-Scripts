<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import BatchRenamePanel from './components/BatchRenamePanel.vue';
import CleanerPanel from './components/CleanerPanel.vue';
import FlattenPanel from './components/FlattenPanel.vue';
import { getAuthContext, onAuthContext } from './services/authCapture';
import { GuangyaApi } from './services/guangyaApi';
import {
  getCurrentDirectory,
  getSelectedNames,
  observePageState,
  requestNativeRefresh,
  resolveSelectedItems,
} from './services/pageAdapter';
import type { DirectoryRef, GuangyaItem } from './types';

const api = new GuangyaApi();
const directory = ref<DirectoryRef | null>(getCurrentDirectory());
const selectedCount = ref(getSelectedNames().length);
const authReady = ref(Boolean(getAuthContext()));
const cleanerOpen = ref(false);
const flattenOpen = ref(false);
const flattenDirectories = ref<GuangyaItem[]>([]);
const batchRenameOpen = ref(false);
const batchRenameItems = ref<GuangyaItem[]>([]);
const resolving = ref<'flatten' | 'rename' | null>(null);
const notice = ref('');
let stopObserve: (() => void) | undefined;
let stopAuth: (() => void) | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

const visible = computed(() => Boolean(directory.value));

function syncPageState(): void {
  const nextDirectory = getCurrentDirectory();
  const routeChanged = directory.value?.id !== nextDirectory?.id;
  if (routeChanged && (cleanerOpen.value || flattenOpen.value || batchRenameOpen.value)) {
    cleanerOpen.value = false;
    flattenOpen.value = false;
    batchRenameOpen.value = false;
    showNotice('目录已经变化，进行中的工具操作已取消，请重新选择');
  }
  directory.value = nextDirectory;
  selectedCount.value = getSelectedNames().length;
}

function showNotice(message: string): void {
  notice.value = message;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.value = ''; }, 5000);
}

async function openFlatten(): Promise<void> {
  const originDirectoryId = directory.value?.id;
  if (originDirectoryId === undefined) return;
  resolving.value = 'flatten';
  try {
    const selected = await resolveSelectedItems(api);
    if (directory.value?.id !== originDirectoryId || getCurrentDirectory()?.id !== originDirectoryId) {
      showNotice('目录已经变化，请重新选择项目后重试');
      return;
    }
    const folders = selected.filter((item) => item.resType === 2);
    if (!folders.length) {
      showNotice(selected.length ? '请选择目录，文件项不会参与解散' : '未能读取选择项，请重新勾选目录后重试');
      return;
    }
    flattenDirectories.value = folders;
    flattenOpen.value = true;
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error));
  } finally {
    resolving.value = null;
  }
}

async function openBatchRename(): Promise<void> {
  const originDirectoryId = directory.value?.id;
  if (originDirectoryId === undefined) return;
  resolving.value = 'rename';
  try {
    const selected = await resolveSelectedItems(api);
    if (directory.value?.id !== originDirectoryId || getCurrentDirectory()?.id !== originDirectoryId) {
      showNotice('目录已经变化，请重新选择项目后重试');
      return;
    }
    if (!selected.length) {
      showNotice('未能读取选择项，请重新勾选文件或目录后重试');
      return;
    }
    batchRenameItems.value = selected;
    batchRenameOpen.value = true;
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error));
  } finally {
    resolving.value = null;
  }
}

function handleCompleted(): void {
  const refreshed = requestNativeRefresh();
  showNotice(refreshed ? '操作完成，已请求页面重新拉取' : '操作完成，请手动刷新文件列表');
}

onMounted(() => {
  stopObserve = observePageState(syncPageState);
  stopAuth = onAuthContext(() => { authReady.value = true; });
});
onBeforeUnmount(() => {
  stopObserve?.();
  stopAuth?.();
  if (noticeTimer) clearTimeout(noticeTimer);
});
</script>

<template>
  <div v-if="visible" class="gya-entry">
    <button :disabled="!authReady" title="按规则扫描并移入回收站" @click="cleanerOpen = true">清理文件</button>
    <button :disabled="!authReady || !selectedCount || Boolean(resolving)" title="将选中目录的后代文件移动到选中目录" @click="openFlatten">
      {{ resolving === 'flatten' ? '读取选择中…' : `解散子目录${selectedCount ? ` (${selectedCount})` : ''}` }}
    </button>
    <button :disabled="!authReady || !selectedCount || Boolean(resolving)" title="按规则批量修改选中文件和目录的名称" @click="openBatchRename">
      {{ resolving === 'rename' ? '读取选择中…' : `批量重命名${selectedCount ? ` (${selectedCount})` : ''}` }}
    </button>
    <span v-if="!authReady" class="gya-auth">等待页面鉴权…</span>
    <span v-if="notice" class="gya-notice">{{ notice }}</span>
  </div>

  <CleanerPanel v-if="cleanerOpen && directory" :api="api" :directory="directory" @close="cleanerOpen = false" @completed="handleCompleted" />
  <FlattenPanel v-if="flattenOpen && directory" :api="api" :directories="flattenDirectories" :origin-directory-id="directory.id" @close="flattenOpen = false" @completed="handleCompleted" />
  <BatchRenamePanel v-if="batchRenameOpen && directory" :api="api" :items="batchRenameItems" :directory="directory" @close="batchRenameOpen = false" @completed="handleCompleted" />
</template>

<style scoped>
.gya-entry{display:inline-flex;align-items:center;gap:8px;margin-left:8px;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;position:relative;z-index:20}.gya-entry>button{border:1px solid #fb923c;background:#fff7ed;color:#c2410c;border-radius:7px;padding:7px 11px;cursor:pointer;white-space:nowrap}.gya-entry>button+button{border-color:#60a5fa;background:#eff6ff;color:#1d4ed8}.gya-entry>button:disabled{opacity:.5;cursor:not-allowed}.gya-auth{font-size:12px;color:#64748b}.gya-notice{position:fixed;right:24px;top:24px;z-index:2147483646;max-width:420px;padding:10px 14px;border-radius:8px;background:#0f172a;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.2)}
</style>
