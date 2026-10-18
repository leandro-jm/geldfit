import { useState } from 'react';
import { motion } from 'motion/react';
import { AudioLines, Maximize2, Mic, MicOff, Minimize2, PhoneOff, RotateCcw, X } from 'lucide-react';
import { useBreakpoint, useReducedMotion } from '@/lib/media';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/menu';
import { toolLabel } from './chat-context';
import { VoiceOrb } from './voice-orb';
import type { VoiceSessionApi } from './use-voice-session';

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function statusText(v: VoiceSessionApi): string {
  switch (v.state) {
    case 'connecting':
      return 'Conectando…';
    case 'listening':
      return v.muted ? 'Microfone desligado' : 'Ouvindo… pode falar';
    case 'thinking':
      return v.activeTool ? toolLabel(v.activeTool) : 'Pensando…';
    case 'speaking':
      return 'Falando…';
    case 'error':
      return v.error ?? 'Não foi possível conectar.';
    default:
      return '';
  }
}

/** Botão que abre a conversa por voz. */
export function VoiceModeButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <Tip label="Conversar por voz" side="top">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn('size-10 shrink-0 rounded-xl text-[var(--coin-3)] dark:text-[var(--coin-1)]', className)}
        aria-label="Conversar por voz"
        onClick={onClick}
        data-testid="voice-mode-button"
      >
        <AudioLines aria-hidden />
      </Button>
    </Tip>
  );
}

function RoundButton({
  label,
  onClick,
  children,
  variant = 'secondary',
  pressed,
  small,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  variant?: 'secondary' | 'danger' | 'ghost';
  pressed?: boolean;
  small?: boolean;
}) {
  return (
    <Tip label={label} side="bottom">
      <Button
        type="button"
        variant={variant}
        size="icon"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={cn('shrink-0 rounded-full', small ? 'size-9' : 'size-12 [&_svg]:size-5')}
      >
        {children}
      </Button>
    </Tip>
  );
}

/**
 * Palco da conversa por voz, incorporado ao topo do chat (estilo "modo voz"): orbe, estado e
 * controles. As falas transcritas, prévias e gráficos continuam aparecendo na lista logo abaixo.
 */
export function VoiceStage({ voice }: { voice: VoiceSessionApi }) {
  const [min, setMin] = useState(false);
  const bp = useBreakpoint();
  const reduced = useReducedMotion();
  const status = statusText(voice);
  const live = voice.state !== 'error' && voice.state !== 'connecting';
  const timer = voice.maxSeconds ? `${clock(voice.elapsed)} / ${clock(voice.maxSeconds)}` : clock(voice.elapsed);

  const mute = (
    <RoundButton
      label={voice.muted ? 'Ligar microfone' : 'Silenciar microfone'}
      onClick={voice.toggleMute}
      pressed={voice.muted}
      small={min}
    >
      {voice.muted ? <MicOff aria-hidden /> : <Mic aria-hidden />}
    </RoundButton>
  );
  const hangUp = (
    <RoundButton label="Encerrar conversa por voz" variant="danger" onClick={() => voice.end()} small={min}>
      <PhoneOff aria-hidden />
    </RoundButton>
  );

  return (
    <motion.section
      initial={reduced ? false : { height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={reduced ? undefined : { height: 0, opacity: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="relative shrink-0 overflow-hidden border-b bg-[radial-gradient(ellipse_at_top,var(--coin-glow),transparent_70%)]"
      aria-label="Conversa por voz"
      data-testid="voice-stage"
      data-minimized={min}
    >
      {min ? (
        <div className="flex h-14 items-center gap-2.5 px-3">
          <VoiceOrb state={voice.state} levelRef={voice.levelRef} size={40} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-medium" aria-live="polite">
              {status}
            </p>
            {live ? <p className="text-[11.5px] tabular-nums text-muted-foreground">{timer}</p> : null}
          </div>
          <RoundButton label="Expandir" variant="ghost" onClick={() => setMin(false)} small>
            <Maximize2 aria-hidden />
          </RoundButton>
          {voice.state === 'error' ? (
            <RoundButton label="Fechar" variant="ghost" onClick={voice.dismiss} small>
              <X aria-hidden />
            </RoundButton>
          ) : (
            <>
              {mute}
              {hangUp}
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center px-4 pb-4 pt-5">
          <div className="absolute right-2 top-2">
            <RoundButton label="Minimizar" variant="ghost" onClick={() => setMin(true)} small>
              <Minimize2 aria-hidden />
            </RoundButton>
          </div>
          <VoiceOrb state={voice.state} levelRef={voice.levelRef} size={bp === 'phone' ? 164 : 184} />
          <p
            className={cn(
              'mt-3 max-w-[90%] text-center text-[15px] font-medium',
              voice.state === 'error' && 'text-negative',
            )}
            aria-live="polite"
            data-testid="voice-status"
          >
            {status}
          </p>
          <p className="mt-0.5 h-4 text-[12px] tabular-nums text-muted-foreground">{live ? timer : ''}</p>
          <div className="mt-3 flex items-center gap-4">
            {voice.state === 'error' ? (
              <>
                <Button type="button" variant="secondary" onClick={() => void voice.start()}>
                  <RotateCcw aria-hidden /> Tentar de novo
                </Button>
                <Button type="button" variant="ghost" onClick={voice.dismiss}>
                  Fechar
                </Button>
              </>
            ) : (
              <>
                {mute}
                {hangUp}
              </>
            )}
          </div>
          {voice.state !== 'error' ? (
            <p className="mt-3 text-center text-[11.5px] text-muted-foreground">
              Tudo o que for dito aparece no chat. Prévias só são gravadas com o seu “sim” ou no botão Confirmar.
            </p>
          ) : null}
        </div>
      )}
    </motion.section>
  );
}
