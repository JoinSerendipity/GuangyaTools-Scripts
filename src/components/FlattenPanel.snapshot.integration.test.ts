// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { FileType, type GuangyaItem } from '../types';
import type { GuangyaApiLike, WalkResult } from '../services/guangyaApi';
import FlattenPanel from './FlattenPanel.vue';

vi.mock('../services/pageAdapter', () => ({
  getCurrentDirectory: () => ({ id: 'origin', name: 'Origin', path: [{ id: 'origin', name: 'Origin' }] }),
}));

const item = (fileId: string, fileName: string, parentId: string, resType: 1 | 2): GuangyaItem => ({
  fileId, fileName, parentId, parentName: '', fileSize: resType === 1 ? 1 : 0,
  depth: 1, dirType: 0, resType, fileType: resType === 1 ? FileType.DOCUMENT : FileType.UNKNOWN,
  ext: resType === 1 ? 'txt' : '', fullParentIds: parentId, ctime: 0, utime: 0,
});

function evidence(rootId: string, entries: GuangyaItem[]): WalkResult {
  const directories = entries.filter((entry) => entry.resType === 2);
  const listings = new Map<string, { parentId: string; observedTotal: number; orderedChildIds: string[]; complete: boolean }>();
  for (const id of [rootId, ...directories.map((entry) => entry.fileId)]) {
    const children = entries.filter((entry) => entry.parentId === id);
    listings.set(id, { parentId: id, observedTotal: children.length, orderedChildIds: children.map((entry) => entry.fileId), complete: true });
  }
  return {
    items: entries,
    directories,
    files: entries.filter((entry) => entry.resType === 1),
    itemById: new Map(entries.map((entry) => [entry.fileId, entry])),
    directoryListings: listings,
    complete: true,
  };
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('FlattenPanel snapshot timing', () => {
  it('validates only after confirmation and performs no writes when the tree changed while confirming', async () => {
    const selectedRoot = item('selected-root', 'Selected', 'origin', 2);
    const top = item('top', 'Top', selectedRoot.fileId, 2);
    const originalFile = item('file', 'before.txt', top.fileId, 1);
    const changedFile = item('file', 'after.txt', top.fileId, 1);
    let walkCalls = 0;
    let mutationCalls = 0;
    const api: GuangyaApiLike = {
      listAllChildren: async () => [],
      walkDescendants: async () => {
        walkCalls += 1;
        return walkCalls === 1
          ? evidence(selectedRoot.fileId, [top, originalFile])
          : evidence(selectedRoot.fileId, [top, changedFile]);
      },
      renameItem: async () => undefined,
      moveItems: async () => { mutationCalls += 1; return 'move'; },
      trashItems: async () => { mutationCalls += 1; return 'trash'; },
      waitTask: async () => undefined,
    };
    const wrapper = mount(FlattenPanel, {
      props: { api, directories: [selectedRoot], originDirectoryId: 'origin' },
      attachTo: document.body,
    });

    const clickButton = async (text: string) => {
      const button = [...document.body.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === text);
      expect(button, `missing button: ${text}`).toBeTruthy();
      (button as HTMLButtonElement).click();
      await flushPromises();
    };

    await clickButton('预检查');
    expect(walkCalls).toBe(1);
    await clickButton('开始解散');
    expect(walkCalls).toBe(1);
    await clickButton('复核并开始处理');
    expect(walkCalls).toBe(2);
    expect(mutationCalls).toBe(0);
    expect(document.body.textContent).toContain('预检查后发生变化');
    wrapper.unmount();
  });
});
