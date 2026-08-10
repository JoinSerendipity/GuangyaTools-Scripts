<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue';
import type { ConfirmationOptions } from '../composables/useConfirmation';

const props = defineProps<{ options: ConfirmationOptions | null }>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();

const dialogId = `gya-confirm-${useId()}`;
const titleId = `${dialogId}-title`;
const messageId = `${dialogId}-message`;
const cancelButton = ref<HTMLButtonElement | null>(null);

watch(() => props.options, async (options) => {
  if (!options) return;
  await nextTick();
  cancelButton.value?.focus();
}, { flush: 'post' });
</script>

<template>
  <Teleport to="body">
    <Transition name="gya-confirm-fade">
      <div
        v-if="options"
        class="gya-confirm-mask"
        @click.self="emit('cancel')"
        @keydown.esc.prevent.stop="emit('cancel')"
      >
        <section
          class="gya-confirm-dialog"
          :class="{ 'is-danger': options.danger }"
          role="alertdialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          :aria-describedby="messageId"
        >
          <div class="gya-confirm-icon" aria-hidden="true">{{ options.danger ? '!' : '?' }}</div>
          <div class="gya-confirm-content">
            <h3 :id="titleId">{{ options.title }}</h3>
            <p :id="messageId">{{ options.message }}</p>
          </div>
          <footer>
            <button ref="cancelButton" type="button" class="gya-confirm-cancel" @click="emit('cancel')">
              {{ options.cancelText || '取消' }}
            </button>
            <button
              type="button"
              class="gya-confirm-submit"
              :class="{ 'is-danger': options.danger }"
              @click="emit('confirm')"
            >
              {{ options.confirmText || '确认' }}
            </button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.gya-confirm-mask{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:16px;box-sizing:border-box;background:rgba(15,23,42,.58);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2937}.gya-confirm-dialog{width:min(480px,100%);display:grid;grid-template-columns:44px minmax(0,1fr);gap:14px;background:#fff;border:1px solid #dbeafe;border-radius:14px;padding:22px;box-sizing:border-box;box-shadow:0 24px 70px rgba(15,23,42,.32)}.gya-confirm-dialog.is-danger{border-color:#fecaca}.gya-confirm-icon{width:42px;height:42px;display:grid;place-items:center;border-radius:50%;background:#dbeafe;color:#1d4ed8;font-size:24px;font-weight:800}.gya-confirm-dialog.is-danger .gya-confirm-icon{background:#fee2e2;color:#b91c1c}.gya-confirm-content{min-width:0}.gya-confirm-content h3{margin:1px 0 8px;font-size:19px;line-height:1.35;color:#111827}.gya-confirm-content p{margin:0;color:#4b5563;white-space:pre-line;overflow-wrap:anywhere}.gya-confirm-dialog footer{grid-column:1/-1;display:flex;justify-content:flex-end;gap:10px;margin-top:8px}.gya-confirm-dialog button{border:0;border-radius:8px;padding:9px 16px;cursor:pointer;font:inherit;font-weight:600}.gya-confirm-dialog button:focus-visible{outline:3px solid rgba(37,99,235,.3);outline-offset:2px}.gya-confirm-cancel{background:#e2e8f0;color:#1e293b}.gya-confirm-submit{background:#2563eb;color:#fff}.gya-confirm-submit.is-danger{background:#dc2626}.gya-confirm-submit.is-danger:hover{background:#b91c1c}.gya-confirm-cancel:hover{background:#cbd5e1}.gya-confirm-submit:not(.is-danger):hover{background:#1d4ed8}.gya-confirm-fade-enter-active,.gya-confirm-fade-leave-active{transition:opacity .15s ease}.gya-confirm-fade-enter-active .gya-confirm-dialog,.gya-confirm-fade-leave-active .gya-confirm-dialog{transition:transform .15s ease}.gya-confirm-fade-enter-from,.gya-confirm-fade-leave-to{opacity:0}.gya-confirm-fade-enter-from .gya-confirm-dialog,.gya-confirm-fade-leave-to .gya-confirm-dialog{transform:translateY(8px) scale(.98)}@media(max-width:480px){.gya-confirm-dialog{grid-template-columns:36px minmax(0,1fr);gap:11px;padding:18px}.gya-confirm-icon{width:36px;height:36px;font-size:20px}.gya-confirm-dialog footer{flex-direction:column-reverse}.gya-confirm-dialog button{width:100%}}
</style>
