import { useEffect, useState } from 'react';
import { eventBus } from '@/game/eventBus';
import { POINTS_TO_WIN } from '@/data/gameState';

/**
 * HUD overlay floating above the Phaser canvas. Driven entirely by the event bus
 * (the Phase-2 seam) — it never reads game internals directly.
 */
export function Hud({ onExit, onRestart }: { onExit: () => void; onRestart: () => void }) {
  const [scores, setScores] = useState<[number, number]>([0, 0]);
  const [stamina, setStamina] = useState({ p1: 100, p2: 100 });
  const [winner, setWinner] = useState<0 | 1 | null>(null);

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

  return (
    <div style={styles.overlay}>
      {/* Top-left player card (avatar + name + LV) like the Kairo target's "Dora LV1".
          Pure CSS chibi face so it needs no extra asset; the LV pip row fills as the
          player scores, giving a light progression read. */}
      <div style={styles.playerCard}>
        <div style={styles.avatar}>
          <div style={styles.avatarHair} />
          <div style={styles.avatarFace}>
            <span style={{ ...styles.eye, left: 8 }} />
            <span style={{ ...styles.eye, left: 18 }} />
          </div>
        </div>
        <div style={styles.cardText}>
          <span style={styles.cardName}>YOU</span>
          <span style={styles.cardLv}>LV {1 + scores[0]}</span>
        </div>
      </div>

      <div style={styles.scoreboard}>
        <span style={styles.you}>你 {scores[0]}</span>
        <span style={styles.sep}>—</span>
        <span style={styles.cpu}>{scores[1]} 電腦</span>
        <span style={styles.target}>(先到 {POINTS_TO_WIN} 分)</span>
      </div>

      <div style={styles.staminaRow}>
        <StaminaBar value={stamina.p1} color="#4a9ad0" align="left" />
        <StaminaBar value={stamina.p2} color="#d04a6a" align="right" />
      </div>

      {/* EXP / match-progress bar pinned bottom-centre, like the Kairo target. Fills
          as points are played; reaching 100% means someone has hit match point. */}
      <div style={styles.expRow}>
        <span style={styles.expLabel}>EXP</span>
        <div style={styles.expOuter}>
          <div style={{ ...styles.expInner, width: `${matchProgress(scores)}%` }} />
        </div>
      </div>

      {winner !== null && (
        <div style={styles.modal}>
          <div style={styles.modalCard}>
            <h1 style={{ margin: 0 }}>{winner === 0 ? '🏆 你贏了！' : '電腦獲勝'}</h1>
            <p style={styles.finalScore}>{scores[0]} — {scores[1]}</p>
            <div style={styles.modalBtns}>
              <button style={styles.btnPrimary} onClick={onRestart}>再來一局</button>
              <button style={styles.btnGhost} onClick={onExit}>回主選單</button>
            </div>
          </div>
        </div>
      )}

      <button style={styles.exitBtn} onClick={onExit}>✕</button>
    </div>
  );
}

/** Match-progress fill: the leader's points as a fraction of the points-to-win. */
function matchProgress(scores: [number, number]): number {
  const lead = Math.max(scores[0], scores[1]);
  return Math.min(100, Math.round((lead / POINTS_TO_WIN) * 100));
}

function StaminaBar({ value, color, align }: { value: number; color: string; align: 'left' | 'right' }) {
  return (
    <div style={{ ...styles.barOuter, justifyContent: align === 'left' ? 'flex-start' : 'flex-end' }}>
      <div style={{ ...styles.barInner, width: `${value}%`, background: color }} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'absolute', inset: 0, pointerEvents: 'none', fontFamily: 'system-ui' },
  playerCard: { position: 'absolute', top: 14, left: 14, display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(16,18,30,0.85)', padding: '6px 12px 6px 6px', borderRadius: 10, border: '2px solid #5a6aa0' },
  avatar: { position: 'relative', width: 34, height: 34, borderRadius: 8, background: '#2a3552', overflow: 'hidden', flexShrink: 0 },
  avatarHair: { position: 'absolute', top: 4, left: 5, right: 5, height: 9, background: '#4a3324', borderRadius: '6px 6px 0 0' },
  avatarFace: { position: 'absolute', top: 12, left: 7, right: 7, height: 16, background: '#e8b98a', borderRadius: '0 0 6px 6px' },
  eye: { position: 'absolute', top: 4, width: 3, height: 4, background: '#3a2a26', borderRadius: 1 },
  cardText: { display: 'flex', flexDirection: 'column', lineHeight: 1.15 },
  cardName: { fontSize: 13, fontWeight: 700, color: '#e8eaf4' },
  cardLv: { fontSize: 11, fontWeight: 700, color: '#ffd86a' },
  scoreboard: { position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(16,18,30,0.85)', padding: '8px 22px', borderRadius: 10, border: '2px solid #5a6aa0', fontSize: 22, fontWeight: 700 },
  you: { color: '#7fc0ff' },
  cpu: { color: '#ff8fa3' },
  sep: { color: '#888' },
  target: { fontSize: 12, color: '#999', fontWeight: 400 },
  staminaRow: { position: 'absolute', top: 64, left: 0, right: 0, display: 'flex', justifyContent: 'space-between', padding: '0 24px' },
  barOuter: { width: 200, height: 10, background: 'rgba(0,0,0,0.4)', borderRadius: 5, display: 'flex', overflow: 'hidden' },
  barInner: { height: '100%', transition: 'width 0.1s linear' },
  expRow: { position: 'absolute', bottom: 18, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 8, width: '46%', maxWidth: 560 },
  expLabel: { fontSize: 12, fontWeight: 700, color: '#ffe27a', letterSpacing: 1, textShadow: '0 1px 2px rgba(0,0,0,0.8)' },
  expOuter: { flex: 1, height: 12, background: 'rgba(8,10,18,0.8)', borderRadius: 6, border: '2px solid #2a3046', overflow: 'hidden' },
  expInner: { height: '100%', background: 'linear-gradient(90deg, #3ad06a, #8bf0a0)', transition: 'width 0.3s ease', boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.3)' },
  modal: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto' },
  modalCard: { background: '#1c1c30', padding: 40, borderRadius: 16, textAlign: 'center', border: '2px solid #4a6ad0' },
  finalScore: { fontSize: 28, color: '#ddd', margin: '12px 0 24px' },
  modalBtns: { display: 'flex', gap: 12, justifyContent: 'center' },
  btnPrimary: { padding: '12px 24px', fontSize: 16, fontWeight: 700, background: '#36c06a', color: '#06210f', border: 'none', borderRadius: 8, cursor: 'pointer' },
  btnGhost: { padding: '12px 24px', fontSize: 16, background: 'transparent', color: '#ccc', border: '1px solid #555', borderRadius: 8, cursor: 'pointer' },
  exitBtn: { position: 'absolute', top: 14, right: 14, width: 36, height: 36, background: 'rgba(16,18,30,0.85)', color: '#ccc', border: '1px solid #555', borderRadius: 8, cursor: 'pointer', pointerEvents: 'auto', fontSize: 16 },
};
