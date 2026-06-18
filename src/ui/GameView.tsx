import { useEffect, useRef } from 'react';
import { CanvasRenderer, GAME_WIDTH, GAME_HEIGHT } from '@/game/render/CanvasRenderer';
import { PracticeRenderer } from '@/game/render/PracticeRenderer';
import type { Difficulty } from '@/game/input/AIInput';
import type { GameMode } from '@/data/gameState';
import { Hud } from './Hud';
import { Controls, disposeControls } from './Controls';

/** Match config for the greybox renderer (no court art manifest anymore). */
export type MatchConfig = { difficulty: Difficulty; gameMode?: GameMode };

/**
 * Mounts the GREYBOX Canvas 2D renderer (Phaser removed). A single fixed-size
 * 1280×720 canvas is letterboxed to fit its container; the renderer owns the 60Hz
 * sim loop and draws geometry. The HUD + on-screen controls overlay on top, talking
 * to the sim only through the event bus / touch singleton — unchanged by the swap.
 */
export function GameView({ config, onExit }: { config: MatchConfig; onExit: () => void }) {
  type AnyRenderer = { start(): void; stop(): void; restart(): void };
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<AnyRenderer | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const isPractice = config.gameMode === 'practice';
    const renderer = isPractice
      ? new PracticeRenderer(canvasRef.current)
      : new CanvasRenderer(canvasRef.current, config);
    rendererRef.current = renderer;
    renderer.start();
    if (import.meta.env.DEV) {
      (window as unknown as { __renderer: typeof renderer }).__renderer = renderer;
      // E2E seam: match renderer exposes a sim debug API (read state / swap AI /
      // reset) under a stable handle. Practice mode has no such hook (smoke test
      // verifies it via canvas pixels + DOM instead).
      const debug = (renderer as { debug?: () => unknown }).debug?.();
      if (debug) (window as unknown as { __squash: unknown }).__squash = debug;
    }
    return () => {
      renderer.stop();
      rendererRef.current = null;
      disposeControls();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restart = () => rendererRef.current?.restart();

  return (
    <div style={styles.root}>
      <canvas ref={canvasRef} width={GAME_WIDTH} height={GAME_HEIGHT} style={styles.canvas} />
      <Controls />
      <Hud onExit={onExit} onRestart={restart} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'relative',
    width: '100%',
    height: '100%',
    background: '#0a0c14',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  canvas: {
    // Letterbox-fit the fixed 16:9 canvas into the container.
    maxWidth: '100%',
    maxHeight: '100%',
    width: 'auto',
    height: '100%',
    aspectRatio: `${GAME_WIDTH} / ${GAME_HEIGHT}`,
    imageRendering: 'pixelated',
    display: 'block',
  },
};
