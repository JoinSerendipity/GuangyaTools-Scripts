import { readonly, ref, type DeepReadonly, type Ref } from 'vue';

export interface ConfirmationOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export interface ConfirmationController {
  confirmation: DeepReadonly<Ref<ConfirmationOptions | null>>;
  askConfirmation: (options: ConfirmationOptions) => Promise<boolean>;
  confirmConfirmation: () => void;
  cancelConfirmation: () => void;
  disposeConfirmation: () => void;
}

export function useConfirmation(): ConfirmationController {
  const confirmation = ref<ConfirmationOptions | null>(null);
  let pendingResolver: ((confirmed: boolean) => void) | null = null;
  let disposed = false;

  function settle(confirmed: boolean): void {
    const resolve = pendingResolver;
    pendingResolver = null;
    confirmation.value = null;
    resolve?.(confirmed);
  }

  function askConfirmation(options: ConfirmationOptions): Promise<boolean> {
    settle(false);
    if (disposed) return Promise.resolve(false);
    confirmation.value = { ...options };
    return new Promise<boolean>((resolve) => {
      pendingResolver = resolve;
    });
  }

  function confirmConfirmation(): void {
    settle(true);
  }

  function cancelConfirmation(): void {
    settle(false);
  }

  function disposeConfirmation(): void {
    disposed = true;
    settle(false);
  }

  return {
    confirmation: readonly(confirmation),
    askConfirmation,
    confirmConfirmation,
    cancelConfirmation,
    disposeConfirmation,
  };
}
