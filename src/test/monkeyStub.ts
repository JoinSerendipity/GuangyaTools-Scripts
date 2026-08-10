export const unsafeWindow = globalThis as unknown as Window & typeof globalThis;

const monkeyStorage = new Map<string, unknown>();

export function GM_getValue<T>(key: string, defaultValue?: T): T {
  return (monkeyStorage.has(key) ? monkeyStorage.get(key) : defaultValue) as T;
}

export function GM_setValue(key: string, value: unknown): void {
  monkeyStorage.set(key, value);
}

export function GM_deleteValue(key: string): void {
  monkeyStorage.delete(key);
}

export function __resetMonkeyStorage(): void {
  monkeyStorage.clear();
}
