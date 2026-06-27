import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      manifest: {
        name: 'Matwana',
        short_name: 'Matwana',
        description: 'Plan your Nairobi matatu journey — offline-first',
        theme_color: '#0E0F12',
        background_color: '#0E0F12',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
        globIgnores: ['graph/**'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024, // 6MB — allows transit-map.svg (5.24MB)
      },
    }),
  ],
  optimizeDeps: {
    include: ['minotor'],
  },
  build: {
    target: 'es2020',
  },
});
