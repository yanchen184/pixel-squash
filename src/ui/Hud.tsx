import { useEffect, useRef, useState } from 'react';
import { eventBus } from '@/game/eventBus';
import { SoundEngine } from '@/game/audio/SoundEngine';
import { POINTS_TO_WIN, WIN_BY } from '@/data/gameState';

/** Returns true when the viewport is narrower than 520px. */
function useNarrow(breakpoint = 520): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [breakpoint]);
  return narrow;
}

/**
 * HUD overlay floating above the canvas. Driven entirely by the event bus.
 * Visual language: dark graphite translucent panels, teal/amber/red accents,
 * thin glowing borders — matches the enclosed squash court art.
 */
export function Hud({ onExit, onRestart }: { onExit: () => void; onRestart: () => void }) {
  const [scores, setScores] = useState<[number, number]>([0, 0]);
  const [stamina, setStamina] = useState({ p1: 100, p2: 100 });
  const [winner, setWinner] = useState<0 | 1 | null>(null);
  const [scoredSide, setScoredSide] = useState<0 | 1 | null>(null);
  const [muted, setMuted] = useState(false);
  const prevScoresRef = useRef<[number, number]>([0, 0]);
  const narrow = useNarrow();

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    SoundEngine.get().setEnabled(!next);
  };

  useEffect(() => {
    const offScore = eventBus.on('score:changed', ({ scores: newScores }) => {
      const prev = prevScoresRef.current;
      if (newScores[0] > prev[0]) setScoredSide(0);
      else if (newScores[1] > prev[1]) setScoredSide(1);
      prevScoresRef.current = newScores;
      setScores(newScores);
      // Clear flash after animation
      setTimeout(() => setScoredSide(null), 600);
    });
    const offStam = eventBus.on('stamina:changed', setStamina);
    const offOver = eventBus.on('match:over', ({ winner }) => setWinner(winner));
    const offReset = eventBus.on('sim:reset', () => {
      setWinner(null);
      setScores([0, 0]);
      prevScoresRef.current = [0, 0];
      setScoredSide(null);
    });
    return () => { offScore(); offStam(); offOver(); offReset(); };
  }, []);

  // On narrow screens the exit button (30px) + margin (10px*2) = 50px eats right side,
  // so topBar max-width is viewport - 52px; centre-aligned via left/transform.
  const topBarStyle: React.CSSProperties = narrow
    ? { ...s.topBar, maxWidth: 'calc(100vw - 52px)' }
    : s.topBar;

  return (
    <div style={s.overlay}>
      {/* Top bar: compact player cards flanking score strip */}
      <div style={topBarStyle}>
        <PlayerLabel name="YOU" score={scores[0]} stamina={stamina.p1} side="left" narrow={narrow} />

        <div style={narrow ? s.scoreStripNarrow : s.scoreStrip}>
          <span style={{
            ...(narrow ? s.scoreYouNarrow : s.scoreYou),
            ...(scoredSide === 0 ? s.scoreBounce : {}),
            color: scoredSide === 0 ? '#ffd060' : undefined,
          }}>{scores[0]}</span>
          <span style={s.scoreDash}>–</span>
          <span style={{
            ...(narrow ? s.scoreCpuNarrow : s.scoreCpu),
            ...(scoredSide === 1 ? s.scoreBounce : {}),
            color: scoredSide === 1 ? '#ffd060' : undefined,
          }}>{scores[1]}</span>
          {/* Deuce / advantage indicator */}
          {scores[0] >= POINTS_TO_WIN - 1 && scores[1] >= POINTS_TO_WIN - 1 && Math.abs(scores[0] - scores[1]) < WIN_BY && (
            <span style={s.deuceLabel}>
              {scores[0] === scores[1] ? 'DEUCE' : scores[0] > scores[1] ? 'ADV YOU' : 'ADV CPU'}
            </span>
          )}
          {!narrow && <span style={s.scoreTo}>/{POINTS_TO_WIN}</span>}
        </div>

        <PlayerLabel name="CPU" score={scores[1]} stamina={stamina.p2} side="right" narrow={narrow} />
      </div>

      {/* Bottom: subtle score-dot progress */}
      <div style={s.progressWrap}>
        <MatchDots scores={scores} />
      </div>

      {/* Exit + mute buttons — anchored top-right */}
      <div style={s.cornerBtns}>
        <button style={s.iconBtn} onClick={toggleMute} title={muted ? '開聲音' : '靜音'}>
          {muted ? '🔇' : '🔊'}
        </button>
        <button style={s.exitBtn} onClick={onExit}>✕</button>
      </div>

      {/* Match-over modal */}
      {winner !== null && (
        <div style={s.modal}>
          <div style={s.modalCard}>
            <div style={s.modalTitle}>{winner === 0 ? '你贏了' : '電腦獲勝'}</div>
            <div style={s.modalScore}>{scores[0]} — {scores[1]}</div>
            <div style={s.modalBtns}>
              <button style={s.btnPrimary} onClick={onRestart}>再來一局</button>
              <button style={s.btnGhost} onClick={onExit}>回主選單</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Render N dots per player (max POINTS_TO_WIN) showing how many points each has.
 * Teal dots on the left for YOU, red on the right for CPU — separated by a thin
 * centre gap so the two sides are instantly readable.
 */
function MatchDots({ scores }: { scores: [number, number] }) {
  const pts = POINTS_TO_WIN;
  const dots: React.ReactNode[] = [];
  for (let i = 0; i < pts; i++) {
    const filled = i < scores[0];
    dots.push(
      <div
        key={`p1-${i}`}
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: filled ? '#38c8a0' : 'rgba(56,200,160,0.15)',
          boxShadow: filled ? '0 0 4px rgba(56,200,160,0.7)' : 'none',
          transition: 'background 0.2s, box-shadow 0.2s',
        }}
      />,
    );
  }
  dots.push(<div key="sep" style={{ width: 10 }} />);
  for (let i = 0; i < pts; i++) {
    const filled = i < scores[1];
    dots.push(
      <div
        key={`p2-${i}`}
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: filled ? '#e04858' : 'rgba(224,72,88,0.15)',
          boxShadow: filled ? '0 0 4px rgba(224,72,88,0.7)' : 'none',
          transition: 'background 0.2s, box-shadow 0.2s',
        }}
      />,
    );
  }
  return <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{dots}</div>;
}

