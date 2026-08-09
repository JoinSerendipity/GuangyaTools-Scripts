import { unsafeWindow } from '$';

export interface AuthContext {
  authorization: string;
  did: string;
  dt: string;
  smid?: string;
  capturedAt: number;
}

const API_HOST = 'api.guangyapan.com';
const PATCH_FLAG = Symbol.for('guangya-tools.auth-capture-installed');
const listeners = new Set<(context: AuthContext) => void>();
let latestContext: AuthContext | null = null;

function isApiUrl(value: string): boolean {
  try {
    return new URL(value, 'https://www.guangyapan.com/').hostname === API_HOST;
  } catch {
    return false;
  }
}

function publish(headers: Record<string, string>): void {
  const authorization = headers.authorization;
  const did = headers.did;
  if (!authorization?.startsWith('Bearer ') || !did) return;

  latestContext = {
    authorization,
    did,
    dt: headers.dt || '4',
    smid: headers.smid || undefined,
    capturedAt: Date.now(),
  };
  for (const listener of listeners) listener(latestContext);
}

export function installAuthCapture(pageWindow: Window & typeof globalThis = unsafeWindow): void {
  const markedWindow = pageWindow as Window & { [PATCH_FLAG]?: boolean };
  if (markedWindow[PATCH_FLAG]) return;
  markedWindow[PATCH_FLAG] = true;

  const xhrUrls = new WeakMap<XMLHttpRequest, string>();
  const xhrHeaders = new WeakMap<XMLHttpRequest, Record<string, string>>();
  const proto = pageWindow.XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSetRequestHeader = proto.setRequestHeader;

  proto.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null,
  ): void {
    xhrUrls.set(this, String(url));
    xhrHeaders.set(this, {});
    originalOpen.call(this, method, url, async, username ?? null, password ?? null);
  } as typeof proto.open;

  proto.setRequestHeader = function patchedSetRequestHeader(this: XMLHttpRequest, name: string, value: string): void {
    if (isApiUrl(xhrUrls.get(this) || '')) {
      const normalizedName = name.toLowerCase();
      if (['authorization', 'did', 'dt', 'smid'].includes(normalizedName)) {
        const headers = xhrHeaders.get(this) || {};
        headers[normalizedName] = String(value);
        xhrHeaders.set(this, headers);
        publish(headers);
      }
    }
    originalSetRequestHeader.call(this, name, value);
  };

  const originalFetch = pageWindow.fetch.bind(pageWindow);
  pageWindow.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const isPageRequest = typeof pageWindow.Request === 'function' && input instanceof pageWindow.Request;
    const url = isPageRequest ? input.url : String(input);
    if (isApiUrl(url)) {
      const headers = new pageWindow.Headers(isPageRequest ? input.headers : undefined);
      new pageWindow.Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      const captured: Record<string, string> = {};
      for (const key of ['authorization', 'did', 'dt', 'smid']) {
        const value = headers.get(key);
        if (value) captured[key] = value;
      }
      publish(captured);
    }
    return originalFetch(input, init);
  }) as typeof pageWindow.fetch;
}

export function getAuthContext(): AuthContext | null {
  return latestContext ? { ...latestContext } : null;
}

export function clearAuthContext(): void {
  latestContext = null;
}

export function onAuthContext(listener: (context: AuthContext) => void): () => void {
  listeners.add(listener);
  if (latestContext) listener({ ...latestContext });
  return () => listeners.delete(listener);
}

export function waitForAuthContext(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<AuthContext> {
  const current = getAuthContext();
  if (current) return Promise.resolve(current);

  const { signal, timeoutMs = 30_000 } = options;
  return new Promise<AuthContext>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      listeners.delete(handleContext);
      signal?.removeEventListener('abort', handleAbort);
      if (timer) clearTimeout(timer);
    };
    const handleContext = (context: AuthContext): void => {
      cleanup();
      resolve({ ...context });
    };
    const handleAbort = (): void => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException('操作已取消', 'AbortError'));
    };

    listeners.add(handleContext);
    signal?.addEventListener('abort', handleAbort, { once: true });
    if (signal?.aborted) return handleAbort();
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('等待光鸭网盘登录鉴权超时，请刷新页面后重试'));
    }, timeoutMs);
  });
}
