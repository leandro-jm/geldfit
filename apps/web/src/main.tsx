import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { Toaster } from 'sonner';
import { queryClient } from '@/lib/queries';
import { PrefsProvider, usePrefs } from '@/lib/prefs';
import { TooltipProvider } from '@/components/ui/menu';
import { router } from './router';
import './styles.css';

function ThemedToaster() {
  const { resolvedTheme } = usePrefs();
  return (
    <Toaster
      theme={resolvedTheme}
      position="top-center"
      richColors
      closeButton
      toastOptions={{ style: { borderRadius: 12 } }}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PrefsProvider>
        <TooltipProvider delayDuration={300}>
          <RouterProvider router={router} />
          <ThemedToaster />
        </TooltipProvider>
      </PrefsProvider>
    </QueryClientProvider>
  </StrictMode>,
);
