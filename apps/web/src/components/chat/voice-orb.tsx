import { useEffect, useId, useRef, type MutableRefObject } from 'react';
import { cn } from '@/lib/utils';
import type { VoiceState } from './use-voice-session';

// Serrilha da borda da moeda: traços radiais pré-calculados
const REEDS = Array.from({ length: 72 }, (_, i) => {
  const a = (i / 72) * Math.PI * 2;
  const p = (r: number) => `${(100 + Math.cos(a) * r).toFixed(2)} ${(100 + Math.sin(a) * r).toFixed(2)}`;
  return `M${p(83)}L${p(90)}`;
}).join('');

// Colunas do mini gráfico (crescente) que pulsa com a voz do assistente
const BARS = [
  { x: 70, h: 16, k: 0.55 },
  { x: 84, h: 22, k: 0.9 },
  { x: 98, h: 28, k: 0.7 },
  { x: 112, h: 34, k: 1 },
  { x: 126, h: 40, k: 0.8 },
];

/**
 * Orbe da conversa por voz: uma moeda de real que reage ao áudio.
 * Ouvindo → ondas como moeda caindo na água; falando → colunas de um gráfico crescendo;
 * consultando → a moeda gira e moedinhas orbitam; conectando → respira.
 * O nível do áudio (0..1) chega por ref e vira a variável CSS --lvl, sem re-renderizar.
 */
export function VoiceOrb({
  state,
  levelRef,
  size = 200,
  className,
}: {
  state: VoiceState;
  levelRef: MutableRefObject<number>;
  size?: number;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/:/g, '');

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      root.current?.style.setProperty('--lvl', levelRef.current.toFixed(3));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [levelRef]);

  const label: Record<VoiceState, string> = {
    idle: 'Conversa por voz parada',
    connecting: 'Conectando',
    listening: 'Ouvindo',
    thinking: 'Consultando',
    speaking: 'Falando',
    error: 'Erro na conversa por voz',
  };

  return (
    <div
      ref={root}
      className={cn('voice-orb relative grid shrink-0 place-items-center', className)}
      style={{ width: size, height: size }}
      data-state={state}
      data-testid="voice-orb"
      role="img"
      aria-label={label[state]}
    >
      {/* brilho dourado ao fundo, proporcional ao volume */}
      <div className="voice-orb-glow absolute inset-[-12%] rounded-full" aria-hidden />

      {/* ondas (ouvindo) */}
      <div className="voice-orb-ripples absolute inset-0" aria-hidden>
        <span />
        <span />
        <span />
      </div>

      {/* moedinhas orbitando (consultando) */}
      <div className="voice-orb-orbit absolute inset-[-6%]" aria-hidden>
        <i />
        <i />
        <i />
      </div>

      <div className="voice-orb-coin relative size-[78%]">
        <svg viewBox="0 0 200 200" className="size-full overflow-visible" aria-hidden>
          <defs>
            <radialGradient id={`face-${uid}`} cx="38%" cy="32%" r="75%">
              <stop offset="0%" stopColor="var(--coin-1)" />
              <stop offset="55%" stopColor="var(--coin-2)" />
              <stop offset="100%" stopColor="var(--coin-3)" />
            </radialGradient>
            <linearGradient id={`rim-${uid}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--coin-1)" />
              <stop offset="50%" stopColor="var(--coin-3)" />
              <stop offset="100%" stopColor="var(--coin-2)" />
            </linearGradient>
            <linearGradient id={`shine-${uid}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#fff" stopOpacity="0" />
              <stop offset="50%" stopColor="#fff" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
            <clipPath id={`clip-${uid}`}>
              <circle cx="100" cy="100" r="90" />
            </clipPath>
          </defs>

          <circle cx="100" cy="100" r="94" fill={`url(#rim-${uid})`} />
          <circle cx="100" cy="100" r="90" fill={`url(#face-${uid})`} />
          <path d={REEDS} stroke="var(--coin-3)" strokeOpacity="0.45" strokeWidth="1.6" />
          <circle cx="100" cy="100" r="74" fill="none" stroke="var(--coin-1)" strokeOpacity="0.7" strokeWidth="2" />
          <circle cx="100" cy="100" r="71" fill="none" stroke="var(--coin-3)" strokeOpacity="0.35" strokeWidth="1" />

          {/* R$ em relevo */}
          <g className="voice-orb-mark">
            <text
              x="100"
              y="104"
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="54"
              fontWeight="800"
              fontFamily="var(--font-sans)"
              fill="var(--coin-1)"
              opacity="0.9"
              transform="translate(-1.5 -1.5)"
            >
              R$
            </text>
            <text
              x="100"
              y="104"
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="54"
              fontWeight="800"
              fontFamily="var(--font-sans)"
              fill="var(--coin-ink)"
            >
              R$
            </text>
          </g>

          {/* gráfico de colunas (falando) */}
          <g className="voice-orb-bars">
            {BARS.map((b, i) => (
              <rect
                key={i}
                x={b.x - 5}
                y={150 - b.h}
                width="10"
                height={b.h}
                rx="2.5"
                fill="var(--coin-ink)"
                style={{ ['--k' as string]: b.k, transformOrigin: `${b.x}px 150px` }}
              />
            ))}
            <path d="M66 128 L84 120 L98 112 L112 104 L130 92" fill="none" stroke="var(--coin-1)" strokeWidth="2.5" strokeLinecap="round" />
          </g>

          {/* reflexo que atravessa a moeda (consultando) */}
          <g clipPath={`url(#clip-${uid})`}>
            <g transform="rotate(20 100 100)">
              <rect className="voice-orb-shine" x="-80" y="-20" width="60" height="240" fill={`url(#shine-${uid})`} />
            </g>
          </g>
        </svg>
      </div>
    </div>
  );
}
