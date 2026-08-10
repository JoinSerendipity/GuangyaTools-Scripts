<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import ConfirmDialog from './ConfirmDialog.vue';
import RequestSpeedControl from './RequestSpeedControl.vue';
import type { CleanupMatch, CleanupRule, DirectoryRef, GuangyaItem, ProgressInfo } from '../types';
import { FileType } from '../types';
import type { GuangyaApiLike } from '../services/guangyaApi';
import { scanCleanup, trashCleanupItems } from '../services/cleaner';
import {
  clearCleanerDefaults,
  createCleanupRule,
  loadCleanerDefaults,
  saveCleanerDefaults,
  type LoadedCleanerDefaults,
} from '../services/cleanerDefaults';
import { getCurrentDirectory } from '../services/pageAdapter';
import { useConfirmation } from '../composables/useConfirmation';
import { createOperationRequestContext } from '../services/requestContext';
import { initializeOperationSpeedMode } from '../services/requestSpeedSettings';
import { ProgressTracker } from '../services/progressTracker';

const props = defineProps<{ api: GuangyaApiLike; directory: DirectoryRef }>();
const emit = defineEmits<{ close: []; completed: [] }>();
const {
  confirmation,
  askConfirmation,
  confirmConfirmation,
  cancelConfirmation,
  disposeConfirmation,
} = useConfirmation();

const fileTypes = [
  [FileType.IMAGE, '图片'], [FileType.VIDEO, '视频'], [FileType.AUDIO, '音频'],
  [FileType.DOCUMENT, '文档'], [FileType.ARCHIVE, '压缩包'], [FileType.SUBTITLE, '字幕'],
  [FileType.FONT, '字体'], [FileType.INSTALLER, '安装包'], [FileType.TORRENT, '种子'],
  [FileType.CODE, '代码'], [FileType.OTHER, '其他'], [FileType.UNKNOWN, '未知'],
] as const;

const speedMode = ref(initializeOperationSpeedMode());
const initialDefaults = loadCleanerDefaults();
const rules = ref<CleanupRule[]>(initialDefaults.rules);
const recursive = ref(initialDefaults.recursive);
const saveRecursiveSetting = ref(initialDefaults.includesRecursive);
const hasSavedDefaults = ref(initialDefaults.source === 'saved');
const presetMessage = ref(initialDefaults.message || (initialDefaults.source === 'saved' ? '已自动加载保存的默认规则' : ''));
const matches = ref<CleanupMatch[]>([]);
const selectedIds = ref(new Set<string>());
const busy = ref(false);
const progress = ref<ProgressInfo | null>(null);
const progressPercent = computed(() => {
  if (!progress.value || progress.value.total <= 0) return 0;
  return Math.round(Math.min(100, Math.max(0, (progress.value.current / progress.value.total) * 100)));
});
const errorMessage = ref('');
const failedItems = ref<GuangyaItem[]>([]);
const page = ref(1);
const pageSize = 50;
let controller: AbortController | null = null;
const progressTracker = new ProgressTracker((value) => { progress.value = value; });

