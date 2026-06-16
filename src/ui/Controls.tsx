import { useRef, useState, useCallback } from 'react';
import { setTouchMove, setTouchSwing, setTouchDive, resetTouchIntent } from '@/game/input/touchControls';
import type { StrokeId } from '@/data/strokes';

/**
 * On-screen Kairo-style controls overlaid on the match: a solid analog joystick
 * (bottom-left) and a 2×2 cluster of stroke buttons (bottom-right) — one per shot
 * (殺/吊/抽/高遠), mirroring the J/K/L/Space keys. Pointer events drive the shared
 * touchControls singleton, which LocalInput merges with the keyboard — so mouse/touch
 * and keys both work.
 *
 * Pure presentational + pointer wiring; reads no game state.
 */
export function Controls() {
  // Touch-only: on a desktop (keyboard) the on-screen joystick/pad is just clutter
  // overlapping the court. matchMedia(coarse) is the standard touch test. SSR-safe.
  const isTouch =
    typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches ?? false);
  if (!isTouch) return null;
  return (
    <>
      <Joystick />
      <DiveButton />
      <StrokePad />
    </>
  );
}

/**
 * Capture the pointer so a drag/hold that leaves the element still reports
 * move/up to it. Some browsers throw NotFoundError if the pointer is already
 * gone — swallow it; capture is a nicety, never a gate on registering input.
 */
function capturePointer(e: React.PointerEvent): void {
  try {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  } catch {
    /* capture unavailable — input still registered by the caller */
  }
}

const STICK_R = 58; // outer ring radius (px)
const KNOB_R = 26; // knob radius (px)
const MAX = STICK_R - KNOB_R; // knob travel

function Joystick() {
  const baseRef = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const activeId = useRef<number | null>(null);

  const move = useCallback((clientX: number, clientY: number) => {
    const base = baseRef.current;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > MAX) {
      dx = (dx / dist) * MAX;
      dy = (dy / dist) * MAX;
    }
    setKnob({ x: dx, y: dy });
    setTouchMove(dy / MAX, dx / MAX); // vert, horiz in [-1,1]
  }, []);

  const onDown = (e: React.PointerEvent) => {
    activeId.current = e.pointerId;
    capturePointer(e);
    move(e.clientX, e.clientY);
  };
  const onMove = (e: React.PointerEvent) => {
    if (activeId.current !== e.pointerId) return;
    move(e.clientX, e.clientY);
  };
  const onUp = (e: React.PointerEvent) => {
    if (activeId.current !== e.pointerId) return;
    activeId.current = null;
    setKnob({ x: 0, y: 0 });
    setTouchMove(0, 0);
  };

  return (
    <div
      ref={baseRef}
      style={styles.stickBase}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {/* 4 direction notches */}
      <span style={{ ...styles.notch, top: 8, left: '50%', transform: 'translateX(-50%)' }}>▲</span>
      <span style={{ ...styles.notch, bottom: 8, left: '50%', transform: 'translateX(-50%)' }}>▼</span>
      <span style={{ ...styles.notch, left: 8, top: '50%', transform: 'translateY(-50%)' }}>◀</span>
      <span style={{ ...styles.notch, right: 8, top: '50%', transform: 'translateY(-50%)' }}>▶</span>
      <div style={{ ...styles.knob, transform: `translate(${knob.x}px, ${knob.y}px)` }} />
    </div>
  );
}

/** The five squash strokes. Each button fires that shot (swing edge). */
const STROKE_BTNS: ReadonlyArray<{ id: StrokeId; label: string; sub: string; bg: string }> = [
  { id: 'kill', label: '殺', sub: 'J', bg: 'radial-gradient(circle at 50% 35%, #ffd3d3 0%, #ff8a8a 55%, #e04d4d 100%)' },
  { id: 'drop', label: '小', sub: 'K', bg: 'radial-gradient(circle at 50% 35%, #d8f3e0 0%, #8ce0a8 55%, #4daf6e 100%)' },
  { id: 'drive', label: '直', sub: 'L', bg: 'radial-gradient(circle at 50% 35%, #d3e6ff 0%, #8ab6ff 55%, #4d7fe0 100%)' },
  { id: 'boast', label: '角', sub: 'U', bg: 'radial-gradient(circle at 50% 35%, #f5e2c0 0%, #e6c084 55%, #c79338 100%)' },
  { id: 'lob', label: '高', sub: '空', bg: 'radial-gradient(circle at 50% 35%, #fff0f4 0%, #f6c7d6 55%, #e08aa6 100%)' },
];

