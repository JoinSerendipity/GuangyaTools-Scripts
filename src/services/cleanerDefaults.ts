import { GM_deleteValue, GM_getValue, GM_setValue } from '$';
import { FileType, type CleanupRule, type CleanupRuleKind, type FileTypeValue, type NameMatchMode } from '../types';
import { validateCleanupRule } from './cleaner';

export const CLEANER_DEFAULTS_STORAGE_KEY = 'guangya-tools.cleaner-defaults';
const CLEANER_DEFAULTS_VERSION = 1;
const MAX_PRESET_RULES = 100;
const MAX_PATTERN_LENGTH = 10_000;

interface StoredCleanupRule {
  enabled: boolean;
  kind: CleanupRuleKind;
  pattern: string;
  fileType?: FileTypeValue;
  matchMode: NameMatchMode;
  caseSensitive: boolean;
  maxSizeMb?: number;
}

export interface CleanerDefaultsPresetV1 {
  version: 1;
  rules: StoredCleanupRule[];
  recursive?: boolean;
}

export interface LoadedCleanerDefaults {
  rules: CleanupRule[];
  recursive: boolean;
  includesRecursive: boolean;
  source: 'saved' | 'builtin' | 'fallback';
  message?: string;
}

let ruleSequence = 0;

function nextRuleId(): string {
  return `rule-${Date.now()}-${ruleSequence++}`;
}

export function createCleanupRule(kind: CleanupRuleKind = 'suffix'): CleanupRule {
  return {
    id: nextRuleId(),
    enabled: true,
    kind,
    pattern: kind === 'suffix' ? 'txt' : '',
    fileType: kind === 'fileType' ? FileType.DOCUMENT : undefined,
    matchMode: 'contains',
    caseSensitive: false,
    maxSizeMb: undefined,
  };
}

export function createBuiltInCleanupRules(): CleanupRule[] {
  return [createCleanupRule('suffix')];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCleanupRuleKind(value: unknown): value is CleanupRuleKind {
  return ['suffix', 'fileType', 'fileName', 'dirName'].includes(String(value));
}

function isNameMatchMode(value: unknown): value is NameMatchMode {
  return ['contains', 'equals', 'regex'].includes(String(value));
}

function isFileType(value: unknown): value is FileTypeValue {
  return Number.isInteger(value) && Number(value) >= FileType.UNKNOWN && Number(value) <= FileType.OTHER;
}

function parseStoredRule(value: unknown): CleanupRule | null {
  if (!isRecord(value)) return null;
  if (typeof value.enabled !== 'boolean' || !isCleanupRuleKind(value.kind)) return null;
  if (typeof value.pattern !== 'string' || value.pattern.length > MAX_PATTERN_LENGTH) return null;
  if (!isNameMatchMode(value.matchMode) || typeof value.caseSensitive !== 'boolean') return null;
  if (value.fileType !== undefined && !isFileType(value.fileType)) return null;
  if (value.kind === 'fileType' && !isFileType(value.fileType)) return null;
  if (value.maxSizeMb !== undefined && (typeof value.maxSizeMb !== 'number' || !Number.isFinite(value.maxSizeMb) || value.maxSizeMb < 0)) return null;

  const rule: CleanupRule = {
    id: nextRuleId(),
    enabled: value.enabled,
    kind: value.kind,
    pattern: value.pattern,
    fileType: value.fileType as FileTypeValue | undefined,
    matchMode: value.matchMode,
    caseSensitive: value.caseSensitive,
    maxSizeMb: value.maxSizeMb as number | undefined,
  };
  return validateCleanupRule(rule) ? null : rule;
}

export function parseCleanerDefaultsPreset(value: unknown): { rules: CleanupRule[]; recursive?: boolean } | null {
  if (!isRecord(value) || value.version !== CLEANER_DEFAULTS_VERSION || !Array.isArray(value.rules)) return null;
  if (value.rules.length === 0 || value.rules.length > MAX_PRESET_RULES) return null;
  if (value.recursive !== undefined && typeof value.recursive !== 'boolean') return null;

  const rules: CleanupRule[] = [];
  for (const rawRule of value.rules) {
    const rule = parseStoredRule(rawRule);
    if (!rule) return null;
    rules.push(rule);
  }
  if (!rules.some((rule) => rule.enabled)) return null;
  return { rules, recursive: value.recursive as boolean | undefined };
}

function serializeRule(rule: CleanupRule): StoredCleanupRule {
  const raw: StoredCleanupRule = {
    enabled: rule.enabled,
    kind: rule.kind,
    pattern: rule.pattern,
    matchMode: rule.matchMode,
    caseSensitive: rule.caseSensitive,
  };
  if (rule.fileType !== undefined) raw.fileType = rule.fileType;
  if (rule.maxSizeMb !== undefined) raw.maxSizeMb = rule.maxSizeMb;
  if (!parseStoredRule(raw)) throw new Error(`规则「${rule.pattern || rule.kind}」无效，无法保存为默认`);
  return raw;
}

export function serializeCleanerDefaultsPreset(
  rules: readonly CleanupRule[],
  options: { includeRecursive: boolean; recursive: boolean },
): CleanerDefaultsPresetV1 {
  if (!rules.length) throw new Error('请至少保留一条清理规则');
  if (!rules.some((rule) => rule.enabled)) throw new Error('请至少启用一条清理规则');
  if (rules.length > MAX_PRESET_RULES) throw new Error(`默认规则不能超过 ${MAX_PRESET_RULES} 条`);

  const preset: CleanerDefaultsPresetV1 = {
    version: CLEANER_DEFAULTS_VERSION,
    rules: rules.map(serializeRule),
  };
  if (options.includeRecursive) preset.recursive = options.recursive;
  return preset;
}

export function saveCleanerDefaults(
  rules: readonly CleanupRule[],
  options: { includeRecursive: boolean; recursive: boolean },
): CleanerDefaultsPresetV1 {
  const preset = serializeCleanerDefaultsPreset(rules, options);
  GM_setValue(CLEANER_DEFAULTS_STORAGE_KEY, preset);
  return preset;
}

export function loadCleanerDefaults(): LoadedCleanerDefaults {
  let stored: unknown;
  try {
    stored = GM_getValue<unknown>(CLEANER_DEFAULTS_STORAGE_KEY, undefined);
  } catch (error) {
    return {
      rules: createBuiltInCleanupRules(),
      recursive: false,
      includesRecursive: false,
      source: 'fallback',
      message: `读取默认规则失败，已使用内置默认：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (stored === undefined) {
    return { rules: createBuiltInCleanupRules(), recursive: false, includesRecursive: false, source: 'builtin' };
  }
  const parsed = parseCleanerDefaultsPreset(stored);
  if (!parsed) {
    try { GM_deleteValue(CLEANER_DEFAULTS_STORAGE_KEY); } catch { /* 下次仍会安全回退。 */ }
    return {
      rules: createBuiltInCleanupRules(),
      recursive: false,
      includesRecursive: false,
      source: 'fallback',
      message: '已保存的默认规则损坏或版本不兼容，已清除并恢复内置默认',
    };
  }
  return {
    rules: parsed.rules,
    recursive: parsed.recursive ?? false,
    includesRecursive: parsed.recursive !== undefined,
    source: 'saved',
  };
}

export function clearCleanerDefaults(): LoadedCleanerDefaults {
  GM_deleteValue(CLEANER_DEFAULTS_STORAGE_KEY);
  return { rules: createBuiltInCleanupRules(), recursive: false, includesRecursive: false, source: 'builtin' };
}
