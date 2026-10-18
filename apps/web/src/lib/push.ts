import { api } from '@/lib/api';

export type PushStatus = 'active' | 'inactive' | 'denied' | 'unavailable';

export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function b64ToUint8(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Sem service worker ativo (ex.: dev sem SW) o `ready` nunca resolve.
const swReady = (ms = 4000) =>
  Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);

export async function pushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await swReady();
  if (!reg) return 'unavailable';
  return (await reg.pushManager.getSubscription()) ? 'active' : 'inactive';
}

export async function enablePush() {
  const { publicKey } = await api<{ publicKey: string | null }>('/api/push/key');
  if (!publicKey) throw new Error('As notificações não estão configuradas neste servidor.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permissão de notificação negada.');
  const reg = await swReady();
  if (!reg) throw new Error('O app ainda está carregando. Tente de novo em instantes.');
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(publicKey) }));
  const json = sub.toJSON();
  await api('/api/push/subscriptions', {
    body: { endpoint: sub.endpoint, keys: json.keys, device: navigator.userAgent.slice(0, 200) },
  });
}

export async function disablePush() {
  const reg = await swReady();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api('/api/push/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}
