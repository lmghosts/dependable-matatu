import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

// ─── Precache app shell (injected by vite-plugin-pwa) ──────
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ─── Graph binary files — cache-first (versioned URLs) ─────
// Files: /graph/timetable-{version}, /graph/stops-{version}
// Versioned URLs never change, so cache-first is safe forever.
registerRoute(
  ({ url }) => url.pathname.startsWith('/graph/timetable-') || url.pathname.startsWith('/graph/stops-'),
  new CacheFirst({
    cacheName: 'graph-binaries',
    plugins: [
      new ExpirationPlugin({ maxEntries: 4 }),
    ],
  })
);

// ─── Graph meta — network-first with offline fallback ──────
// meta.json is small and changes when a new graph is published.
registerRoute(
  ({ url }) => url.pathname === '/graph/meta.json',
  new NetworkFirst({
    cacheName: 'graph-meta',
    plugins: [
      new ExpirationPlugin({ maxEntries: 2, maxAgeSeconds: 86_400 }),
    ],
  })
);

// ─── Fonts — cache-first, long TTL ─────────────────────────
registerRoute(
  ({ url }) => url.origin === 'https://fonts.googleapis.com'
    || url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'google-fonts',
    plugins: [
      new ExpirationPlugin({ maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 }),
    ],
  })
);

// ─── Map tiles — cache-first, 7-day TTL, 2000 tile cap ─────
// CartoDB Dark Matter tiles cached as user browses Nairobi.
registerRoute(
  ({ url }) => url.hostname.endsWith('.basemaps.cartocdn.com'),
  new CacheFirst({
    cacheName: 'map-tiles',
    plugins: [
      new ExpirationPlugin({ maxEntries: 2000, maxAgeSeconds: 60 * 60 * 24 * 7 }),
    ],
  })
);

// ─── Skip waiting immediately ───────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
