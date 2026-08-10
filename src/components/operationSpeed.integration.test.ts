// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { __resetMonkeyStorage } from '../test/monkeyStub';
import { reloadRequestSpeedSettings, saveRequestSpeedSettings } from '../services/requestSpeedSettings';
import type { GuangyaApiLike, WalkResult } from '../services/guangyaApi';
import { FileType, type DirectoryRef, type GuangyaItem } from '../types';
import RequestSpeedControl from './RequestSpeedControl.vue';
import CleanerPanel from './CleanerPanel.vue';
import FlattenPanel from './FlattenPanel.vue';
import BatchRenamePanel from './BatchRenamePanel.vue';

const directory: DirectoryRef = { id: 'root', name: 'Root', path: [{ id: 'root', name: 'Root' }] };
const selected: GuangyaItem = {
  fileId: 'selected', fileName: 'A.txt', fileSize: 1, parentId: 'root', parentName: 'Root', depth: 1,
  dirType: 0, resType: 1, fileType: FileType.DOCUMENT, ext: 'txt', fullParentIds: 'root', ctime: 0, utime: 0,
};
const emptyWalk: WalkResult = { items: [], directories: [], files: [], itemById: new Map(), complete: true };
const api: GuangyaApiLike = {
  listAllChildren: async () => [selected],
  walkDescendants: async () => emptyWalk,
  renameItem: async () => undefined,
  moveItems: async () => 'task',
  trashItems: async () => 'task',
  waitTask: async () => undefined,
};

beforeEach(() => {
  __resetMonkeyStorage();
  reloadRequestSpeedSettings();
  document.body.innerHTML = '';
});

describe('operation speed propagation', () => {
  it('snapshots the global default when each panel is created', async () => {
    saveRequestSpeedSettings(true, 'fast');
    const cleaner = mount(CleanerPanel, { props: { api, directory }, attachTo: document.body });
    expect(cleaner.findComponent(RequestSpeedControl).props('modelValue')).toBe('fast');

    saveRequestSpeedSettings(true, 'conservative');
    expect(cleaner.findComponent(RequestSpeedControl).props('modelValue')).toBe('fast');
    const flatten = mount(FlattenPanel, { props: { api, directories: [], originDirectoryId: 'root' }, attachTo: document.body });
    expect(flatten.findComponent(RequestSpeedControl).props('modelValue')).toBe('conservative');

    cleaner.unmount();
    flatten.unmount();
  });

  it('passes a panel-local override through the immutable API request context', async () => {
    let capturedMode = '';
    const recordingApi: GuangyaApiLike = {
      ...api,
      listAllChildren: async (_parentId, options) => {
        capturedMode = options?.context?.mode || '';
        return [];
      },
    };
    const cleaner = mount(CleanerPanel, { props: { api: recordingApi, directory }, attachTo: document.body });
    await cleaner.findComponent(RequestSpeedControl).findAll('select')[0].setValue('fast');
    const scanButton = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === '预扫描');
    scanButton?.click();
    await flushPromises();
    expect(capturedMode).toBe('fast');
    cleaner.unmount();
  });

  it('initializes every panel with automatic mode when global default is disabled', () => {
    saveRequestSpeedSettings(false, 'fast');
    const cleaner = mount(CleanerPanel, { props: { api, directory } });
    const flatten = mount(FlattenPanel, { props: { api, directories: [], originDirectoryId: 'root' } });
    const rename = mount(BatchRenamePanel, { props: { api, items: [selected], directory } });
    expect(cleaner.findComponent(RequestSpeedControl).props('modelValue')).toBe('auto');
    expect(flatten.findComponent(RequestSpeedControl).props('modelValue')).toBe('auto');
    expect(rename.findComponent(RequestSpeedControl).props('modelValue')).toBe('auto');
    cleaner.unmount(); flatten.unmount(); rename.unmount();
  });
});
