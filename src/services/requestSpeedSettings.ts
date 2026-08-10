import { GM_deleteValue, GM_getValue, GM_setValue } from '$';
import { ref } from 'vue';

export type RequestSpeedMode = 'auto' | 'conservative' | 'balanced' | 'fast';

export interface RequestSpeedSettings {
  version: 1;
  globalEnabled: boolean;
  globalMode: RequestSpeedMode;
}

export interface RequestSpeedProfile {
  readConcurrency: number;
  readStartIntervalMs: number;
  mutationStartIntervalMs: number;
  pollStartIntervalMs: number;
  initialPollMs: number;
  acceptedTaskWindow: number;
}

export const REQUEST_SPEED_STORAGE_KEY = 'guangya-tools.request-speed';
export const REQUEST_SPEED_MODES: readonly RequestSpeedMode[] = ['auto', 'conservative', 'balanced', 'fast'];

export const REQUEST_SPEED_PROFILES: Readonly<Record<RequestSpeedMode, RequestSpeedProfile>> = Object.freeze({
  auto: Object.freeze({ readConcurrency: 3, readStartIntervalMs: 240, mutationStartIntervalMs: 600, pollStartIntervalMs: 650, initialPollMs: 450, acceptedTaskWindow: 2 }),
  conservative: Object.freeze({ readConcurrency: 1, readStartIntervalMs: 500, mutationStartIntervalMs: 1_000, pollStartIntervalMs: 1_000, initialPollMs: 800, acceptedTaskWindow: 1 }),
  balanced: Object.freeze({ readConcurrency: 3, readStartIntervalMs: 240, mutationStartIntervalMs: 600, pollStartIntervalMs: 650, initialPollMs: 450, acceptedTaskWindow: 2 }),
  fast: Object.freeze({ readConcurrency: 4, readStartIntervalMs: 150, mutationStartIntervalMs: 350, pollStartIntervalMs: 350, initialPollMs: 250, acceptedTaskWindow: 3 }),
});

const BUILTIN_SETTINGS: RequestSpeedSettings = { version: 1, globalEnabled: false, globalMode: 'auto' };

function isMode(value: unknown): value is RequestSpeedMode {
  return typeof value === 'string' && REQUEST_SPEED_MODES.includes(value as RequestSpeedMode);
}

export function parseRequestSpeedSettings(value: unknown): RequestSpeedSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.globalEnabled !== 'boolean' || !isMode(record.globalMode)) return null;
  return { version: 1, globalEnabled: record.globalEnabled, globalMode: record.globalMode };
}

export function loadRequestSpeedSettings(): RequestSpeedSettings {
  try {
    const raw = GM_getValue<unknown>(REQUEST_SPEED_STORAGE_KEY, undefined);
    if (raw === undefined) return { ...BUILTIN_SETTINGS };
    const parsed = parseRequestSpeedSettings(raw);
    if (parsed) return parsed;
    GM_deleteValue(REQUEST_SPEED_STORAGE_KEY);
  } catch {
    // GM 存储不可用时只影响持久化，不阻止文件操作。
  }
  return { ...BUILTIN_SETTINGS };
}

export const globalRequestSpeedSettings = ref<RequestSpeedSettings>(loadRequestSpeedSettings());

export function saveRequestSpeedSettings(globalEnabled: boolean, globalMode: RequestSpeedMode): RequestSpeedSettings {
  const settings: RequestSpeedSettings = { version: 1, globalEnabled, globalMode };
  GM_setValue(REQUEST_SPEED_STORAGE_KEY, settings);
  globalRequestSpeedSettings.value = settings;
  return settings;
}

export function reloadRequestSpeedSettings(): RequestSpeedSettings {
  const settings = loadRequestSpeedSettings();
  globalRequestSpeedSettings.value = settings;
  return settings;
}

export function initializeOperationSpeedMode(settings = globalRequestSpeedSettings.value): RequestSpeedMode {
  return settings.globalEnabled ? settings.globalMode : 'auto';
}
