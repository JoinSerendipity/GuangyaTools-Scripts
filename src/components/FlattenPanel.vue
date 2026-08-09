<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { FlattenDirectoryResult, GuangyaItem, ProgressInfo } from '../types';
import type { GuangyaApiLike } from '../services/guangyaApi';
import { createFlattenPlan, flattenDirectories, type FlattenConflictMode } from '../services/flattenSubfolders';
import { getCurrentDirectory } from '../services/pageAdapter';

const props = defineProps<{ api: GuangyaApiLike; directories: GuangyaItem[]; originDirectoryId: string }>();
const emit = defineEmits<{ close: []; completed: [] }>();

interface PreviewRow {
  directory: GuangyaItem;
  scannedFiles: number;
  movableFiles: number;
  conflicts: number;
  topDirectories: number;
}

const previews = ref<PreviewRow[]>([]);
const results = ref<FlattenDirectoryResult[]>([]);
const conflictMode = ref<FlattenConflictMode>('skip');
const busy = ref(false);
const progress = ref<ProgressInfo | null>(null);
const progressPercent = computed(() => {
  if (!progress.value || progress.value.total <= 0) return 0;
  return Math.round(Math.min(100, Math.max(0, (progress.value.current / progress.value.total) * 100)));
});
const errorMessage = ref('');
let controller: AbortController | null = null;

const totals = computed(() => results.value.reduce((sum, result) => ({
  moved: sum.moved + result.movedFiles.length,
  conflicts: sum.conflicts + result.conflicts.length,
  trashedConflictFiles: sum.trashedConflictFiles + result.trashedConflictFiles.length,
  trashedConflictDirectories: sum.trashedConflictDirectories + result.trashedConflictDirectories.length,
  trashed: sum.trashed + result.trashedTopDirectories.length,
  retained: sum.retained + result.retainedTopDirectories.length,
  failures: sum.failures + result.failures.length,
}), { moved: 0, conflicts: 0, trashedConflictFiles: 0, trashedConflictDirectories: 0, trashed: 0, retained: 0, failures: 0 }));
const retryDirectories = computed(() => results.value.filter((result) => result.failures.length > 0).map((result) => result.directory));
const resultDetailsText = computed(() => results.value.map(formatResultDetail).join('\n\n'));
const usesGuangyaDefault = computed(() => conflictMode.value === 'guangya-default');
const trashesConflicts = computed(() => conflictMode.value === 'trash-conflicts');
const movableColumnLabel = computed(() => usesGuangyaDefault.value ? '提交移动' : '可移动');
const conflictColumnLabel = computed(() => {
  if (usesGuangyaDefault.value) return '交给光鸭处理';
  if (trashesConflicts.value) return '重名待回收';
  return '同名跳过';
});
const safetyConflictText = computed(() => {
  if (usesGuangyaDefault.value) return '重名文件交给光鸭默认处理；';
  if (trashesConflicts.value) return '仅回收候选重名文件，并复扫清理其空直接父目录；';
  return '重名文件保留不处理；';
});

watch(conflictMode, () => {
  if (!previews.value.length && !results.value.length) return;
  previews.value = [];
  results.value = [];
  progress.value = null;
  errorMessage.value = '重名处理策略已变化，请重新预检查。';
});

