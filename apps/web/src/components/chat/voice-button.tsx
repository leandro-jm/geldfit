import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/menu';

const MAX_SECONDS = 120;
// Opus em WebM (Chrome/Firefox) ou MP4/AAC (Safari)
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export function voiceSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'MediaRecorder' in window &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

/**
 * Ditado: grava, transcreve no servidor e devolve o texto para a caixa de mensagem. O usuário
 * revisa antes de enviar (a transcrição pode errar um valor).
 */
export function VoiceButton({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    recorder.current?.stream.getTracks().forEach((t) => t.stop());
    recorder.current = null;
  };
  useEffect(() => cleanup, []);

  const start = async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast.error('Sem acesso ao microfone. Libere a permissão no navegador.');
      return;
    }
    const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      cleanup();
      const type = rec.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type });
      if (blob.size < 1500) {
        setState('idle');
        toast.info('Gravação muito curta. Segure um pouco mais.');
        return;
      }
      setState('transcribing');
      try {
        const fd = new FormData();
        fd.append(
          'file',
          blob,
          `audio.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`,
        );
        const r = await api<{ text: string }>('/api/chat/transcribe', { method: 'POST', body: fd });
        onText(r.text);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Não consegui transcrever o áudio.');
      } finally {
        setState('idle');
      }
    };
    recorder.current = rec;
    rec.start();
    setSeconds(0);
    setState('recording');
    timer.current = setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= MAX_SECONDS) recorder.current?.stop();
        return s + 1;
      });
    }, 1000);
  };

  const stop = () => recorder.current?.state === 'recording' && recorder.current.stop();

  const label =
    state === 'recording'
      ? `Parar gravação (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')})`
      : state === 'transcribing'
        ? 'Transcrevendo…'
        : 'Ditar mensagem';
  return (
    <Tip label={label} side="top">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          'relative size-10 shrink-0 rounded-xl',
          state === 'recording' && 'bg-negative-soft text-negative hover:bg-negative-soft',
        )}
        aria-label={label}
        aria-pressed={state === 'recording'}
        disabled={disabled || state === 'transcribing'}
        onClick={() => (state === 'recording' ? stop() : void start())}
        data-testid="voice-button"
      >
        {state === 'transcribing' ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : state === 'recording' ? (
          <>
            <Square className="fill-current" aria-hidden />
            <span
              className="absolute right-1.5 top-1.5 size-2 animate-pulse rounded-full bg-negative"
              aria-hidden
            />
          </>
        ) : (
          <Mic aria-hidden />
        )}
      </Button>
    </Tip>
  );
}
