import { createApp } from 'vue';
import App from './App.vue';
import { installAuthCapture } from './services/authCapture';
import { createEntryHost } from './services/pageAdapter';

installAuthCapture();

function mount(): void {
  const host = createEntryHost();
  if (host.dataset.vueMounted === 'true') return;
  host.dataset.vueMounted = 'true';
  createApp(App).mount(host);
}

if (document.body) mount();
else document.addEventListener('DOMContentLoaded', mount, { once: true });
