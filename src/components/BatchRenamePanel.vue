<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { BatchRenameRules, DirectoryRef, GuangyaItem, ProgressInfo, RenameConflictPolicy, RenamePlanEntry } from '../types';
import type { GuangyaApiLike } from '../services/guangyaApi';
import {
  DEFAULT_BATCH_RENAME_RULES,
  createBatchRenamePlan,
  executeBatchRename,
  splitFileName,
} from '../services/batchRename';
import { getCurrentDirectory } from '../services/pageAdapter';

const props = defineProps<{ api: GuangyaApiLike; items: GuangyaItem[]; directory: DirectoryRef }>();
const emit = defineEmits<{ close: []; completed: [] }>();

const rules = ref<BatchRenameRules>({ ...DEFAULT_BATCH_RENAME_RULES });
const conflictPolicy = ref<RenameConflictPolicy>('skip');
const siblings = ref<GuangyaItem[]>([]);
const manualOverrides = ref<Record<string, string>>({});
const busy = ref(false);
const loaded = ref(false);
const completed = ref(false);
const progress = ref<ProgressInfo | null>(null);
const errorMessage = ref('');
const executionResult = ref<Awaited<ReturnType<typeof executeBatchRename>> | null>(null);
let controller: AbortController | null = null;

const plan = computed(() => createBatchRenamePlan(
  props.items,
  siblings.value,
  rules.value,
  conflictPolicy.value,
  manualOverrides.value,
));
const counts = computed(() => plan.value.entries.reduce((sum, entry) => {
  sum[entry.status] += 1;
  return sum;
}, { ready: 0, unchanged: 0, invalid: 0, conflict: 0 }));
const progressPercent = computed(() => {
  if (!progress.value || progress.value.total <= 0) return 0;
  return Math.round(Math.min(100, Math.max(0, (progress.value.current / progress.value.total) * 100)));
});

function updateProgress(value: ProgressInfo): void { progress.value = value; }
function fixedExtension(entry: RenamePlanEntry): string {
  return rules.value.preserveExtension && entry.item.resType === 1
    ? splitFileName(entry.item.fileName).extension
    : '';
}
function editableName(entry: RenamePlanEntry): string {
  const extension = fixedExtension(entry);
  return extension ? entry.finalName.slice(0, Math.max(0, entry.finalName.length - extension.length)) : entry.finalName;
}
function setManualName(entry: RenamePlanEntry, value: string): void {
  manualOverrides.value = { ...manualOverrides.value, [entry.item.fileId]: `${value}${fixedExtension(entry)}` };
}
function resetManualName(fileId: string): void {
  const next = { ...manualOverrides.value };
  delete next[fileId];
  manualOverrides.value = next;
}
function resetAllManualNames(): void { manualOverrides.value = {}; }
watch(() => rules.value.preserveExtension, resetAllManualNames);
function statusText(entry: RenamePlanEntry): string {
  if (entry.status === 'ready' && entry.finalName !== entry.requestedName) return '自动避让重名';
  if (entry.status === 'ready') return '待重命名';
  if (entry.status === 'unchanged') return '名称未变化';
  if (entry.status === 'invalid') return entry.reason || '名称无效';
  return entry.reason || '名称冲突';
}
function failurePhaseText(phase: string): string {
  if (phase === 'temporary') return '创建中转名称';
  if (phase === 'rollback') return '回滚';
  if (phase === 'blocked') return '依赖阻塞';
  return '重命名';
}
function ensureDirectory(): boolean {
  if (getCurrentDirectory()?.id === props.directory.id) return true;
  errorMessage.value = '当前目录已经变化，批量重命名已取消，请重新选择项目';
  return false;
}

async function loadSiblings(): Promise<void> {
  if (!ensureDirectory()) return;
  busy.value = true;
  errorMessage.value = '';
  controller = new AbortController();
  try {
    siblings.value = await props.api.listAllChildren(props.directory.id, {
      signal: controller.signal,
      onProgress: updateProgress,
    });
    loaded.value = true;
    updateProgress({ phase: 'rename-preview', message: `已读取当前目录 ${siblings.value.length} 项`, current: 1, total: 1 });
  } catch (error) {
    if (!controller.signal.aborted) errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
    controller = null;
  }
}

