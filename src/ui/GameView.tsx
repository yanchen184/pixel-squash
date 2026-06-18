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
    // Establish a query container so the canvas can size itself against THIS box's
    // dimensions (cqw/cqh) rather than the viewport — the container may not fill the
    // whole screen.
    containerType: 'size',
  },
  canvas: {
    // Letterbox-fit the fixed 16:9 canvas into the container WITHOUT distorting the
    // element box (so the Controls/Hud overlay stays pixel-aligned with the drawn
    // court — object-fit:contain would keep the bitmap square but leave the box
    // filling the container, breaking touch-coordinate mapping).
    //
    // The trick: never pin BOTH width and height to 100%. Let each dimension cap at
    // the container (max-*:100%) and let aspect-ratio derive the other. The flex
    // parent centers the result. This holds the true 16:9 box in landscape,
    // portrait, and near-square windows alike — the old `width:auto + height:100% +
    // maxWidth:100%` clamped width without shrinking height, squashing toward square.
    // Pick the limiting dimension against the CONTAINER (cqw/cqh), not the viewport:
    // width = min(full container width, the width a full-height 16:9 box would need).
    // aspect-ratio then derives the height, so the box is always exactly 16:9 and
    // letterboxes correctly in landscape, portrait, and near-square containers.
    width: `min(100cqw, calc(100cqh * ${GAME_WIDTH} / ${GAME_HEIGHT}))`,
    aspectRatio: `${GAME_WIDTH} / ${GAME_HEIGHT}`,
    imageRendering: 'pixelated',
    display: 'block',
  },
};
