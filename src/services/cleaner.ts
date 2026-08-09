import type {
  CleanupMatch,
  CleanupRule,
  GuangyaItem,
  MutationSummary,
  ProgressInfo,
} from '../types';
import type { GuangyaApiLike } from './guangyaApi';
import { runMutationBatches } from '../utils/batch';

function itemExtension(item: GuangyaItem): string {
  if (item.ext) return item.ext.replace(/^\./, '');
  const index = item.fileName.lastIndexOf('.');
  return index > 0 ? item.fileName.slice(index + 1) : '';
}

function compareText(value: string, rule: CleanupRule): boolean {
  const flags = rule.caseSensitive ? '' : 'i';
  if (rule.matchMode === 'regex') return new RegExp(rule.pattern, flags).test(value);
  const source = rule.caseSensitive ? value : value.toLocaleLowerCase();
  const pattern = rule.caseSensitive ? rule.pattern : rule.pattern.toLocaleLowerCase();
  return rule.matchMode === 'equals' ? source === pattern : source.includes(pattern);
}

export function validateCleanupRule(rule: CleanupRule): string | null {
  if (!rule.enabled) return null;
  if (rule.maxSizeMb != null && (!Number.isFinite(rule.maxSizeMb) || rule.maxSizeMb < 0)) {
    return '最大大小必须是非负数';
  }
  if (rule.kind === 'fileType') {
    return Number.isInteger(rule.fileType) ? null : '请选择文件类型';
  }
  if (!rule.pattern.trim()) return '匹配内容不能为空';
  if ((rule.kind === 'fileName' || rule.kind === 'dirName') && rule.matchMode === 'regex') {
    try {
      new RegExp(rule.pattern, rule.caseSensitive ? '' : 'i');
    } catch (error) {
      return `正则表达式无效：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return null;
}

export function matchesCleanupRule(item: GuangyaItem, rule: CleanupRule): boolean {
  if (!rule.enabled || validateCleanupRule(rule)) return false;
  const isFile = item.resType === 1;
  if (rule.maxSizeMb != null && isFile && item.fileSize > rule.maxSizeMb * 1024 * 1024) return false;

  switch (rule.kind) {
    case 'suffix':
      return isFile && compareText(itemExtension(item), { ...rule, matchMode: 'equals' });
    case 'fileType':
      return isFile && item.fileType === rule.fileType;
    case 'fileName':
      return isFile && compareText(item.fileName, rule);
    case 'dirName':
      return !isFile && compareText(item.fileName, rule);
  }
}

export function filterCleanupMatches(items: readonly GuangyaItem[], rules: readonly CleanupRule[]): CleanupMatch[] {
  const enabledRules = rules.filter((rule) => rule.enabled);
  const matchMap = new Map<string, CleanupMatch>();
  for (const item of items) {
    for (const rule of enabledRules) {
      if (!matchesCleanupRule(item, rule)) continue;
      const existing = matchMap.get(item.fileId);
      if (existing) existing.ruleIds.push(rule.id);
      else matchMap.set(item.fileId, { item, ruleIds: [rule.id] });
    }
  }
  return [...matchMap.values()];
}

export async function scanCleanup(
  api: GuangyaApiLike,
  parentId: string,
  rules: readonly CleanupRule[],
  options: {
    recursive?: boolean;
    signal?: AbortSignal;
    onProgress?: (progress: ProgressInfo) => void;
  } = {},
): Promise<CleanupMatch[]> {
  const errors = rules
    .filter((rule) => rule.enabled)
    .map((rule) => validateCleanupRule(rule))
    .filter((error): error is string => Boolean(error));
  if (errors.length) throw new Error(errors.join('；'));
  if (!rules.some((rule) => rule.enabled)) throw new Error('请至少启用一条清理规则');

  options.onProgress?.({ phase: 'scan', message: '正在读取目录内容', current: 0, total: 1 });
  const items = options.recursive
    ? (await api.walkDescendants(parentId, options)).items
    : await api.listAllChildren(parentId, { signal: options.signal, onProgress: options.onProgress });
  options.signal?.throwIfAborted();
  const matches = filterCleanupMatches(items, rules);
  options.onProgress?.({
    phase: 'scan',
    message: `扫描完成，命中 ${matches.length} 项`,
    current: items.length,
    total: items.length,
  });
  return matches;
}

export async function trashCleanupItems(
  api: GuangyaApiLike,
  items: readonly GuangyaItem[],
  options: {
    signal?: AbortSignal;
    batchSize?: number;
    onProgress?: (progress: ProgressInfo) => void;
  } = {},
): Promise<MutationSummary<GuangyaItem>> {
  const unique = [...new Map(items.map((item) => [item.fileId, item])).values()];
  return runMutationBatches(unique, {
    batchSize: options.batchSize || 50,
    delayMs: 500,
    signal: options.signal,
    phase: 'trash',
    mutate: (batch) => api.trashItems(batch.map((item) => item.fileId), { signal: options.signal }),
    waitTask: (taskId) => api.waitTask(taskId),
    onProgress: options.onProgress,
  });
}
