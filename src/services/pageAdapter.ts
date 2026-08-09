import type { DirectoryRef, GuangyaItem } from '../types';
import type { GuangyaApiLike } from './guangyaApi';

const HOME_PREFIX = '/home/all';
const HOST_ATTRIBUTE = 'data-guangya-tools-entry';

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseFolderSegment(segment: string): { id: string; name: string } | null {
  const decoded = decodePart(segment);
  const separator = decoded.indexOf('-');
  if (separator <= 0) return null;
  const id = decoded.slice(0, separator);
  if (!/^\d+$/.test(id)) return null;
  return { id, name: decoded.slice(separator + 1) || '未命名目录' };
}

export function getCurrentDirectory(hash = window.location.hash): DirectoryRef | null {
  const path = hash.replace(/^#/, '').split('?')[0];
  if (path !== HOME_PREFIX && !path.startsWith(`${HOME_PREFIX}/`)) return null;
  const suffix = path.slice(HOME_PREFIX.length).replace(/^\/+/, '');
  const folders = suffix
    ? suffix
        .split('/')
        .map(parseFolderSegment)
        .filter((item): item is { id: string; name: string } => Boolean(item))
    : [];
  const current = folders.at(-1);
  return {
    id: current?.id || '',
    name: current?.name || '全部文件',
    path: folders,
  };
}

function selectedContainers(): HTMLElement[] {
  const selectors = [
    '.swangpan-file-list-table__row[data-state="selected"]',
    '.swangpan-file-list-grid__card[data-state="selected"]',
    '[data-ui="file-list-table"][data-slot="row"] [data-ui="checkbox"][data-state="checked"]',
  ];
  const containers = new Set<HTMLElement>();
  for (const node of document.querySelectorAll<HTMLElement>(selectors.join(','))) {
    const container = node.matches('[data-slot="row"],.swangpan-file-list-grid__card')
      ? node
      : node.closest<HTMLElement>('[data-slot="row"],.swangpan-file-list-grid__card');
    if (container) containers.add(container);
  }
  return [...containers];
}

export function getSelectedNames(): string[] {
  return selectedContainers()
    .map((container) => {
      const label = container.querySelector<HTMLElement>(
        '.swangpan-file-list-table__label,.swangpan-file-list-grid__label,[data-slot="label"]',
      );
      return (label?.getAttribute('title') || label?.textContent || '').trim();
    })
    .filter(Boolean);
}

export function matchSelectedItemsByName(selectedNames: readonly string[], children: readonly GuangyaItem[]): GuangyaItem[] {
  const byName = new Map<string, GuangyaItem[]>();
  for (const child of children) {
    const values = byName.get(child.fileName) || [];
    values.push(child);
    byName.set(child.fileName, values);
  }

  const result: GuangyaItem[] = [];
  const unresolved: string[] = [];
  const ambiguous: string[] = [];
  for (const name of selectedNames) {
    const matches = byName.get(name) || [];
    if (matches.length === 1) result.push(matches[0]);
    else if (matches.length === 0) unresolved.push(name);
    else ambiguous.push(name);
  }
  if (unresolved.length || ambiguous.length || result.length !== selectedNames.length) {
    const details = [
      unresolved.length ? `无法解析：${unresolved.join('、')}` : '',
      ambiguous.length ? `存在同名歧义：${ambiguous.join('、')}` : '',
    ].filter(Boolean).join('；');
    throw new Error(`未能安全解析全部选择项（${details || '选择数量不一致'}），操作已取消`);
  }
  return result;
}

export async function resolveSelectedItems(api: GuangyaApiLike): Promise<GuangyaItem[]> {
  const directory = getCurrentDirectory();
  if (!directory) return [];
  const selectedNames = getSelectedNames();
  if (selectedNames.length === 0) return [];
  const children = await api.listAllChildren(directory.id);
  return matchSelectedItemsByName(selectedNames, children);
}

function findToolbar(): HTMLElement | null {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
  const anchor = buttons.find((button) => button.textContent?.trim() === '新建文件夹');
  return anchor?.parentElement || null;
}

export function createEntryHost(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(`[${HOST_ATTRIBUTE}]`);
  const host = existing || document.createElement('div');
  host.setAttribute(HOST_ATTRIBUTE, 'true');

  const attach = (): void => {
    const toolbar = findToolbar();
    const target = toolbar || document.body;
    if (host.parentElement !== target) target.appendChild(host);
    host.dataset.floating = toolbar ? 'false' : 'true';
  };

  attach();
  const observer = new MutationObserver(() => attach());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('hashchange', attach);
  return host;
}

export function observePageState(callback: () => void): () => void {
  let frame = 0;
  const schedule = (): void => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      callback();
    });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-state', 'checked'],
  });
  window.addEventListener('hashchange', schedule);
  schedule();
  return () => {
    observer.disconnect();
    window.removeEventListener('hashchange', schedule);
    if (frame) window.cancelAnimationFrame(frame);
  };
}

export function requestNativeRefresh(): boolean {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.title === '刷新' || candidate.textContent?.trim() === '刷新',
  );
  button?.click();
  return Boolean(button);
}