function updateProgress(value: ProgressInfo): void { progress.value = value; }
function conflictReason(reason: string): string {
  if (reason === 'target-name-exists') return '目标目录已有同名文件/目录';
  if (reason === 'duplicate-candidate-name') return '候选文件之间重名';
  return reason;
}
function formatResultDetail(result: FlattenDirectoryResult): string {
  const lines = [
    `目录：${result.directory.fileName}`,
    `移动文件：${result.movedFiles.length}`,
    `回收候选重名文件：${result.trashedConflictFiles.length}`,
    `回收重名文件空父目录：${result.trashedConflictDirectories.length}`,
    `回收顶层子目录：${result.trashedTopDirectories.length}`,
    `保留顶层子目录：${result.retainedTopDirectories.length}`,
    `冲突文件：${result.conflicts.length}`,
    `失败批次：${result.failures.length}`,
  ];
  if (result.conflicts.length) {
    lines.push(trashesConflicts.value ? '检测到的候选重名文件：' : '冲突明细：');
    result.conflicts.slice(0, 50).forEach(({ item, reason }) => lines.push(`  - ${item.fileName}：${conflictReason(reason)}`));
    if (result.conflicts.length > 50) lines.push(`  ... 还有 ${result.conflicts.length - 50} 项冲突`);
  }
  if (result.trashedConflictFiles.length) {
    lines.push('已回收候选重名文件：');
    result.trashedConflictFiles.slice(0, 50).forEach((item) => lines.push(`  - ${item.fileName}`));
  }
  if (result.trashedConflictDirectories.length) {
    lines.push('已回收空直接父目录：');
    result.trashedConflictDirectories.slice(0, 50).forEach((item) => lines.push(`  - ${item.fileName}`));
  }
  if (result.retainedTopDirectories.length) {
    lines.push('保留目录：');
    result.retainedTopDirectories.slice(0, 50).forEach((item) => lines.push(`  - ${item.fileName}：复扫后仍有文件/冲突残留，或删除失败，为避免误删已保留`));
    if (result.retainedTopDirectories.length > 50) lines.push(`  ... 还有 ${result.retainedTopDirectories.length - 50} 个保留目录`);
  }
  if (result.failures.length) {
    lines.push('失败批次：');
    result.failures.forEach((failure, index) => {
      lines.push(`  - 批次 ${index + 1}：${failure.error}`);
      const names = failure.items.map((item) => item.fileName).slice(0, 20).join('、');
      lines.push(`    项目：${names}${failure.items.length > 20 ? ` ... 还有 ${failure.items.length - 20} 项` : ''}`);
    });
  }
  return lines.join('\n');
}
async function copyResultDetails(): Promise<void> {
  const text = resultDetailsText.value || '暂无解散子目录结果';
  try {
    await navigator.clipboard.writeText(text);
    errorMessage.value = '已复制失败/保留详情，可直接粘贴给开发者排查。';
  } catch {
    window.prompt('复制下面的失败/保留详情', text);
  }
}
function ensureOrigin(): boolean {
  if (getCurrentDirectory()?.id === props.originDirectoryId) return true;
  errorMessage.value = '当前目录已经变化，解散操作已取消，请重新选择目录';
  return false;
}

async function preview(): Promise<void> {
  if (!ensureOrigin()) return;
  busy.value = true;
  errorMessage.value = '';
  previews.value = [];
  controller = new AbortController();
  try {
    for (let index = 0; index < props.directories.length; index += 1) {
      const directory = props.directories[index];
      updateProgress({ phase: 'preview', message: `[${index + 1}/${props.directories.length}] 预扫描「${directory.fileName}」`, current: index, total: props.directories.length });
      const walk = await props.api.walkDescendants(directory.fileId, {
        signal: controller.signal,
        onProgress: (scanProgress) => {
          const total = scanProgress.total > 0 ? scanProgress.total : 1;
          const ratio = Math.min(1, Math.max(0, scanProgress.current / total));
          updateProgress({
            phase: 'preview',
            message: `[${index + 1}/${props.directories.length}] 预扫描「${directory.fileName}」：${scanProgress.message}`,
            current: index + ratio,
            total: props.directories.length,
          });
        },
      });
      const safePlan = createFlattenPlan(directory, walk, { conflictMode: 'skip' });
      const plan = conflictMode.value === 'skip'
        ? safePlan
        : createFlattenPlan(directory, walk, { conflictMode: conflictMode.value });
      previews.value.push({ directory, scannedFiles: walk.files.length, movableFiles: plan.movableFiles.length, conflicts: safePlan.conflicts.length, topDirectories: plan.topDirectories.length });
      updateProgress({ phase: 'preview', message: `[${index + 1}/${props.directories.length}] 已完成「${directory.fileName}」预扫描`, current: index + 1, total: props.directories.length });
    }
  } catch (error) {
    if (!controller.signal.aborted) errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
    controller = null;
  }
}