async function execute(): Promise<void> {
  if (!loaded.value || completed.value || !ensureDirectory()) return;

  // 执行前重新读取同目录名称，避免预览期间其他页面操作让冲突信息过期。
  busy.value = true;
  errorMessage.value = '';
  controller = new AbortController();
  try {
    const latestSiblings = await props.api.listAllChildren(props.directory.id, {
      signal: controller.signal,
      onProgress: updateProgress,
    });
    const latestIds = new Set(latestSiblings.map((item) => item.fileId));
    const missing = props.items.filter((item) => !latestIds.has(item.fileId));
    if (missing.length) {
      errorMessage.value = `有 ${missing.length} 个选中项已不在当前目录，请刷新后重新选择`;
      return;
    }
    siblings.value = latestSiblings;
  } catch (error) {
    if (!controller.signal.aborted) errorMessage.value = error instanceof Error ? error.message : String(error);
    return;
  } finally {
    busy.value = false;
    controller = null;
  }
  if (!ensureDirectory()) return;

  const currentPlan = plan.value;
  if (!currentPlan.ready.length) {
    errorMessage.value = '没有可执行的名称变更，请检查规则、非法名称和冲突项';
    return;
  }
  const skipped = currentPlan.entries.length - currentPlan.ready.length;
  const conflictText = conflictPolicy.value === 'skip' ? '冲突项会跳过' : '冲突项会自动追加 (1)、(2) 等';
  if (!window.confirm(`将重命名 ${currentPlan.ready.length} 项，另有 ${skipped} 项不执行；${conflictText}。是否继续？`)) return;

  busy.value = true;
  errorMessage.value = '';
  executionResult.value = null;
  controller = new AbortController();
  try {
    executionResult.value = await executeBatchRename(props.api, currentPlan, siblings.value, {
      signal: controller.signal,
      onProgress: updateProgress,
    });
    completed.value = true;
    if (executionResult.value.succeeded.length) emit('completed');
    if (executionResult.value.failures.length) errorMessage.value = '部分项目重命名失败，请查看下方失败详情并刷新目录确认。';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
    controller = null;
  }
}

function cancel(): void { controller?.abort(new DOMException('用户取消操作', 'AbortError')); }
onMounted(loadSiblings);
onBeforeUnmount(cancel);
</script>

