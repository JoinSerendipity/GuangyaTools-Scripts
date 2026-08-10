import type {
  CleanupMatch,
  CleanupRule,
  GuangyaItem,
  MutationSummary,
  ProgressInfo,
} from '../types';
import type { GuangyaApiLike } from './guangyaApi';
import type { RequestContext } from './requestContext';
import { runMutationBatches } from '../utils/batch';

function itemExtension(item: GuangyaItem): string {
  if (item.ext) return item.ext.replace(/^\./, '');
  const index = item.fileName.lastIndexOf('.');
  return index > 0 ? item.fileName.slice(index + 1) : '';
}

interface CompiledCleanupRule {
  rule: CleanupRule;
  order: number;
  matchesText?: (value: string) => boolean;
}

interface CompiledCleanupPlan {
  suffixSensitive: Map<string, CompiledCleanupRule[]>;
  suffixInsensitive: Map<string, CompiledCleanupRule[]>;
  fileTypes: Map<number, CompiledCleanupRule[]>;
  fileNames: CompiledCleanupRule[];
  directoryNames: CompiledCleanupRule[];
}

function compileTextMatcher(rule: CleanupRule): (value: string) => boolean {
  if (rule.matchMode === 'regex') {
    const regex = new RegExp(rule.pattern, rule.caseSensitive ? '' : 'i');
    return (value) => regex.test(value);
  }
  const pattern = rule.caseSensitive ? rule.pattern : rule.pattern.toLocaleLowerCase();
  return (value) => {
    const source = rule.caseSensitive ? value : value.toLocaleLowerCase();
    return rule.matchMode === 'equals' ? source === pattern : source.includes(pattern);
  };
}

function pushIndexed<K>(map: Map<K, CompiledCleanupRule[]>, key: K, value: CompiledCleanupRule): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

export function compileCleanupRules(rules: readonly CleanupRule[]): CompiledCleanupPlan {
  const plan: CompiledCleanupPlan = {
    suffixSensitive: new Map(),
    suffixInsensitive: new Map(),
    fileTypes: new Map(),
    fileNames: [],
    directoryNames: [],
  };
  rules.forEach((rule, order) => {
    if (!rule.enabled || validateCleanupRule(rule)) return;
    const compiled: CompiledCleanupRule = { rule, order };
    if (rule.kind === 'suffix') {
      pushIndexed(rule.caseSensitive ? plan.suffixSensitive : plan.suffixInsensitive, rule.caseSensitive ? rule.pattern : rule.pattern.toLocaleLowerCase(), compiled);
    } else if (rule.kind === 'fileType') {
      pushIndexed(plan.fileTypes, Number(rule.fileType), compiled);
    } else {
      compiled.matchesText = compileTextMatcher(rule);
      (rule.kind === 'fileName' ? plan.fileNames : plan.directoryNames).push(compiled);
    }
  });
  return plan;
}

function matchesSize(item: GuangyaItem, compiled: CompiledCleanupRule): boolean {
  return item.resType !== 1 || compiled.rule.maxSizeMb == null || item.fileSize <= compiled.rule.maxSizeMb * 1024 * 1024;
}

function compiledMatchesForItem(item: GuangyaItem, plan: CompiledCleanupPlan): CompiledCleanupRule[] {
  const candidates: CompiledCleanupRule[] = [];
  if (item.resType === 1) {
    const extension = itemExtension(item);
    candidates.push(...(plan.suffixSensitive.get(extension) || []));
    candidates.push(...(plan.suffixInsensitive.get(extension.toLocaleLowerCase()) || []));
    candidates.push(...(plan.fileTypes.get(item.fileType) || []));
    for (const compiled of plan.fileNames) if (compiled.matchesText?.(item.fileName)) candidates.push(compiled);
  } else {
    for (const compiled of plan.directoryNames) if (compiled.matchesText?.(item.fileName)) candidates.push(compiled);
  }
  return candidates.filter((compiled) => matchesSize(item, compiled)).sort((left, right) => left.order - right.order);
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
  return compiledMatchesForItem(item, compileCleanupRules([rule])).length > 0;
}

export function filterCleanupMatches(items: readonly GuangyaItem[], rules: readonly CleanupRule[]): CleanupMatch[] {
  const plan = compileCleanupRules(rules);
  const matches: CleanupMatch[] = [];
  for (const item of items) {
    const ruleIds = compiledMatchesForItem(item, plan).map((compiled) => compiled.rule.id);
    if (ruleIds.length) matches.push({ item, ruleIds });
  }
  return matches;
}

export async function scanCleanup(
  api: GuangyaApiLike,
  parentId: string,
  rules: readonly CleanupRule[],
  options: {
    recursive?: boolean;
    signal?: AbortSignal;
    onProgress?: (progress: ProgressInfo) => void;
    context?: RequestContext;
  } = {},
): Promise<CleanupMatch[]> {
  const errors = rules
    .filter((rule) => rule.enabled)
    .map((rule) => validateCleanupRule(rule))
    .filter((error): error is string => Boolean(error));
  if (errors.length) throw new Error(errors.join('；'));
  if (!rules.some((rule) => rule.enabled)) throw new Error('请至少启用一条清理规则');

  options.onProgress?.({ phase: 'scan', message: '正在读取目录内容', current: 0, total: 1 });
  const walk = options.recursive
    ? await api.walkDescendants(parentId, options)
    : null;
  if (walk?.complete === false) throw new Error(walk.incompleteReason || '递归扫描不完整，已停止清理');
  const items = walk?.items
    ?? await api.listAllChildren(parentId, { signal: options.signal, context: options.context, onProgress: options.onProgress });
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
    context?: RequestContext;
  } = {},
): Promise<MutationSummary<GuangyaItem>> {
  const unique = [...new Map(items.map((item) => [item.fileId, item])).values()];
  return runMutationBatches(unique, {
    batchSize: options.batchSize || 50,
    delayMs: 0,
    signal: options.signal,
    phase: 'trash',
    mutate: (batch) => api.trashItems(batch.map((item) => item.fileId), { signal: options.signal, context: options.context }),
    waitTask: (taskId) => api.waitTask(taskId, { context: options.context }),
    onProgress: options.onProgress,
  });
}