async function execute(targets = props.directories): Promise<void> {
  if (!targets.length || !ensureOrigin()) return;
  const previewMap = new Map(previews.value.map((row) => [row.directory.fileId, row]));
  const moving = targets.reduce((sum, item) => sum + (previewMap.get(item.fileId)?.movableFiles || 0), 0);
  const conflicts = targets.reduce((sum, item) => sum + (previewMap.get(item.fileId)?.conflicts || 0), 0);
  const conflictMessage = usesGuangyaDefault.value
    ? `检测到 ${conflicts} 个重名项，将交给光鸭默认处理（通常在文件名后追加 (1)、(2) 等，最终以服务端行为为准）`
    : trashesConflicts.value
      ? `${conflicts} 个候选重名文件将移入回收站；其直接父目录仅在复扫确认没有其他文件时才会回收`
      : `${conflicts} 个同名冲突文件会保留不处理`;
  if (!window.confirm(`将处理 ${targets.length} 个目录，提交移动约 ${moving} 个文件；${conflictMessage}。仅在确认子目录树无文件后才移入回收站。是否继续？`)) return;

  busy.value = true;
  errorMessage.value = '';
  controller = new AbortController();
  try {
    const next = await flattenDirectories(props.api, targets, { signal: controller.signal, onProgress: updateProgress, conflictMode: conflictMode.value });
    const retriedIds = new Set(targets.map((item) => item.fileId));
    results.value = [...results.value.filter((result) => !retriedIds.has(result.directory.fileId)), ...next];
    if (next.some((result) => result.movedFiles.length || result.trashedConflictFiles.length || result.trashedConflictDirectories.length || result.trashedTopDirectories.length)) emit('completed');
    if (next.some((result) => result.failures.length)) errorMessage.value = '部分目录处理失败，可查看结果并重试失败目录。';
  } catch (error) {
    if (!controller.signal.aborted) errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
    controller = null;
  }
}

function cancel(): void { controller?.abort(new DOMException('用户取消操作', 'AbortError')); }
onBeforeUnmount(cancel);
</script>