<template>
  <Teleport to="body">
    <div class="gya-mask" @click.self="!busy && emit('close')">
      <section class="gya-panel" aria-label="光鸭批量重命名工具">
        <header>
          <div><h2>批量重命名</h2><p>当前目录：{{ directory.name }}；已选择 {{ items.length }} 项</p></div>
          <button class="gya-close" :disabled="busy" @click="emit('close')">×</button>
        </header>

        <div class="gya-rules">
          <fieldset>
            <legend>查找替换</legend>
            <div class="gya-grid gya-replace-grid">
              <label>查找<input v-model="rules.search" :disabled="busy || completed" placeholder="留空表示不替换"></label>
              <label>替换为<input v-model="rules.replacement" :disabled="busy || completed" placeholder="可留空"></label>
              <label class="gya-check"><input v-model="rules.useRegex" type="checkbox" :disabled="busy || completed"> 正则表达式</label>
              <label class="gya-check"><input v-model="rules.caseSensitive" type="checkbox" :disabled="busy || completed"> 区分大小写</label>
            </div>
          </fieldset>

          <fieldset>
            <legend>前后缀与扩展名</legend>
            <div class="gya-grid gya-affix-grid">
              <label>前缀<input v-model="rules.prefix" :disabled="busy || completed" placeholder="添加到名称前"></label>
              <label>后缀<input v-model="rules.suffix" :disabled="busy || completed" placeholder="添加到主名称后"></label>
              <label class="gya-check"><input v-model="rules.preserveExtension" type="checkbox" :disabled="busy || completed"> 文件保留扩展名（默认）</label>
            </div>
          </fieldset>

          <fieldset class="gya-sequence-field">
            <legend><label class="gya-check"><input v-model="rules.sequenceEnabled" type="checkbox" :disabled="busy || completed"> 添加递增序号</label></legend>
            <div class="gya-grid gya-sequence-grid">
              <label>起始值<input v-model.number="rules.sequenceStart" type="number" step="1" :disabled="busy || completed || !rules.sequenceEnabled"></label>
              <label>步长<input v-model.number="rules.sequenceStep" type="number" step="1" :disabled="busy || completed || !rules.sequenceEnabled"></label>
              <label>补零位数<input v-model.number="rules.sequencePadding" type="number" min="1" max="12" :disabled="busy || completed || !rules.sequenceEnabled"></label>
              <label>位置<select v-model="rules.sequencePosition" :disabled="busy || completed || !rules.sequenceEnabled"><option value="prefix">名称前</option><option value="suffix">名称后</option></select></label>
              <label>分隔符<input v-model="rules.sequenceSeparator" :disabled="busy || completed || !rules.sequenceEnabled" placeholder="例如 _"></label>
            </div>
          </fieldset>

          <fieldset>
            <legend>冲突处理</legend>
            <label class="gya-policy"><input v-model="conflictPolicy" type="radio" value="skip" :disabled="busy || completed"><span><b>跳过冲突</b><small>冲突项不处理，其他项目继续。</small></span></label>
            <label class="gya-policy"><input v-model="conflictPolicy" type="radio" value="auto-suffix" :disabled="busy || completed"><span><b>自动追加 (1)、(2)</b><small>在扩展名前自动分配可用名称。</small></span></label>
          </fieldset>
        </div>

        <div v-if="progress" class="gya-progress" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100">
          <div class="gya-progress-head"><span>{{ progress.message }}</span><b>{{ progressPercent }}%</b></div>
          <div class="gya-progress-track"><span :style="{ width: `${progressPercent}%` }"></span></div>
        </div>
        <p v-if="errorMessage" class="gya-error">{{ errorMessage }}</p>

        <template v-if="loaded">
          <div class="gya-summary">
            <b>待重命名 {{ counts.ready }}；未变化 {{ counts.unchanged }}；非法 {{ counts.invalid }}；冲突跳过 {{ counts.conflict }}</b>
            <button v-if="Object.keys(manualOverrides).length" :disabled="busy || completed" @click="resetAllManualNames">清空逐项编辑</button>
          </div>
          <div class="gya-table-wrap">
            <table>
              <thead><tr><th>#</th><th>原名称</th><th>新名称（可逐项编辑）</th><th>状态</th><th></th></tr></thead>
              <tbody><tr v-for="(entry, index) in plan.entries" :key="entry.item.fileId" :class="`status-${entry.status}`">
                <td>{{ index + 1 }}</td>
                <td :title="entry.originalName">{{ entry.originalName }}</td>
                <td>
                  <div class="gya-name-editor">
                    <input :value="editableName(entry)" :disabled="busy || completed" @input="setManualName(entry, ($event.target as HTMLInputElement).value)">
                    <span v-if="fixedExtension(entry)" class="gya-extension">{{ fixedExtension(entry) }}</span>
                  </div>
                  <small v-if="entry.finalName !== entry.requestedName">请求：{{ entry.requestedName }}</small>
                </td>
                <td :title="entry.reason"><span class="gya-status">{{ statusText(entry) }}</span></td>
                <td><button v-if="entry.manual" class="gya-link" :disabled="busy || completed" @click="resetManualName(entry.item.fileId)">恢复规则</button></td>
              </tr></tbody>
            </table>
          </div>

          <template v-if="executionResult">
            <div class="gya-result">成功 {{ executionResult.succeeded.length }}；跳过 {{ executionResult.skipped.length }}；失败 {{ executionResult.failures.length }}{{ executionResult.canceled ? '；已取消后续操作' : '' }}。</div>
            <details v-if="executionResult.failures.length || executionResult.residualRisks.length" open class="gya-failures">
              <summary>失败与风险详情</summary>
              <ul><li v-for="(failure, index) in executionResult.failures" :key="`${failure.item.fileId}-${index}`"><b>{{ failurePhaseText(failure.phase) }}</b>：{{ failure.fromName }} → {{ failure.toName }}：{{ failure.error }}</li></ul>
              <ul v-if="executionResult.residualRisks.length"><li v-for="risk in executionResult.residualRisks" :key="risk" class="warn">{{ risk }}</li></ul>
            </details>
          </template>

          <footer>
            <button v-if="busy" class="gya-secondary" @click="cancel">取消后续操作</button>
            <button v-if="!completed" class="gya-primary" :disabled="busy || !plan.ready.length" @click="execute">开始重命名（{{ plan.ready.length }}）</button>
            <button v-else class="gya-primary" :disabled="busy" @click="emit('close')">完成</button>
          </footer>
        </template>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.gya-mask{position:fixed;inset:0;z-index:2147483645;background:rgba(15,23,42,.42);display:flex;justify-content:flex-end;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2937}.gya-panel{width:min(1080px,96vw);height:100vh;overflow:auto;background:#fff;padding:20px 24px;box-sizing:border-box;box-shadow:-8px 0 30px rgba(0,0,0,.16)}header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #e5e7eb;margin-bottom:12px}h2{margin:0;font-size:22px}header p{margin:4px 0 12px;color:#64748b}.gya-close{border:0;background:none;font-size:30px;cursor:pointer}.gya-rules{display:grid;grid-template-columns:1fr 1fr;gap:10px}.gya-rules fieldset{border:1px solid #cbd5e1;border-radius:8px;padding:10px 12px;min-width:0}.gya-rules legend{font-weight:700;padding:0 5px}.gya-sequence-field{grid-column:1/-1}.gya-grid{display:grid;gap:8px;align-items:end}.gya-replace-grid{grid-template-columns:1fr 1fr auto auto}.gya-affix-grid{grid-template-columns:1fr 1fr auto}.gya-sequence-grid{grid-template-columns:repeat(5,minmax(0,1fr))}.gya-grid label:not(.gya-check){display:flex;flex-direction:column;min-width:0;color:#475569;font-size:12px}.gya-grid input,.gya-grid select{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;padding:7px;min-width:0;background:#fff}.gya-check{display:flex;align-items:center;gap:5px;white-space:nowrap}.gya-policy{display:flex;gap:7px;padding:6px;cursor:pointer}.gya-policy span{display:flex;flex-direction:column}.gya-policy small{color:#64748b}.gya-progress{margin:12px 0}.gya-progress-head{display:flex;justify-content:space-between;gap:12px;color:#475569;font-size:13px}.gya-progress-track{height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;margin-top:5px}.gya-progress-track span{display:block;height:100%;background:linear-gradient(90deg,#2563eb,#60a5fa);transition:width .2s ease}.gya-error{color:#b91c1c;background:#fef2f2;padding:8px 10px;border-radius:6px}.gya-summary{display:flex;justify-content:space-between;align-items:center;margin:12px 0}.gya-summary button,.gya-link{border:0;background:none;color:#2563eb;cursor:pointer}.gya-table-wrap{overflow:auto;max-height:42vh;border:1px solid #e5e7eb;border-radius:8px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #f1f5f9;vertical-align:middle}th{position:sticky;top:0;background:#f8fafc;z-index:1}td:nth-child(2){max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gya-name-editor{display:flex;align-items:center;min-width:300px}.gya-name-editor input{flex:1;min-width:100px;border:1px solid #cbd5e1;border-radius:6px 0 0 6px;padding:7px}.gya-extension{padding:7px 8px;background:#f1f5f9;border:1px solid #cbd5e1;border-left:0;border-radius:0 6px 6px 0;color:#475569}.gya-name-editor input:only-child{border-radius:6px}.gya-table-wrap small{color:#64748b}.gya-status{font-size:12px}.status-invalid .gya-status,.status-conflict .gya-status{color:#b91c1c}.status-unchanged .gya-status{color:#64748b}.status-ready .gya-status{color:#166534}.gya-result{margin-top:12px;padding:10px;background:#f0fdf4;color:#166534;border-radius:8px}.gya-failures{margin-top:10px;border:1px solid #fecaca;border-radius:8px;padding:8px 12px}.gya-failures li{margin:5px 0;word-break:break-all}.warn{color:#b45309}footer{display:flex;justify-content:flex-end;gap:10px;margin-top:14px}.gya-primary,.gya-secondary{border:0;border-radius:7px;padding:8px 14px;cursor:pointer}.gya-primary{background:#2563eb;color:#fff}.gya-secondary{background:#e2e8f0;color:#1e293b}button:disabled,input:disabled,select:disabled{opacity:.55;cursor:not-allowed}@media(max-width:800px){.gya-panel{padding:14px}.gya-rules{grid-template-columns:1fr}.gya-replace-grid,.gya-affix-grid,.gya-sequence-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.gya-name-editor{min-width:220px}}@media(max-width:480px){.gya-replace-grid,.gya-affix-grid,.gya-sequence-grid{grid-template-columns:1fr}}
</style>
