export const FileType = {
  UNKNOWN: 0,
  IMAGE: 1,
  VIDEO: 2,
  AUDIO: 3,
  DOCUMENT: 4,
  ARCHIVE: 5,
  SUBTITLE: 6,
  FONT: 7,
  INSTALLER: 8,
  TORRENT: 9,
  CODE: 10,
  OTHER: 11,
} as const;

export type FileTypeValue = (typeof FileType)[keyof typeof FileType];

export interface GuangyaItem {
  fileId: string;
  fileName: string;
  fileSize: number;
  parentId: string;
  parentName: string;
  depth: number;
  dirType: number;
  resType: 1 | 2;
  fileType: FileTypeValue;
  ext: string;
  fullParentIds: string;
  ctime: number;
  utime: number;
  subFolderCount?: number;
  auditStatus?: number;
}

export interface DirectoryRef {
  id: string;
  name: string;
  path: Array<{ id: string; name: string }>;
}

export interface ApiEnvelope<T> {
  code?: number;
  msg?: string;
  data: T;
}

export interface ListData {
  total: number;
  list: GuangyaItem[];
  page?: number;
}

export interface TaskData {
  taskId: string;
}

export interface TaskStatusData {
  status: number;
  detail?: {
    code?: number;
    msg?: string;
  };
}

export type CleanupRuleKind = 'suffix' | 'fileType' | 'fileName' | 'dirName';
export type NameMatchMode = 'contains' | 'equals' | 'regex';

export interface CleanupRule {
  id: string;
  enabled: boolean;
  kind: CleanupRuleKind;
  pattern: string;
  fileType?: FileTypeValue;
  matchMode: NameMatchMode;
  caseSensitive: boolean;
  maxSizeMb?: number;
}

export interface CleanupMatch {
  item: GuangyaItem;
  ruleIds: string[];
}

export interface ProgressInfo {
  phase: string;
  message: string;
  current: number;
  total: number;
}

export interface FailedBatch<T> {
  items: T[];
  error: string;
}

export interface MutationSummary<T> {
  succeeded: T[];
  failed: FailedBatch<T>[];
  canceled: boolean;
}

export interface FlattenConflict {
  item: GuangyaItem;
  reason: 'target-name-exists' | 'duplicate-candidate-name';
}

export interface FlattenDirectoryResult {
  directory: GuangyaItem;
  scannedFiles: number;
  movedFiles: GuangyaItem[];
  conflicts: FlattenConflict[];
  trashedConflictFiles: GuangyaItem[];
  trashedConflictDirectories: GuangyaItem[];
  retainedTopDirectories: GuangyaItem[];
  trashedTopDirectories: GuangyaItem[];
  failures: FailedBatch<GuangyaItem>[];
  canceled: boolean;
}

export type RenameConflictPolicy = 'skip' | 'auto-suffix';
export type RenameSequencePosition = 'prefix' | 'suffix';

export interface BatchRenameRules {
  preserveExtension: boolean;
  search: string;
  replacement: string;
  useRegex: boolean;
  caseSensitive: boolean;
  prefix: string;
  suffix: string;
  sequenceEnabled: boolean;
  sequenceStart: number;
  sequenceStep: number;
  sequencePadding: number;
  sequencePosition: RenameSequencePosition;
  sequenceSeparator: string;
}

export type RenamePlanStatus = 'ready' | 'unchanged' | 'invalid' | 'conflict';

export interface RenamePlanEntry {
  item: GuangyaItem;
  originalName: string;
  requestedName: string;
  finalName: string;
  status: RenamePlanStatus;
  reason?: string;
  manual: boolean;
}

export interface BatchRenamePlan {
  entries: RenamePlanEntry[];
  ready: RenamePlanEntry[];
}

export type RenameFailurePhase = 'rename' | 'temporary' | 'rollback' | 'blocked';

export interface RenameExecutionFailure {
  item: GuangyaItem;
  fromName: string;
  toName: string;
  phase: RenameFailurePhase;
  error: string;
}

export interface RenameExecutionResult {
  succeeded: RenamePlanEntry[];
  skipped: RenamePlanEntry[];
  failures: RenameExecutionFailure[];
  canceled: boolean;
  residualRisks: string[];
}
