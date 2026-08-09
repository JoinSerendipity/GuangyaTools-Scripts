import type {
  BatchRenamePlan,
  BatchRenameRules,
  GuangyaItem,
  ProgressInfo,
  RenameConflictPolicy,
  RenameExecutionFailure,
  RenameExecutionResult,
  RenamePlanEntry,
  RenameFailurePhase,
} from '../types';

export interface RenameApiLike {
  renameItem(fileId: string, newName: string): Promise<void>;
}

export interface NameParts {
  stem: string;
  extension: string;
}

export const DEFAULT_BATCH_RENAME_RULES: BatchRenameRules = {
  preserveExtension: true,
  search: '',
  replacement: '',
  useRegex: false,
  caseSensitive: false,
  prefix: '',
  suffix: '',
  sequenceEnabled: false,
  sequenceStart: 1,
  sequenceStep: 1,
  sequencePadding: 1,
  sequencePosition: 'suffix',
  sequenceSeparator: '_',
};

const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export function renameNameKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase();
}

export function splitFileName(name: string): NameParts {
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) return { stem: name, extension: '' };
  return { stem: name.slice(0, lastDot), extension: name.slice(lastDot) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceText(value: string, rules: BatchRenameRules): string {
  if (!rules.search) return value;
  if (rules.useRegex) {
    const expression = new RegExp(rules.search, rules.caseSensitive ? 'g' : 'gi');
    return value.replace(expression, rules.replacement);
  }
  if (rules.caseSensitive) return value.split(rules.search).join(rules.replacement);
  return value.replace(new RegExp(escapeRegExp(rules.search), 'gi'), () => rules.replacement);
}

function formatSequence(value: number, padding: number): string {
  const integer = Math.trunc(value);
  const sign = integer < 0 ? '-' : '';
  return `${sign}${String(Math.abs(integer)).padStart(Math.max(1, Math.trunc(padding) || 1), '0')}`;
}

export function applyRenameRules(item: GuangyaItem, rules: BatchRenameRules, index: number): string {
  const preserveExtension = item.resType === 1 && rules.preserveExtension;
  const parts = preserveExtension ? splitFileName(item.fileName) : { stem: item.fileName, extension: '' };
  let stem = replaceText(parts.stem, rules);
  stem = `${rules.prefix}${stem}${rules.suffix}`;
  if (rules.sequenceEnabled) {
    const sequence = formatSequence(rules.sequenceStart + index * rules.sequenceStep, rules.sequencePadding);
    stem = rules.sequencePosition === 'prefix'
      ? `${sequence}${rules.sequenceSeparator}${stem}`
      : `${stem}${rules.sequenceSeparator}${sequence}`;
  }
  return `${stem}${parts.extension}`;
}

export function validateGuangyaName(value: string): string | null {
  if (!value || value.length === 0) return '文件名不能为空';
  if (value.length > 255) return '文件名不能超过 255 个字符';
  const name = value.trim();
  if (!name) return '文件名不能为空';
  if (name.startsWith('.') || name.endsWith('.')) return '文件名不能以 . 开头或结尾';
  if (/[<>:"/\\|?*]/.test(name)) return '文件名不合法：不能包含 < > : " / \\ | ? * 等特殊字符';
  for (let index = 0; index < name.length; index += 1) {
    if (name.charCodeAt(index) < 32) return '文件名不能包含控制字符';
  }
  if (WINDOWS_RESERVED_NAMES.has(name.split('.')[0].toUpperCase())) return '文件名不能使用 Windows 保留名称';
  if (name.replace(/[\s.]/g, '').length === 0) return '文件名不能为空';
  if (name.includes('..')) return '文件名不能包含连续的点';
  if (value.endsWith(' ')) return '文件名不能以空格结尾';
  return null;
}

function manualValue(overrides: ReadonlyMap<string, string> | Record<string, string> | undefined, fileId: string): string | undefined {
  if (!overrides) return undefined;
  const map = overrides as ReadonlyMap<string, string>;
  return typeof map.get === 'function' ? map.get(fileId) : (overrides as Record<string, string>)[fileId];
}

function suffixName(name: string, item: GuangyaItem, suffixIndex: number): string {
  const parts = item.resType === 1 ? splitFileName(name) : { stem: name, extension: '' };
  const suffix = ` (${suffixIndex})`;
  const maxStemLength = Math.max(1, 255 - suffix.length - parts.extension.length);
  const stem = parts.stem.slice(0, maxStemLength).trimEnd() || '文件';
  return `${stem}${suffix}${parts.extension}`;
}

export function createBatchRenamePlan(
  items: readonly GuangyaItem[],
  siblings: readonly GuangyaItem[],
  rules: BatchRenameRules,
  conflictPolicy: RenameConflictPolicy,
  manualOverrides?: ReadonlyMap<string, string> | Record<string, string>,
): BatchRenamePlan {
  const selectedIds = new Set(items.map((item) => item.fileId));
  const entries: RenamePlanEntry[] = items.map((item, index) => {
    const manualName = manualValue(manualOverrides, item.fileId);
    let requestedName = '';
    let ruleError: string | undefined;
    try {
      requestedName = (manualName ?? applyRenameRules(item, rules, index)).trim();
    } catch (error) {
      ruleError = `正则表达式无效：${error instanceof Error ? error.message : String(error)}`;
    }
    const validationError = ruleError || validateGuangyaName(requestedName) || undefined;
    return {
      item,
      originalName: item.fileName,
      requestedName,
      finalName: requestedName,
      status: validationError ? 'invalid' : requestedName === item.fileName ? 'unchanged' : 'ready',
      reason: validationError,
      manual: manualName !== undefined,
    };
  });

  const unselectedReserved = new Set(
    siblings.filter((item) => !selectedIds.has(item.fileId)).map((item) => renameNameKey(item.fileName)),
  );

  if (conflictPolicy === 'auto-suffix') {
    const reserved = new Set(unselectedReserved);
    for (const entry of entries) {
      if (entry.status === 'invalid' || entry.status === 'unchanged') reserved.add(renameNameKey(entry.originalName));
    }
    for (const entry of entries) {
      if (entry.status !== 'ready') continue;
      let candidate = entry.requestedName;
      let key = renameNameKey(candidate);
      let suffixIndex = 1;
      while (reserved.has(key)) {
        candidate = suffixName(entry.requestedName, entry.item, suffixIndex++);
        key = renameNameKey(candidate);
      }
      const validationError = validateGuangyaName(candidate);
      if (validationError) {
        entry.status = 'invalid';
        entry.reason = validationError;
        reserved.add(renameNameKey(entry.originalName));
        continue;
      }
      entry.finalName = candidate;
      reserved.add(key);
    }
  } else {
    // 跳过项不会腾出原名；冲突可能沿名称依赖向前传播，因此迭代到状态稳定。
    const nonVacating = new Set(
      entries.filter((entry) => entry.status === 'invalid' || entry.status === 'unchanged').map((entry) => entry.item.fileId),
    );
    for (;;) {
      const reserved = new Set(unselectedReserved);
      for (const entry of entries) {
        if (nonVacating.has(entry.item.fileId)) reserved.add(renameNameKey(entry.originalName));
      }
      let addedConflict = false;
      for (const entry of entries) {
        if (entry.status === 'invalid' || entry.status === 'unchanged') continue;
        if (nonVacating.has(entry.item.fileId)) {
          entry.status = 'conflict';
          entry.reason = '新名称依赖的项目不会腾出原名称';
          continue;
        }
        entry.status = 'ready';
        entry.reason = undefined;
        entry.finalName = entry.requestedName;
        const key = renameNameKey(entry.finalName);
        if (reserved.has(key)) {
          entry.status = 'conflict';
          entry.reason = '新名称与当前目录中的其他项目或本批结果重名';
          nonVacating.add(entry.item.fileId);
          addedConflict = true;
        } else {
          reserved.add(key);
        }
      }
      if (!addedConflict) break;
    }
  }

  return { entries, ready: entries.filter((entry) => entry.status === 'ready') };
}

interface SuccessfulOperation {
  entry: RenamePlanEntry;
  fromName: string;
  toName: string;
  phase: RenameFailurePhase;
}

interface ExecuteOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ProgressInfo) => void;
  temporaryNameFactory?: (entry: RenamePlanEntry, index: number) => string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultTemporaryName(entry: RenamePlanEntry, index: number): string {
  const extension = entry.item.resType === 1 ? splitFileName(entry.originalName).extension : '';
  const marker = `__GY_RENAME_TMP_${Date.now()}_${index}`;
  return `${marker.slice(0, Math.max(1, 255 - extension.length))}${extension}`;
}

export async function executeBatchRename(
  api: RenameApiLike,
  plan: BatchRenamePlan,
  siblings: readonly GuangyaItem[],
  options: ExecuteOptions = {},
): Promise<RenameExecutionResult> {
  const pending = new Map(plan.ready.map((entry) => [entry.item.fileId, entry]));
  const occupancy = new Map<string, string>();
  const currentNames = new Map<string, string>();
  for (const sibling of siblings) {
    occupancy.set(renameNameKey(sibling.fileName), sibling.fileId);
    currentNames.set(sibling.fileId, sibling.fileName);
  }
  for (const entry of plan.ready) {
    if (!currentNames.has(entry.item.fileId)) {
      currentNames.set(entry.item.fileId, entry.originalName);
      occupancy.set(renameNameKey(entry.originalName), entry.item.fileId);
    }
  }

  const succeeded: RenamePlanEntry[] = [];
  const failures: RenameExecutionFailure[] = [];
  const residualRisks: string[] = [];
  let settled = 0;
  let temporarySequence = 0;
  let canceled = false;

  const report = (message: string): void => options.onProgress?.({
    phase: 'rename',
    message,
    current: settled,
    total: plan.ready.length,
  });

  const updateOccupancy = (fileId: string, fromName: string, toName: string): void => {
    const fromKey = renameNameKey(fromName);
    if (occupancy.get(fromKey) === fileId) occupancy.delete(fromKey);
    occupancy.set(renameNameKey(toName), fileId);
    currentNames.set(fileId, toName);
  };

  const perform = async (
    entry: RenamePlanEntry,
    fromName: string,
    toName: string,
    phase: RenameFailurePhase,
  ): Promise<string | null> => {
    report(phase === 'temporary'
      ? `正在为「${fromName}」设置循环中转名称`
      : phase === 'rollback'
        ? `正在回滚「${fromName}」→「${toName}」`
        : `正在重命名「${fromName}」→「${toName}」`);
    try {
      // 单项请求开始后等待其明确结果；取消只阻止尚未提交的后续重命名。
      await api.renameItem(entry.item.fileId, toName);
      updateOccupancy(entry.item.fileId, fromName, toName);
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  };

  const markBlocked = (entry: RenamePlanEntry, reason: string): void => {
    failures.push({
      item: entry.item,
      fromName: currentNames.get(entry.item.fileId) || entry.originalName,
      toName: entry.finalName,
      phase: 'blocked',
      error: reason,
    });
    pending.delete(entry.item.fileId);
    settled += 1;
  };

  const rollbackCycle = async (operations: SuccessfulOperation[]): Promise<void> => {
    for (const operation of [...operations].reverse()) {
      const currentName = currentNames.get(operation.entry.item.fileId) || operation.toName;
      const rollbackError = await perform(operation.entry, currentName, operation.fromName, 'rollback');
      if (rollbackError) {
        failures.push({
          item: operation.entry.item,
          fromName: currentName,
          toName: operation.fromName,
          phase: 'rollback',
          error: rollbackError,
        });
        residualRisks.push(`「${operation.entry.originalName}」可能仍使用中转名称「${currentName}」，请刷新后确认`);
      }
    }
  };

  const findCycle = (): RenamePlanEntry[] => {
    const first = pending.values().next().value as RenamePlanEntry | undefined;
    if (!first) return [];
    const order: string[] = [];
    const seen = new Map<string, number>();
    let currentId = first.item.fileId;
    while (pending.has(currentId)) {
      const seenAt = seen.get(currentId);
      if (seenAt !== undefined) return order.slice(seenAt).map((id) => pending.get(id)!);
      seen.set(currentId, order.length);
      order.push(currentId);
      const entry = pending.get(currentId)!;
      const owner = occupancy.get(renameNameKey(entry.finalName));
      if (!owner || !pending.has(owner)) return [];
      currentId = owner;
    }
    return [];
  };

  while (pending.size > 0) {
    if (options.signal?.aborted) {
      canceled = true;
      break;
    }

    const directlyReady = [...pending.values()].find((entry) => {
      const owner = occupancy.get(renameNameKey(entry.finalName));
      return !owner || owner === entry.item.fileId;
    });
    if (directlyReady) {
      const fromName = currentNames.get(directlyReady.item.fileId) || directlyReady.originalName;
      const renameError = await perform(directlyReady, fromName, directlyReady.finalName, 'rename');
      pending.delete(directlyReady.item.fileId);
      settled += 1;
      if (renameError) {
        failures.push({ item: directlyReady.item, fromName, toName: directlyReady.finalName, phase: 'rename', error: renameError });
      } else {
        succeeded.push(directlyReady);
      }
      continue;
    }

    const blocked = [...pending.values()].filter((entry) => {
      const owner = occupancy.get(renameNameKey(entry.finalName));
      return Boolean(owner && !pending.has(owner));
    });
    if (blocked.length > 0) {
      blocked.forEach((entry) => markBlocked(entry, '目标名称仍被重命名失败或未参与本批的项目占用'));
      continue;
    }

    const cycle = findCycle();
    if (cycle.length === 0) {
      [...pending.values()].forEach((entry) => markBlocked(entry, '无法解析名称占用依赖'));
      continue;
    }

    const cycleIds = new Set(cycle.map((entry) => entry.item.fileId));
    const root = cycle[0];
    let temporaryName = (options.temporaryNameFactory || defaultTemporaryName)(root, temporarySequence++);
    while (occupancy.has(renameNameKey(temporaryName)) || validateGuangyaName(temporaryName)) {
      temporaryName = defaultTemporaryName(root, temporarySequence++);
    }
    const operations: SuccessfulOperation[] = [];
    const rootFrom = currentNames.get(root.item.fileId) || root.originalName;
    const tempError = await perform(root, rootFrom, temporaryName, 'temporary');
    if (tempError) {
      failures.push({ item: root.item, fromName: rootFrom, toName: temporaryName, phase: 'temporary', error: tempError });
      for (const entry of cycle) {
        if (entry.item.fileId !== root.item.fileId) {
          failures.push({ item: entry.item, fromName: entry.originalName, toName: entry.finalName, phase: 'blocked', error: '循环中转名称创建失败' });
        }
        pending.delete(entry.item.fileId);
        settled += 1;
      }
      continue;
    }
    operations.push({ entry: root, fromName: rootFrom, toName: temporaryName, phase: 'temporary' });

    const cyclePending = new Map(cycle.map((entry) => [entry.item.fileId, entry]));
    let cycleError: { entry: RenamePlanEntry; fromName: string; error: string } | null = null;
    while (cyclePending.size > 0) {
      if (options.signal?.aborted) {
        canceled = true;
        break;
      }
      const next = [...cyclePending.values()].find((entry) => {
        const owner = occupancy.get(renameNameKey(entry.finalName));
        return !owner || owner === entry.item.fileId;
      });
      if (!next) {
        cycleError = { entry: root, fromName: currentNames.get(root.item.fileId) || temporaryName, error: '循环执行顺序异常' };
        break;
      }
      const fromName = currentNames.get(next.item.fileId) || next.originalName;
      const nextError = await perform(next, fromName, next.finalName, 'rename');
      if (nextError) {
        cycleError = { entry: next, fromName, error: nextError };
        break;
      }
      operations.push({ entry: next, fromName, toName: next.finalName, phase: 'rename' });
      cyclePending.delete(next.item.fileId);
    }

    if (cycleError || canceled) {
      await rollbackCycle(operations);
      if (cycleError) {
        failures.push({
          item: cycleError.entry.item,
          fromName: cycleError.fromName,
          toName: cycleError.entry.finalName,
          phase: 'rename',
          error: cycleError.error,
        });
      }
      for (const entry of cycle) {
        if (!failures.some((failure) => failure.item.fileId === entry.item.fileId)) {
          failures.push({
            item: entry.item,
            fromName: entry.originalName,
            toName: entry.finalName,
            phase: 'blocked',
            error: canceled ? '操作已取消，循环重命名已回滚' : '循环中其他项目失败，已回滚',
          });
        }
        pending.delete(entry.item.fileId);
        settled += 1;
      }
      if (canceled) break;
      continue;
    }

    for (const entry of cycle) {
      succeeded.push(entry);
      pending.delete(entry.item.fileId);
      settled += 1;
    }
    // 防止意外把循环外项目误判为占用者。
    for (const id of cycleIds) {
      if (!currentNames.has(id)) residualRisks.push(`循环项目 ${id} 的最终名称状态未知，请刷新后确认`);
    }
  }

  const canceledPending = canceled ? [...pending.values()] : [];
  report(canceled ? '批量重命名已取消' : '批量重命名完成');
  return {
    succeeded,
    skipped: [...plan.entries.filter((entry) => entry.status !== 'ready'), ...canceledPending],
    failures,
    canceled,
    residualRisks,
  };
}
