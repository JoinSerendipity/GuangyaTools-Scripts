import { beforeEach, describe, expect, it } from 'vitest';
import { __resetMonkeyStorage, GM_getValue, GM_setValue } from '../test/monkeyStub';
import {
  REQUEST_SPEED_STORAGE_KEY,
  initializeOperationSpeedMode,
  loadRequestSpeedSettings,
  reloadRequestSpeedSettings,
  saveRequestSpeedSettings,
} from './requestSpeedSettings';

beforeEach(() => {
  __resetMonkeyStorage();
  reloadRequestSpeedSettings();
});

describe('request speed settings', () => {
  it('defaults to disabled global mode and automatic operation mode', () => {
    expect(loadRequestSpeedSettings()).toEqual({ version: 1, globalEnabled: false, globalMode: 'auto' });
    expect(initializeOperationSpeedMode()).toBe('auto');
  });

  it('persists the global switch and mode', () => {
    saveRequestSpeedSettings(true, 'fast');
    expect(loadRequestSpeedSettings()).toEqual({ version: 1, globalEnabled: true, globalMode: 'fast' });
    expect(initializeOperationSpeedMode()).toBe('fast');
  });

  it('falls back and removes corrupt or unsupported storage', () => {
    GM_setValue(REQUEST_SPEED_STORAGE_KEY, { version: 9, globalEnabled: true, globalMode: 'unsafe' });
    expect(loadRequestSpeedSettings()).toEqual({ version: 1, globalEnabled: false, globalMode: 'auto' });
    expect(GM_getValue(REQUEST_SPEED_STORAGE_KEY, undefined)).toBeUndefined();
  });

  it('snapshots an operation mode independently of later global changes', () => {
    saveRequestSpeedSettings(true, 'balanced');
    const operationMode = initializeOperationSpeedMode();
    saveRequestSpeedSettings(true, 'conservative');
    expect(operationMode).toBe('balanced');
    expect(initializeOperationSpeedMode()).toBe('conservative');
  });
});