const selectedItems = computed(() => matches.value.filter(({ item }) => selectedIds.value.has(item.fileId)).map(({ item }) => item));
const selectedSize = computed(() => selectedItems.value.reduce((sum, item) => sum + (item.resType === 1 ? item.fileSize : 0), 0));
const totalPages = computed(() => Math.max(1, Math.ceil(matches.value.length / pageSize)));
const pageMatches = computed(() => matches.value.slice((page.value - 1) * pageSize, page.value * pageSize));

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function addRule(): void { rules.value.push(createCleanupRule('fileName')); }
function removeRule(index: number): void { rules.value.splice(index, 1); }
function clearScanResults(): void {
  matches.value = [];
  selectedIds.value = new Set();
  failedItems.value = [];
  progress.value = null;
  page.value = 1;
}
function applyDefaults(loaded: LoadedCleanerDefaults, message: string): void {
  rules.value = loaded.rules;
  recursive.value = loaded.recursive;
  saveRecursiveSetting.value = loaded.includesRecursive;
  hasSavedDefaults.value = loaded.source === 'saved';
  presetMessage.value = loaded.message || message;
  errorMessage.value = '';
  clearScanResults();
}
function saveCurrentDefaults(): void {
  errorMessage.value = '';
  try {
    saveCleanerDefaults(rules.value, {
      includeRecursive: saveRecursiveSetting.value,
      recursive: recursive.value,
    });
    hasSavedDefaults.value = true;
    presetMessage.value = saveRecursiveSetting.value
      ? `已保存 ${rules.value.length} 条默认规则，并记住“包含全部子目录”为${recursive.value ? '开启' : '关闭'}`
      : `已保存 ${rules.value.length} 条默认规则；未保存递归设置`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}
function restoreSavedDefaults(): void {
  const loaded = loadCleanerDefaults();
  applyDefaults(loaded, loaded.source === 'saved' ? '已恢复保存的默认规则' : '没有可恢复的已保存默认规则');
}
async function restoreBuiltInDefaults(): Promise<void> {
  if (hasSavedDefaults.value && !await askConfirmation({
    title: '清除已保存的默认规则',
    message: '将删除已保存的规则和递归设置，并恢复内置 txt 后缀规则。此操作不会清理任何网盘文件。',
    confirmText: '清除并恢复',
    danger: true,
  })) return;
  applyDefaults(clearCleanerDefaults(), '已清除保存并恢复内置 txt 默认规则');
}
function toggleItem(fileId: string, checked: boolean): void {
  const next = new Set(selectedIds.value);
  checked ? next.add(fileId) : next.delete(fileId);
  selectedIds.value = next;
}
function selectAll(): void { selectedIds.value = new Set(matches.value.map(({ item }) => item.fileId)); }
function selectNone(): void { selectedIds.value = new Set(); }
function updateProgress(value: ProgressInfo): void { progressTracker.update(value); }

async function scan(): Promise<void> {
  busy.value = true;
  errorMessage.value = '';
  failedItems.value = [];
  controller = new AbortController();
  progressTracker.reset();
  const context = createOperationRequestContext(speedMode.value, { signal: controller.signal });
  try {
    matches.value = await scanCleanup(props.api, props.directory.id, rules.value, {
      recursive: recursive.value,
      signal: controller.signal,
      context,
      onProgress: updateProgress,
    });
    progressTracker.finish({ phase: 'scan', message: `扫描完成，命中 ${matches.value.length} 项` });
    selectAll();
    page.value = 1;
  } catch (error) {
    if (!controller.signal.aborted) errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
    controller = null;
  }
}

async function retryFailures(): Promise<void> {
  busy.value = true;
  errorMessage.value = '';
  controller = new AbortController();
  progressTracker.reset();
  const context = createOperationRequestContext(speedMode.value, { signal: controller.signal });
  let present: GuangyaItem[] = [];
  try {
    const currentItems = recursive.value
      ? (await props.api.walkDescendants(props.directory.id, { signal: controller.signal, context, onProgress: updateProgress })).items
      : await props.api.listAllChildren(props.directory.id, { signal: controller.signal, context });
    const currentIds = new Set(currentItems.map((item) => item.fileId));
    present = failedItems.value.filter((item) => currentIds.has(item.fileId));
    const goneIds = new Set(failedItems.value.filter((item) => !currentIds.has(item.fileId)).map((item) => item.fileId));
    if (goneIds.size) {
      matches.value = matches.value.filter(({ item }) => !goneIds.has(item.fileId));
      emit('completed');
    }
    failedItems.value = present;
  } catch (error) {
    if (!controller.signal.aborted) errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
    controller = null;
  }
  if (present.length) await execute(present);
  else if (!errorMessage.value) errorMessage.value = '失败项已经不在当前目录中，已按最新列表刷新结果';
}

async function execute(items = selectedItems.value): Promise<void> {
  if (!items.length) return;
  const current = getCurrentDirectory();
  if (!current || current.id !== props.directory.id) {
    errorMessage.value = '当前目录已经变化，请关闭面板后重新扫描';
    return;
  }
  if (!await askConfirmation({
    title: '将选中项移入回收站',
    message: `即将把 ${items.length} 项移入回收站，文件合计 ${formatSize(items.reduce((s, i) => s + (i.resType === 1 ? i.fileSize : 0), 0))}。不会永久删除或清空回收站。`,
    confirmText: '移入回收站',
    danger: true,
  })) return;
  const confirmedCurrent = getCurrentDirectory();
  if (!confirmedCurrent || confirmedCurrent.id !== props.directory.id) {
    errorMessage.value = '确认期间当前目录已经变化，请关闭面板后重新扫描';
    return;
  }

  busy.value = true;
  errorMessage.value = '';
  controller = new AbortController();
  progressTracker.reset();
  const context = createOperationRequestContext(speedMode.value, { signal: controller.signal });
  try {
    const latestWalk = recursive.value
      ? await props.api.walkDescendants(props.directory.id, { signal: controller.signal, context, purpose: 'verification', onProgress: updateProgress })
      : null;
    if (latestWalk?.complete === false) throw new Error(latestWalk.incompleteReason || '执行前复扫不完整');
    const latestItems = latestWalk?.items
      ?? await props.api.listAllChildren(props.directory.id, { signal: controller.signal, context, purpose: 'verification', onProgress: updateProgress });
    const latestIds = new Set(latestItems.map((item) => item.fileId));
    const missing = items.filter((item) => !latestIds.has(item.fileId));
    if (missing.length) {
      errorMessage.value = `确认后有 ${missing.length} 个选中项已不在完整复扫结果中，请重新预扫描`;
      return;
    }
    const summary = await trashCleanupItems(props.api, items, {
      signal: controller.signal,
      context,
      onProgress: updateProgress,
    });
    progressTracker.finish({ phase: 'trash', message: summary.outcomeUnknown ? '操作结果未知，请刷新确认' : '回收站操作完成' });
    const succeeded = new Set(summary.succeeded.map((item) => item.fileId));
    matches.value = matches.value.filter(({ item }) => !succeeded.has(item.fileId));
    failedItems.value = [...summary.failed.flatMap((failure) => failure.items), ...(summary.unsubmitted || [])];
    selectedIds.value = new Set(failedItems.value.map((item) => item.fileId));
    if (summary.outcomeUnknown) errorMessage.value = '存在结果未知的批次，已停止后续操作，请刷新目录确认后再重试';
    else if (summary.failed.length || summary.unsubmitted?.length) errorMessage.value = `${summary.failed.length} 个批次失败或被限流停止，可点击“重试失败项”`;
    if (summary.succeeded.length) emit('completed');
  } catch (error) {
    if (!controller.signal.aborted) errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
    controller = null;
  }
}

function cancel(): void {
  progressTracker.stop();
  controller?.abort(new DOMException('用户取消操作', 'AbortError'));
}
onBeforeUnmount(() => {
  cancel();
  disposeConfirmation();
});
</script>

<template>
  <Teleport to="body">
    <div class="gya-mask" @click.self="!busy && emit('close')">
      <section class="gya-panel" aria-label="光鸭文件清理工具">
        <header>
          <div><h2>清理文件</h2><p>当前目录：{{ directory.name }}</p></div>
          <button class="gya-close" :disabled="busy" @click="emit('close')">×</button>
        </header>

        <div class="gya-scope">
          <label><input v-model="recursive" type="checkbox" :disabled="busy"> 包含全部子目录（更慢且影响范围更大）</label>
          <span>删除仅进入回收站，不会永久删除。</span>
        </div>
        <RequestSpeedControl v-model="speedMode" :disabled="busy" />

        <div class="gya-rules">
          <div v-for="(rule, index) in rules" :key="rule.id" class="gya-rule">
            <input v-model="rule.enabled" type="checkbox" :disabled="busy" title="启用规则">
            <select v-model="rule.kind" :disabled="busy">
              <option value="suffix">后缀</option><option value="fileType">文件类型</option>
              <option value="fileName">文件名关键词</option><option value="dirName">目录名关键词</option>
            </select>
            <select v-if="rule.kind === 'fileType'" v-model.number="rule.fileType" :disabled="busy">
              <option v-for="entry in fileTypes" :key="entry[0]" :value="entry[0]">{{ entry[1] }}</option>
            </select>
            <input v-else v-model="rule.pattern" :placeholder="rule.kind === 'suffix' ? '例如 txt' : '关键词或正则'" :disabled="busy">
            <select v-if="rule.kind === 'fileName' || rule.kind === 'dirName'" v-model="rule.matchMode" :disabled="busy">
              <option value="contains">包含</option><option value="equals">完整匹配</option><option value="regex">正则</option>
            </select>
            <label v-if="rule.kind !== 'fileType'" class="gya-mini"><input v-model="rule.caseSensitive" type="checkbox" :disabled="busy"> 区分大小写</label>
            <label v-if="rule.kind !== 'dirName'" class="gya-size">≤ <input v-model.number="rule.maxSizeMb" type="number" min="0" step="0.1" placeholder="不限" :disabled="busy"> MB</label>
            <button class="gya-danger-link" :disabled="busy || rules.length === 1" @click="removeRule(index)">删除</button>
          </div>
          <button class="gya-secondary" :disabled="busy" @click="addRule">＋ 添加规则</button>
        </div>

        <div class="gya-defaults">
          <label><input v-model="saveRecursiveSetting" type="checkbox" :disabled="busy"> 保存时同时记住“包含全部子目录”设置</label>
          <div class="gya-default-buttons">
            <button class="gya-secondary" :disabled="busy" @click="saveCurrentDefaults">保存当前为默认</button>
            <button class="gya-secondary" :disabled="busy || !hasSavedDefaults" @click="restoreSavedDefaults">恢复已保存默认</button>
            <button class="gya-secondary" :disabled="busy" @click="restoreBuiltInDefaults">清除保存并恢复内置默认</button>
          </div>
        </div>
        <p v-if="presetMessage" class="gya-preset-message">{{ presetMessage }}</p>

        <div class="gya-actions">
          <button class="gya-primary" :disabled="busy" @click="scan">预扫描</button>
          <button v-if="busy" class="gya-secondary" @click="cancel">取消后续操作</button>
        </div>
        <div v-if="progress" class="gya-progress" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100">
          <div class="gya-progress-head"><span>{{ progress.message }}</span><b>{{ progressPercent }}%</b></div>
          <div class="gya-progress-track"><span :style="{ width: `${progressPercent}%` }"></span></div>
        </div>
        <p v-if="errorMessage" class="gya-error">{{ errorMessage }}</p>

        <template v-if="matches.length">
          <div class="gya-summary">
            <b>命中 {{ matches.length }} 项，已选 {{ selectedItems.length }} 项 / {{ formatSize(selectedSize) }}</b>
            <span><button @click="selectAll">全选</button> · <button @click="selectNone">全不选</button></span>
          </div>
          <div class="gya-table-wrap">
            <table><thead><tr><th></th><th>名称</th><th>类型</th><th>大小</th><th>命中规则</th></tr></thead>
              <tbody><tr v-for="match in pageMatches" :key="match.item.fileId">
                <td><input type="checkbox" :checked="selectedIds.has(match.item.fileId)" :disabled="busy" @change="toggleItem(match.item.fileId, ($event.target as HTMLInputElement).checked)"></td>
                <td :title="match.item.fileName">{{ match.item.fileName }}</td><td>{{ match.item.resType === 2 ? '目录' : (match.item.ext || '文件') }}</td>
                <td>{{ match.item.resType === 1 ? formatSize(match.item.fileSize) : '-' }}</td><td>{{ match.ruleIds.length }}</td>
              </tr></tbody></table>
          </div>
          <div class="gya-pagination"><button :disabled="page <= 1" @click="page--">上一页</button><span>{{ page }} / {{ totalPages }}</span><button :disabled="page >= totalPages" @click="page++">下一页</button></div>
          <footer>
            <button v-if="failedItems.length" class="gya-secondary" :disabled="busy" @click="retryFailures">重新扫描并重试失败项（{{ failedItems.length }}）</button>
            <button class="gya-danger" :disabled="busy || !selectedItems.length" @click="execute()">将选中项移入回收站</button>
          </footer>
        </template>
      </section>
    </div>
  </Teleport>
  <ConfirmDialog
    :options="confirmation"
    @confirm="confirmConfirmation"
    @cancel="cancelConfirmation"
  />
</template>

<style scoped>
.gya-mask{position:fixed;inset:0;z-index:2147483645;background:rgba(15,23,42,.42);display:flex;justify-content:flex-end;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2937}.gya-panel{width:min(980px,94vw);height:100vh;overflow:auto;background:#fff;padding:20px 24px;box-sizing:border-box;box-shadow:-8px 0 30px rgba(0,0,0,.16)}header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #e5e7eb;margin-bottom:14px}h2{margin:0;font-size:22px}header p{margin:4px 0 14px;color:#64748b}.gya-close{border:0;background:none;font-size:30px;cursor:pointer}.gya-scope{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;background:#fff7ed;border-radius:8px;color:#9a3412}.gya-rules{margin:14px 0}.gya-defaults{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px}.gya-default-buttons{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}.gya-preset-message{margin:8px 0;color:#1d4ed8;background:#eff6ff;padding:7px 10px;border-radius:6px}.gya-rule{display:grid;grid-template-columns:auto 120px minmax(150px,1fr) 105px auto 135px auto;gap:8px;align-items:center;margin:8px 0}.gya-rule input,.gya-rule select{border:1px solid #cbd5e1;border-radius:6px;padding:7px;min-width:0}.gya-mini,.gya-size{white-space:nowrap;font-size:12px}.gya-size input{width:66px}.gya-actions,.gya-summary,footer,.gya-pagination{display:flex;align-items:center;gap:10px}.gya-actions{margin:14px 0}.gya-progress{margin:10px 0 12px}.gya-progress-head{display:flex;justify-content:space-between;gap:12px;color:#475569;font-size:13px}.gya-progress-track{height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;margin-top:5px}.gya-progress-track span{display:block;height:100%;background:linear-gradient(90deg,#2563eb,#60a5fa);transition:width .2s ease}.gya-summary{justify-content:space-between;margin-top:16px}.gya-summary button,.gya-pagination button{border:0;background:none;color:#2563eb;cursor:pointer}.gya-primary,.gya-secondary,.gya-danger{border:0;border-radius:7px;padding:8px 14px;cursor:pointer}.gya-primary{background:#2563eb;color:#fff}.gya-secondary{background:#e2e8f0;color:#1e293b}.gya-danger{background:#dc2626;color:#fff}.gya-danger-link{border:0;background:none;color:#dc2626;cursor:pointer}.gya-error{color:#b91c1c;background:#fef2f2;padding:8px 10px;border-radius:6px}.gya-table-wrap{overflow:auto;max-height:44vh;margin-top:8px;border:1px solid #e5e7eb;border-radius:7px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #f1f5f9;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}th{position:sticky;top:0;background:#f8fafc}.gya-pagination{justify-content:center;margin:8px}footer{justify-content:flex-end;margin-top:12px}button:disabled{opacity:.5;cursor:not-allowed}@media(max-width:760px){.gya-rule{grid-template-columns:auto 1fr}.gya-scope,.gya-defaults{flex-direction:column;align-items:stretch}.gya-default-buttons{justify-content:flex-start}.gya-panel{padding:14px}}
</style>
