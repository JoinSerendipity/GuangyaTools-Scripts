import { describe, expect, it } from 'vitest';
import { useConfirmation } from './useConfirmation';

const options = { title: '危险操作', message: '是否继续？', danger: true };

describe('useConfirmation', () => {
  it('resolves true on confirmation and clears visible state', async () => {
    const controller = useConfirmation();
    const answer = controller.askConfirmation(options);
    expect(controller.confirmation.value).toEqual(options);
    controller.confirmConfirmation();
    await expect(answer).resolves.toBe(true);
    expect(controller.confirmation.value).toBeNull();
  });

  it('resolves false on cancellation', async () => {
    const controller = useConfirmation();
    const answer = controller.askConfirmation(options);
    controller.cancelConfirmation();
    await expect(answer).resolves.toBe(false);
  });

  it('cancels an older pending request when a newer dialog replaces it', async () => {
    const controller = useConfirmation();
    const first = controller.askConfirmation(options);
    const secondOptions = { title: '第二个操作', message: '继续第二个操作？' };
    const second = controller.askConfirmation(secondOptions);
    await expect(first).resolves.toBe(false);
    expect(controller.confirmation.value).toEqual(secondOptions);
    controller.confirmConfirmation();
    await expect(second).resolves.toBe(true);
  });

  it('cancels pending and future requests after disposal', async () => {
    const controller = useConfirmation();
    const pending = controller.askConfirmation(options);
    controller.disposeConfirmation();
    await expect(pending).resolves.toBe(false);
    expect(controller.confirmation.value).toBeNull();
    await expect(controller.askConfirmation(options)).resolves.toBe(false);
  });
});
