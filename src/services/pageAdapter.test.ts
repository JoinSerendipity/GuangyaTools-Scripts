import { describe, expect, it } from 'vitest';
import { FileType, type GuangyaItem } from '../types';
import { getCurrentDirectory, matchSelectedItemsByName } from './pageAdapter';

const child = (id: string, name: string): GuangyaItem => ({
  fileId: id, fileName: name, fileSize: 0, parentId: '', parentName: '', depth: 1,
  dirType: 0, resType: 2, fileType: FileType.UNKNOWN, ext: '', fullParentIds: '', ctime: 0, utime: 0,
});

describe('page route adapter', () => {
  it('parses the root and nested /home/all hash routes', () => {
    expect(getCurrentDirectory('#/home/all')).toEqual({ id: '', name: '全部文件', path: [] });
    expect(getCurrentDirectory('#/home/all/123-A/456-B-C')).toEqual({
      id: '456',
      name: 'B-C',
      path: [{ id: '123', name: 'A' }, { id: '456', name: 'B-C' }],
    });
  });

  it('returns null outside the all-files page', () => {
    expect(getCurrentDirectory('#/home/video')).toBeNull();
  });

  it('requires every selected display name to resolve exactly once', () => {
    expect(matchSelectedItemsByName(['A'], [child('1', 'A')])).toEqual([child('1', 'A')]);
    expect(() => matchSelectedItemsByName(['missing'], [child('1', 'A')])).toThrow('操作已取消');
    expect(() => matchSelectedItemsByName(['A'], [child('1', 'A'), child('2', 'A')])).toThrow('同名歧义');
  });
});