function PlayerLabel({
  name,
  score,
  stamina,
  side,
  narrow,
}: {
  name: string;
  score: number;
  stamina: number;
  side: 'left' | 'right';
  narrow: boolean;
}) {
  const isLeft = side === 'left';
  const lowStamina = stamina < 30;
  const criticalStamina = stamina < 10;
  const staminaColor = stamina > 50 ? '#38c8a0' : stamina > 25 ? '#e8a840' : '#e04848';
  const labelStyle = narrow ? s.playerLabelNarrow : s.playerLabel;
  const trackStyle = narrow ? s.staminaTrackNarrow : s.staminaTrack;

  return (
    <div style={{ ...labelStyle, flexDirection: isLeft ? 'row' : 'row-reverse' }}>
      <div style={s.playerNameWrap}>
        <span style={{ ...s.playerName, color: isLeft ? '#5ec8f0' : '#f07080' }}>{name}</span>
        {/* Score hidden on narrow — centre strip already shows it */}
        {!narrow && <span style={s.playerScore}>{score}</span>}
      </div>
      {/* Stamina bar — flashes when low */}
      <div style={{ ...trackStyle, direction: isLeft ? 'ltr' : 'rtl' }}>
        <div
          style={{
            ...s.staminaFill,
            width: `${stamina}%`,
            background: staminaColor,
            boxShadow: `0 0 6px ${staminaColor}88`,
            animation: criticalStamina ? 'staminaFlash 0.3s ease-in-out infinite' : lowStamina ? 'staminaFlash 0.6s ease-in-out infinite' : 'none',
          }}
        />
      </div>
    </div>
  );
}