/** A single stroke button: pressing it sets the swing intent + which stroke to play. */
function StrokeButton({ id, label, sub, bg }: { id: StrokeId; label: string; sub: string; bg: string }) {
  const [pressed, setPressed] = useState(false);
  const down = (e: React.PointerEvent) => {
    // Set intent FIRST: a flaky setPointerCapture must never swallow the swing.
    setPressed(true);
    setTouchSwing(true, id);
    capturePointer(e);
  };
  const up = () => {
    setPressed(false);
    setTouchSwing(false);
  };
  return (
    <button
      style={{ ...styles.strokeBtn, background: bg, transform: pressed ? 'scale(0.88)' : 'scale(1)' }}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={up}
      aria-label={label}
    >
      <span style={styles.strokeLabel}>{label}</span>
      <span style={styles.strokeSub}>{sub}</span>
    </button>
  );
}

function StrokePad() {
  return (
    <div style={styles.strokePad}>
      {STROKE_BTNS.map((b) => (
        <StrokeButton key={b.id} {...b} />
      ))}
    </div>
  );
}

/** Diving-save button (魚躍救球): a quick lunge with extended reach. Sits just
 * left of the swing button so a thumb can reach both. */
function DiveButton() {
  const [pressed, setPressed] = useState(false);
  const down = (e: React.PointerEvent) => {
    setPressed(true);
    setTouchDive(true);
    capturePointer(e);
  };
  const up = () => {
    setPressed(false);
    setTouchDive(false);
  };
  return (
    <button
      style={{ ...styles.diveBtn, transform: pressed ? 'scale(0.9)' : 'scale(1)' }}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={up}
      aria-label="飛撲"
    >
      🤸
    </button>
  );
}

// Cleanup on unmount so a held key/touch doesn't leak into the next match.
export function disposeControls() {
  resetTouchIntent();
}

const styles: Record<string, React.CSSProperties> = {
  stickBase: {
    position: 'absolute',
    left: 'calc(36px + env(safe-area-inset-left))',
    bottom: 'calc(40px + env(safe-area-inset-bottom))',
    width: STICK_R * 2,
    height: STICK_R * 2,
    borderRadius: '50%',
    background: 'radial-gradient(circle at 50% 38%, #5a6480 0%, #3a4258 70%, #2a3046 100%)',
    border: '3px solid #1c2236',
    boxShadow: '0 6px 16px rgba(0,0,0,0.5), inset 0 2px 6px rgba(255,255,255,0.15)',
    pointerEvents: 'auto',
    touchAction: 'none',
    cursor: 'grab',
  },
  knob: {
    position: 'absolute',
    left: STICK_R - KNOB_R,
    top: STICK_R - KNOB_R,
    width: KNOB_R * 2,
    height: KNOB_R * 2,
    borderRadius: '50%',
    background: 'radial-gradient(circle at 50% 35%, #e8edf7 0%, #aab4cc 60%, #7a85a3 100%)',
    border: '2px solid #2a3046',
    boxShadow: '0 3px 8px rgba(0,0,0,0.5)',
    pointerEvents: 'none',
  },
  notch: { position: 'absolute', color: 'rgba(220,228,245,0.55)', fontSize: 12, pointerEvents: 'none' },
  strokePad: {
    position: 'absolute',
    right: 'calc(32px + env(safe-area-inset-right))',
    bottom: 'calc(36px + env(safe-area-inset-bottom))',
    width: 132,
    height: 132,
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gridTemplateRows: '1fr 1fr',
    gap: 8,
    pointerEvents: 'auto',
    touchAction: 'none',
  },
  strokeBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    border: '3px solid #1c2236',
    boxShadow: '0 4px 12px rgba(0,0,0,0.45)',
    color: '#1c2236',
    cursor: 'pointer',
    transition: 'transform 0.06s',
    touchAction: 'none',
    lineHeight: 1,
  },
  strokeLabel: { fontSize: 24, fontWeight: 800 },
  strokeSub: { fontSize: 10, fontWeight: 700, opacity: 0.7 },
  diveBtn: {
    position: 'absolute',
    right: 'calc(180px + env(safe-area-inset-right))',
    bottom: 'calc(70px + env(safe-area-inset-bottom))',
    width: 62,
    height: 62,
    borderRadius: '50%',
    border: '3px solid #1c2236',
    background: 'radial-gradient(circle at 50% 35%, #eaf6ff 0%, #a9d8f6 55%, #5aa6e0 100%)',
    boxShadow: '0 4px 12px rgba(0,0,0,0.45)',
    fontSize: 28,
    cursor: 'pointer',
    transition: 'transform 0.06s',
    pointerEvents: 'auto',
    touchAction: 'none',
  },
};
