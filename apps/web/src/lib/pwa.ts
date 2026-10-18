import { useEffect, useState } from 'react';

/** Evento não padronizado do Chrome/Edge (Android e desktop). */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// iPadOS se apresenta como Mac; o toque denuncia.
export const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as { standalone?: boolean }).standalone === true;

// O evento dispara uma única vez, cedo: capturamos no carregamento do módulo (importado em
// main.tsx) para não perdê-lo se o usuário só abrir as Configurações depois.
let captured: BeforeInstallPromptEvent | null = null;
const listeners = new Set<(e: BeforeInstallPromptEvent | null) => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    captured = e as BeforeInstallPromptEvent;
    listeners.forEach((f) => f(captured));
  });
  window.addEventListener('appinstalled', () => {
    captured = null;
    listeners.forEach((f) => f(null));
  });
}

/** Prompt de instalação disponível + se o app já roda instalado. */
export function useInstallApp() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(captured);
  const [installed, setInstalled] = useState(() => isStandalone());

  useEffect(() => {
    const f = (e: BeforeInstallPromptEvent | null) => {
      setPrompt(e);
      if (!e) setInstalled(true);
    };
    listeners.add(f);
    return () => void listeners.delete(f);
  }, []);

  const install = async () => {
    if (!prompt) return false;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    captured = null;
    setPrompt(null); // o evento só pode ser usado uma vez
    if (outcome === 'accepted') setInstalled(true);
    return outcome === 'accepted';
  };

  return { canInstall: !!prompt, installed, install };
}