/* ---- palette tokens ---- */
const PANEL = 'rgba(10,14,22,0.82)';
const BORDER_TEAL = '1px solid rgba(60,180,160,0.45)';
const GLOW_TEAL = '0 0 8px rgba(60,200,170,0.25), inset 0 1px 0 rgba(255,255,255,0.06)';

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  },

  /* ── top bar ── */
  topBar: {
    position: 'absolute',
    top: 10,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    height: 48,
  },

  /* left/right player cards — fixed compact width */
  playerLabel: {
    width: 'clamp(140px, 18vw, 230px)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: PANEL,
    border: BORDER_TEAL,
    borderRadius: 6,
    boxShadow: GLOW_TEAL,
    padding: '6px 10px',
    height: '100%',
    boxSizing: 'border-box' as const,
    overflow: 'hidden',
    backdropFilter: 'blur(6px)',
    flexShrink: 0,
  },
  /* narrow mobile variant — label only + short stamina bar */
  playerLabelNarrow: {
    width: 90,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: PANEL,
    border: BORDER_TEAL,
    borderRadius: 6,
    boxShadow: GLOW_TEAL,
    padding: '5px 7px',
    height: '100%',
    boxSizing: 'border-box' as const,
    overflow: 'hidden',
    backdropFilter: 'blur(6px)',
    flexShrink: 0,
  },
  playerNameWrap: {
    display: 'flex',
    flexDirection: 'column' as const,
    lineHeight: 1,
    flexShrink: 0,
  },
  playerName: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
  },
  playerScore: {
    fontSize: 18,
    fontWeight: 800,
    color: '#e8eaf4',
    marginTop: 1,
  },
  staminaTrack: {
    width: 'clamp(80px, 8vw, 140px)',
    height: 5,
    background: 'rgba(255,255,255,0.08)',
    borderRadius: 3,
    overflow: 'hidden',
    flexShrink: 0,
  },
  staminaTrackNarrow: {
    width: 44,
    height: 4,
    background: 'rgba(255,255,255,0.08)',
    borderRadius: 2,
    overflow: 'hidden',
    flexShrink: 0,
  },
  staminaFill: {
    height: '100%',
    borderRadius: 3,
    transition: 'width 0.12s linear, background 0.4s ease',
  },

  /* centre score strip */
  scoreStrip: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    background: PANEL,
    border: BORDER_TEAL,
    borderRadius: 6,
    boxShadow: GLOW_TEAL,
    padding: '4px 16px',
    flexShrink: 0,
    height: '100%',
    boxSizing: 'border-box',
    alignSelf: 'stretch' as const,
    backdropFilter: 'blur(6px)',
  },
  scoreYou: {
    fontSize: 26,
    fontWeight: 900,
    color: '#5ec8f0',
    letterSpacing: '-0.02em',
    textShadow: '0 0 12px rgba(94,200,240,0.6)',
  },
  scoreDash: {
    fontSize: 16,
    fontWeight: 300,
    color: 'rgba(200,220,230,0.3)',
    margin: '0 3px',
    letterSpacing: '0.08em',
  },
  scoreCpu: {
    fontSize: 26,
    fontWeight: 900,
    color: '#f07080',
    letterSpacing: '-0.02em',
    textShadow: '0 0 12px rgba(240,112,128,0.6)',
  },
  scoreTo: { fontSize: 10, color: 'rgba(180,190,210,0.35)', marginLeft: 3, letterSpacing: '0.05em' },

  /* narrow variants for score strip */
  scoreStripNarrow: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    background: PANEL,
    border: BORDER_TEAL,
    borderRadius: 6,
    boxShadow: GLOW_TEAL,
    padding: '4px 10px',
    flexShrink: 0,
    height: '100%',
    boxSizing: 'border-box' as const,
    alignSelf: 'stretch' as const,
    backdropFilter: 'blur(6px)',
  },
  scoreYouNarrow: {
    fontSize: 20,
    fontWeight: 900,
    color: '#5ec8f0',
    letterSpacing: '-0.02em',
    textShadow: '0 0 10px rgba(94,200,240,0.6)',
  },
  scoreCpuNarrow: {
    fontSize: 20,
    fontWeight: 900,
    color: '#f07080',
    letterSpacing: '-0.02em',
    textShadow: '0 0 10px rgba(240,112,128,0.6)',
  },

  /* ── match progress strip (bottom) ── */
  progressWrap: {
    position: 'absolute',
    bottom: 14,
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(8,12,20,0.62)',
    borderRadius: 8,
    border: '1px solid rgba(60,180,160,0.18)',
    padding: '5px 10px',
    backdropFilter: 'blur(4px)',
  },

  /* ── exit + mute buttons — top-right cluster ── */
  cornerBtns: {
    position: 'absolute',
    top: 10,
    right: 10,
    display: 'flex',
    gap: 6,
    pointerEvents: 'auto' as const,
  },
  iconBtn: {
    width: 30,
    height: 30,
    background: 'rgba(10,14,22,0.78)',
    color: 'rgba(200,215,230,0.8)',
    border: '1px solid rgba(80,110,130,0.28)',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backdropFilter: 'blur(4px)',
  },
  exitBtn: {
    width: 30,
    height: 30,
    background: 'rgba(10,14,22,0.78)',
    color: 'rgba(160,180,200,0.55)',
    border: '1px solid rgba(80,110,130,0.28)',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 11,
    letterSpacing: '0.05em',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backdropFilter: 'blur(4px)',
    transition: 'color 0.2s, border-color 0.2s',
  },

  /* ── match-over modal ── */
  modal: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'auto',
    backdropFilter: 'blur(3px)',
  },
  modalCard: {
    background: 'rgba(12,16,26,0.96)',
    padding: '32px 44px',
    borderRadius: 10,
    textAlign: 'center',
    border: '1px solid rgba(60,180,160,0.5)',
    boxShadow: '0 0 40px rgba(60,200,170,0.15), 0 8px 32px rgba(0,0,0,0.6)',
  },
  modalTitle: {
    fontSize: 26,
    fontWeight: 800,
    color: '#e8eaf4',
    letterSpacing: '0.02em',
  },
  modalScore: {
    fontSize: 22,
    color: 'rgba(200,215,230,0.7)',
    margin: '10px 0 22px',
    fontWeight: 700,
  },
  modalBtns: { display: 'flex', gap: 10, justifyContent: 'center' },
  btnPrimary: {
    padding: '10px 22px',
    fontSize: 15,
    fontWeight: 700,
    background: 'rgba(40,160,120,0.9)',
    color: '#d0f0e8',
    border: '1px solid rgba(60,200,160,0.5)',
    borderRadius: 6,
    cursor: 'pointer',
  },
  btnGhost: {
    padding: '10px 22px',
    fontSize: 15,
    background: 'transparent',
    color: 'rgba(180,190,210,0.7)',
    border: '1px solid rgba(100,120,150,0.4)',
    borderRadius: 6,
    cursor: 'pointer',
  },

  /* Score bounce animation — applied when a point is scored (task #31) */
  scoreBounce: {
    display: 'inline-block',
    animation: 'scoreBounce 0.5s cubic-bezier(0.36, 0.07, 0.19, 0.97)',
    transition: 'color 0.3s ease',
  },

  /* Deuce / advantage indicator */
  deuceLabel: {
    fontSize: 9,
    fontWeight: 700,
    color: '#ffd060',
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    textShadow: '0 0 8px rgba(255,200,60,0.8)',
    marginLeft: 6,
    alignSelf: 'center' as const,
  },
};

// CSS keyframe animations injected once.
if (typeof document !== 'undefined' && !document.getElementById('hud-keyframes')) {
  const style = document.createElement('style');
  style.id = 'hud-keyframes';
  style.textContent = `
    @keyframes scoreBounce {
      0%   { transform: scale(1); }
      30%  { transform: scale(1.5); }
      50%  { transform: scale(0.92); }
      70%  { transform: scale(1.12); }
      100% { transform: scale(1); }
    }
    @keyframes staminaFlash {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
  `;
  document.head.appendChild(style);
}
