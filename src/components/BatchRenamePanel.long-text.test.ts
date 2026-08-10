// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { FileType, type DirectoryRef, type GuangyaItem } from '../types';
import type { GuangyaApiLike } from '../services/guangyaApi';
import BatchRenamePanel from './BatchRenamePanel.vue';
import panelSource from './BatchRenamePanel.vue?raw';

vi.mock('../services/pageAdapter', () => ({
  getCurrentDirectory: () => ({ id: 'root', name: 'Root', path: [{ id: 'root', name: 'Root' }] }),
}));

const directory: DirectoryRef = { id: 'root', name: 'Root', path: [{ id: 'root', name: 'Root' }] };
const selected: GuangyaItem = {
  fileId: 'file', fileName: 'old.txt', fileSize: 1, parentId: 'root', parentName: 'Root', depth: 1,
  dirType: 0, resType: 1, fileType: FileType.DOCUMENT, ext: 'txt', fullParentIds: 'root', ctime: 0, utime: 0,
};

beforeEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});

describe('BatchRenamePanel long find/replace editors', () => {
  it('uses full-width wrapping textareas and preserves long bound values', async () => {
    const api: GuangyaApiLike = {
      listAllChildren: async () => [selected],
      walkDescendants: async () => ({ items: [], directories: [], files: [] }),
      renameItem: async () => undefined,
      moveItems: async () => '', trashItems: async () => '', waitTask: async () => undefined,
    };
    const wrapper = mount(BatchRenamePanel, { props: { api, items: [selected], directory }, attachTo: document.body });
    await flushPromises();

    const fieldset = document.body.querySelector('fieldset.gya-replace-field');
    expect(fieldset).toBeTruthy();
    const editors = [...fieldset!.querySelectorAll('textarea')] as HTMLTextAreaElement[];
    expect(editors).toHaveLength(2);
    for (const editor of editors) {
      expect(editor.getAttribute('rows')).toBe('3');
      expect(editor.getAttribute('wrap')).toBe('soft');
      expect(editor.getAttribute('spellcheck')).toBe('false');
    }
    expect(fieldset!.querySelectorAll('.gya-replace-options input[type="checkbox"]')).toHaveLength(2);

    const setEditorValue = async (editor: HTMLTextAreaElement, value: string) => {
      editor.value = value;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      await flushPromises();
    };
    const longSearch = `^(?:${'非常长的查找正则内容'.repeat(40)})$`;
    const longReplacement = '很长的替换内容'.repeat(60);
    await setEditorValue(editors[0], longSearch);
    await setEditorValue(editors[1], longReplacement);
    expect(editors[0].value).toBe(longSearch);
    expect(editors[1].value).toBe(longReplacement);

    const originalName = document.body.querySelector('.gya-original-name');
    expect(originalName?.textContent).toBe('old.txt');
    expect(originalName?.getAttribute('title')).toBe('old.txt');
    expect(document.body.querySelectorAll('.gya-original-actions button')).toHaveLength(2);
    const newNameEditor = document.body.querySelector('.gya-name-editor textarea') as HTMLTextAreaElement;
    expect(newNameEditor).toBeTruthy();
    expect(newNameEditor.rows).toBe(2);
    expect(newNameEditor.wrap).toBe('soft');
    expect(document.body.querySelector('.gya-extension')?.textContent).toBe('.txt');

    expect(panelSource).toContain('.gya-replace-field,.gya-sequence-field{grid-column:1/-1}');
    expect(panelSource).toContain('overflow-wrap:anywhere');
    expect(panelSource).toContain('.gya-panel ::selection');
    expect(panelSource).toContain('.gya-panel ::-moz-selection');
    expect(panelSource).toContain('user-select:text');
    expect(panelSource).not.toContain('td:nth-child(2){max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}');
    expect(panelSource).toContain('@media(max-width:800px)');
    expect(panelSource).toContain('@media(max-width:480px)');
    wrapper.unmount();
  });

  it('fills the searchable name, focuses/selects it, and copies the full original with fallback', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
    const api: GuangyaApiLike = {
      listAllChildren: async () => [selected],
      walkDescendants: async () => ({ items: [], directories: [], files: [] }),
      renameItem: async () => undefined,
      moveItems: async () => '', trashItems: async () => '', waitTask: async () => undefined,
    };
    const wrapper = mount(BatchRenamePanel, { props: { api, items: [selected], directory }, attachTo: document.body });
    await flushPromises();
    const search = document.body.querySelector('textarea[aria-label="查找内容"]') as HTMLTextAreaElement;
    const findAction = (text: string) => [...document.body.querySelectorAll('.gya-original-actions button')]
      .find((button) => button.textContent?.trim() === text) as HTMLButtonElement;

    findAction('填入查找').click();
    await flushPromises();
    expect(search.value).toBe('old');
    expect(document.activeElement).toBe(search);
    expect(search.selectionStart).toBe(0);
    expect(search.selectionEnd).toBe(3);

    const preserveLabel = [...document.body.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('文件保留扩展名'))!;
    (preserveLabel.querySelector('input') as HTMLInputElement).click();
    await flushPromises();
    findAction('填入查找').click();
    await flushPromises();
    expect(search.value).toBe('old.txt');

    findAction('复制原名').click();
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('old.txt');
    expect(prompt).not.toHaveBeenCalled();

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error('denied'); }) },
    });
    findAction('复制原名').click();
    await flushPromises();
    expect(prompt).toHaveBeenCalledWith('复制完整原名称', 'old.txt');
    wrapper.unmount();
    prompt.mockRestore();
  });

  it('fills a directory name in full even while extension preservation is enabled', async () => {
    const selectedDirectory: GuangyaItem = {
      ...selected, fileId: 'directory', fileName: 'Folder.name', resType: 2, fileType: FileType.UNKNOWN, ext: '', fileSize: 0,
    };
    const api: GuangyaApiLike = {
      listAllChildren: async () => [selectedDirectory],
      walkDescendants: async () => ({ items: [], directories: [], files: [] }),
      renameItem: async () => undefined,
      moveItems: async () => '', trashItems: async () => '', waitTask: async () => undefined,
    };
    const wrapper = mount(BatchRenamePanel, { props: { api, items: [selectedDirectory], directory }, attachTo: document.body });
    await flushPromises();
    const fill = [...document.body.querySelectorAll('.gya-original-actions button')]
      .find((button) => button.textContent?.trim() === '填入查找') as HTMLButtonElement;
    fill.click();
    await flushPromises();
    expect((document.body.querySelector('textarea[aria-label="查找内容"]') as HTMLTextAreaElement).value).toBe('Folder.name');
    wrapper.unmount();
  });

  it('keeps both textareas disabled while renaming and after completion', async () => {
    let resolveRename!: () => void;
    const pendingRename = new Promise<void>((resolve) => { resolveRename = resolve; });
    const renameItem = vi.fn(async () => pendingRename);
    const api: GuangyaApiLike = {
      listAllChildren: async () => [selected],
      walkDescendants: async () => ({ items: [], directories: [], files: [] }),
      renameItem,
      moveItems: async () => '', trashItems: async () => '', waitTask: async () => undefined,
    };
    const wrapper = mount(BatchRenamePanel, { props: { api, items: [selected], directory }, attachTo: document.body });
    await flushPromises();
    const editors = [...document.body.querySelectorAll('.gya-replace-field textarea')] as HTMLTextAreaElement[];
    const setEditorValue = async (editor: HTMLTextAreaElement, value: string) => {
      editor.value = value;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      await flushPromises();
    };
    await setEditorValue(editors[0], 'old');
    await setEditorValue(editors[1], 'new');
    const longManualName = '可完整软换行编辑的新名称'.repeat(12);
    const newNameEditor = document.body.querySelector('.gya-name-editor textarea') as HTMLTextAreaElement;
    await setEditorValue(newNameEditor, longManualName);
    expect(newNameEditor.value).toBe(longManualName);
    expect(document.body.querySelector('.gya-extension')?.textContent).toBe('.txt');

    const clickButton = async (text: string, prefix = false) => {
      const button = [...document.body.querySelectorAll('button')].find((entry) =>
        prefix ? entry.textContent?.trim().startsWith(text) : entry.textContent?.trim() === text);
      expect(button, `missing button: ${text}`).toBeTruthy();
      (button as HTMLButtonElement).click();
      await flushPromises();
    };
    await clickButton('开始重命名（', true);
    await clickButton('开始重命名');
    expect(renameItem).toHaveBeenCalledWith('file', `${longManualName}.txt`, expect.anything());
    expect([...document.body.querySelectorAll('textarea')]
      .every((editor) => (editor as HTMLTextAreaElement).disabled)).toBe(true);
    expect([...document.body.querySelectorAll('.gya-original-actions button')]
      .every((button) => (button as HTMLButtonElement).disabled)).toBe(true);

    resolveRename();
    await flushPromises();
    expect([...document.body.querySelectorAll('textarea')]
      .every((editor) => (editor as HTMLTextAreaElement).disabled)).toBe(true);
    wrapper.unmount();
  });
});
