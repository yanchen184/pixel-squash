import { useEffect, useState } from 'react';
import { eventBus } from '@/game/eventBus';
import { POINTS_TO_WIN } from '@/data/gameState';

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
  const narrow = useNarrow();

  useEffect(() => {
    const offScore = eventBus.on('score:changed', ({ scores }) => setScores(scores));
    const offStam = eventBus.on('stamina:changed', setStamina);
    const offOver = eventBus.on('match:over', ({ winner }) => setWinner(winner));
    const offReset = eventBus.on('sim:reset', () => {
      setWinner(null);
      setScores([0, 0]);
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
          <span style={narrow ? s.scoreYouNarrow : s.scoreYou}>{scores[0]}</span>
          <span style={s.scoreDash}>–</span>
          <span style={narrow ? s.scoreCpuNarrow : s.scoreCpu}>{scores[1]}</span>
          <span style={s.scoreTo}>/{POINTS_TO_WIN}</span>
        </div>

        <PlayerLabel name="CPU" score={scores[1]} stamina={stamina.p2} side="right" narrow={narrow} />
      </div>

      {/* Bottom: subtle score-dot progress */}
      <div style={s.progressWrap}>
        <MatchDots scores={scores} />
      </div>

      {/* Exit button — sits independently above the CPU card */}
      <button style={s.exitBtn} onClick={onExit}>✕</button>

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
      {/* Stamina bar */}
      <div style={{ ...trackStyle, direction: isLeft ? 'ltr' : 'rtl' }}>
        <div
          style={{
            ...s.staminaFill,
            width: `${stamina}%`,
            background: staminaColor,
            boxShadow: `0 0 6px ${staminaColor}88`,
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

  /* ── exit button — anchored top-right, independent of topBar ── */
  exitBtn: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 30,
    height: 30,
    background: 'rgba(10,14,22,0.78)',
    color: 'rgba(160,180,200,0.55)',
    border: '1px solid rgba(80,110,130,0.28)',
    borderRadius: 6,
    cursor: 'pointer',
    pointerEvents: 'auto' as const,
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
};
