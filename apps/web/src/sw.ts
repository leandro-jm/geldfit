/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

void self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
// Só o shell do app: respostas da API nunca são cacheadas.
precacheAndRoute(self.__WB_MANIFEST);

// SPA: toda navegação cai no index.html, menos /api.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }));

// Push -----------------------------------------------------------------------
interface PushPayload {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
}

self.addEventListener('push', (event) => {
  let data: PushPayload = { title: 'Saúde Financeira' };
  try {
    data = event.data?.json() ?? data;
  } catch {
    data = { title: 'Saúde Financeira', body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: '/pwa-192.png',
      badge: '/badge-72.png',
      data: { url: data.url ?? '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = all[0];
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'navigate', url });
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