<template>
  <Teleport to="body">
    <div class="gya-mask" @click.self="!busy && emit('close')">
      <section class="gya-panel" aria-label="光鸭解散子目录工具">
        <header><div><h2>解散子目录</h2><p>把所有后代文件移动到选中目录，并清理确认无文件的子目录树。</p></div><button :disabled="busy" @click="emit('close')">×</button></header>
        <div class="gya-warning"><b>安全策略</b><span>{{ safetyConflictText }}有残留或移动失败的目录不会删除；文件和目录删除都只进入回收站。</span></div>
        <fieldset class="gya-conflict-mode" :disabled="busy">
          <legend>重名处理策略</legend>
          <label><input v-model="conflictMode" type="radio" value="skip"> <span><b>保留不处理（安全，默认）</b><small>提前跳过重名文件，相关子目录会保留。</small></span></label>
          <label><input v-model="conflictMode" type="radio" value="guangya-default"> <span><b>按光鸭网盘默认操作</b><small>仍提交移动；光鸭通常会在文件名后追加 (1)、(2) 等，最终以服务端行为为准。</small></span></label>
          <label><input v-model="conflictMode" type="radio" value="trash-conflicts"> <span><b>回收候选重名文件</b><small>只回收子目录中的重名候选；其直接父目录确认没有其他文件后也回收。</small></span></label>
        </fieldset>
        <ul class="gya-selected"><li v-for="directory in directories" :key="directory.fileId">{{ directory.fileName }}</li></ul>
        <div class="gya-actions"><button class="gya-primary" :disabled="busy" @click="preview">预检查</button><button v-if="busy" class="gya-secondary" @click="cancel">取消后续操作</button></div>
        <div v-if="progress" class="gya-progress" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100">
          <div class="gya-progress-head"><span>{{ progress.message }}</span><b>{{ progressPercent }}%</b></div>
          <div class="gya-progress-track"><span :style="{ width: `${progressPercent}%` }"></span></div>
        </div>
        <p v-if="errorMessage" class="gya-error">{{ errorMessage }}</p>

        <table v-if="previews.length"><thead><tr><th>目录</th><th>后代文件</th><th>{{ movableColumnLabel }}</th><th>{{ conflictColumnLabel }}</th><th>顶层子目录</th></tr></thead><tbody>
          <tr v-for="row in previews" :key="row.directory.fileId"><td>{{ row.directory.fileName }}</td><td>{{ row.scannedFiles }}</td><td>{{ row.movableFiles }}</td><td :class="{ warn: row.conflicts }">{{ row.conflicts }}</td><td>{{ row.topDirectories }}</td></tr>
        </tbody></table>
        <div v-if="previews.length && !results.length" class="gya-run"><button class="gya-danger" :disabled="busy" @click="execute()">开始解散</button></div>

        <template v-if="results.length">
          <div class="gya-summary">移动 {{ totals.moved }} 个文件；{{ trashesConflicts ? `回收 ${totals.trashedConflictFiles} 个重名文件、${totals.trashedConflictDirectories} 个空直接父目录` : `跳过 ${totals.conflicts} 个冲突` }}；回收 {{ totals.trashed }} 个顶层子目录；保留 {{ totals.retained }} 个；失败批次 {{ totals.failures }} 个。</div>
          <table><thead><tr><th>目录</th><th>移动</th><th>重名</th><th>回收重名</th><th>空父目录</th><th>回收顶层</th><th>保留</th><th>失败</th></tr></thead><tbody>
            <tr v-for="result in results" :key="result.directory.fileId"><td>{{ result.directory.fileName }}</td><td>{{ result.movedFiles.length }}</td><td>{{ result.conflicts.length }}</td><td>{{ result.trashedConflictFiles.length }}</td><td>{{ result.trashedConflictDirectories.length }}</td><td>{{ result.trashedTopDirectories.length }}</td><td>{{ result.retainedTopDirectories.length }}</td><td>{{ result.failures.length }}</td></tr>
          </tbody></table>
          <div class="gya-details">
            <details v-for="result in results" :key="`${result.directory.fileId}-detail`" :open="result.failures.length > 0 || result.retainedTopDirectories.length > 0 || result.conflicts.length > 0">
              <summary>{{ result.directory.fileName }} 的处理详情</summary>
              <div v-if="result.conflicts.length" class="gya-detail-block"><b>{{ trashesConflicts ? '检测到的候选重名文件' : '冲突文件（跳过，不移动）' }}</b><ul><li v-for="conflict in result.conflicts.slice(0, 30)" :key="conflict.item.fileId">{{ conflict.item.fileName }}：{{ conflictReason(conflict.reason) }}</li></ul><p v-if="result.conflicts.length > 30">还有 {{ result.conflicts.length - 30 }} 项冲突，点击“复制详情”查看完整文本。</p></div>
              <div v-if="result.trashedConflictFiles.length" class="gya-detail-block"><b>已回收候选重名文件</b><ul><li v-for="item in result.trashedConflictFiles.slice(0, 30)" :key="item.fileId">{{ item.fileName }}</li></ul></div>
              <div v-if="result.trashedConflictDirectories.length" class="gya-detail-block"><b>已回收的空直接父目录</b><ul><li v-for="item in result.trashedConflictDirectories.slice(0, 30)" :key="item.fileId">{{ item.fileName }}</li></ul></div>
              <div v-if="result.retainedTopDirectories.length" class="gya-detail-block"><b>保留目录（没有删除）</b><ul><li v-for="directory in result.retainedTopDirectories.slice(0, 30)" :key="directory.fileId">{{ directory.fileName }}：复扫后仍有文件/冲突残留，或删除失败，为避免误删已保留。</li></ul><p v-if="result.retainedTopDirectories.length > 30">还有 {{ result.retainedTopDirectories.length - 30 }} 个保留目录。</p></div>
              <div v-if="result.failures.length" class="gya-detail-block"><b>失败批次</b><ul><li v-for="(failure, index) in result.failures" :key="index">批次 {{ index + 1 }}：{{ failure.error }}<br><small>项目：{{ failure.items.map((item) => item.fileName).slice(0, 12).join('、') }}{{ failure.items.length > 12 ? ` ... 还有 ${failure.items.length - 12} 项` : '' }}</small></li></ul></div>
              <p v-if="!result.conflicts.length && !result.trashedConflictFiles.length && !result.trashedConflictDirectories.length && !result.retainedTopDirectories.length && !result.failures.length">该目录没有额外处理详情。</p>
            </details>
          </div>
          <div class="gya-run"><button class="gya-secondary" :disabled="busy" @click="copyResultDetails">复制失败/保留详情</button><button v-if="retryDirectories.length" class="gya-secondary" :disabled="busy" @click="execute(retryDirectories)">重试失败目录（{{ retryDirectories.length }}）</button><button class="gya-primary" :disabled="busy" @click="emit('close')">完成</button></div>
        </template>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.gya-mask{position:fixed;inset:0;z-index:2147483645;background:rgba(15,23,42,.42);display:grid;place-items:center;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2937}.gya-panel{width:min(860px,94vw);max-height:90vh;overflow:auto;background:#fff;border-radius:12px;padding:22px;box-shadow:0 18px 60px rgba(0,0,0,.24)}header{display:flex;justify-content:space-between;border-bottom:1px solid #e5e7eb}h2{margin:0;font-size:22px}header p{color:#64748b;margin:4px 0 14px}header button{border:0;background:none;font-size:30px;cursor:pointer}.gya-warning{display:flex;flex-direction:column;background:#fff7ed;color:#9a3412;border-radius:8px;padding:10px 12px;margin:14px 0}.gya-conflict-mode{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;border:1px solid #cbd5e1;border-radius:8px;padding:10px 12px}.gya-conflict-mode legend{font-weight:700;padding:0 5px}.gya-conflict-mode label{display:flex;align-items:flex-start;gap:7px;padding:8px;border-radius:7px;background:#f8fafc;cursor:pointer}.gya-conflict-mode input{margin-top:3px}.gya-conflict-mode span{display:flex;flex-direction:column}.gya-conflict-mode small{color:#64748b;margin-top:2px}.gya-selected{display:flex;flex-wrap:wrap;gap:8px;padding:0;list-style:none}.gya-selected li{background:#eff6ff;color:#1d4ed8;border-radius:99px;padding:4px 10px}.gya-actions,.gya-run{display:flex;align-items:center;gap:10px;margin:14px 0}.gya-run{justify-content:flex-end}.gya-progress{margin:10px 0 12px}.gya-progress-head{display:flex;justify-content:space-between;gap:12px;color:#475569;font-size:13px}.gya-progress-track{height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;margin-top:5px}.gya-progress-track span{display:block;height:100%;background:linear-gradient(90deg,#2563eb,#60a5fa);transition:width .2s ease}.gya-primary,.gya-secondary,.gya-danger{border:0;border-radius:7px;padding:8px 14px;cursor:pointer}.gya-primary{background:#2563eb;color:#fff}.gya-secondary{background:#e2e8f0}.gya-danger{background:#dc2626;color:#fff}.gya-error{color:#b91c1c;background:#fef2f2;padding:8px}.gya-summary{background:#f0fdf4;color:#166534;padding:10px;border-radius:8px;margin:12px 0}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{text-align:left;padding:9px;border-bottom:1px solid #e5e7eb}.gya-details{margin-top:12px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}.gya-details details+details{border-top:1px solid #e5e7eb}.gya-details summary{cursor:pointer;background:#f8fafc;padding:10px 12px;font-weight:700}.gya-detail-block{padding:10px 12px}.gya-detail-block ul{margin:6px 0 0 20px;padding:0}.gya-detail-block li{margin:4px 0;word-break:break-all}.gya-detail-block small{color:#64748b}.warn{color:#b45309;font-weight:700}button:disabled{opacity:.5;cursor:not-allowed}@media(max-width:760px){.gya-conflict-mode{grid-template-columns:1fr}.gya-panel{padding:14px}}
</style>
