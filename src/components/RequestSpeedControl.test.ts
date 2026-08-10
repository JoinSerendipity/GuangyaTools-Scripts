// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { __resetMonkeyStorage } from '../test/monkeyStub';
import { requestScheduler } from '../services/requestScheduler';
import { loadRequestSpeedSettings, reloadRequestSpeedSettings } from '../services/requestSpeedSettings';
import RequestSpeedControl from './RequestSpeedControl.vue';

beforeEach(() => {
  __resetMonkeyStorage();
  reloadRequestSpeedSettings();
  requestScheduler.resetForTests();
});

afterEach(() => requestScheduler.resetForTests());

describe('RequestSpeedControl', () => {
  it('keeps the operation override independent from persisted global settings', async () => {
    const wrapper = mount(RequestSpeedControl, { props: { modelValue: 'balanced' } });
    const selects = wrapper.findAll('select');
    expect((selects[0].element as HTMLSelectElement).value).toBe('balanced');

    await wrapper.find('input[type="checkbox"]').setValue(true);
    await selects[1].setValue('fast');
    expect(loadRequestSpeedSettings()).toMatchObject({ globalEnabled: true, globalMode: 'fast' });
    expect((selects[0].element as HTMLSelectElement).value).toBe('balanced');

    await selects[0].setValue('conservative');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['conservative']);
    expect(loadRequestSpeedSettings().globalMode).toBe('fast');
    wrapper.unmount();
  });

  it('shows shared scheduler backoff state', async () => {
    const wrapper = mount(RequestSpeedControl, { props: { modelValue: 'auto' } });
    requestScheduler.penalize(2_000, '429');
    await nextTick();
    expect(wrapper.text()).toContain('退避保护中');
    wrapper.unmount();
  });

  it('freezes both local and global controls while busy', () => {
    const wrapper = mount(RequestSpeedControl, { props: { modelValue: 'auto', disabled: true } });
    expect(wrapper.findAll('select').every((entry) => (entry.element as HTMLSelectElement).disabled)).toBe(true);
    expect((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).disabled).toBe(true);
    wrapper.unmount();
  });
});
