import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import monkey from 'vite-plugin-monkey';

export default defineConfig({
  plugins: [
    vue(),
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: '光鸭网盘清理与解散工具',
        namespace: 'https://github.com/guangya-tools',
        version: '0.1.0',
        description: '为光鸭网盘提供文件清理和解散子目录功能',
        match: [
          'http://guangyapan.com/*',
          'https://guangyapan.com/*',
          'http://www.guangyapan.com/*',
          'https://www.guangyapan.com/*',
        ],
        connect: ['api.guangyapan.com'],
        grant: ['unsafeWindow', 'GM_getValue', 'GM_setValue', 'GM_deleteValue'],
        'run-at': 'document-start',
      },
      build: {
        fileName: 'guangya-tools.user.js',
      },
    }),
  ],
});
