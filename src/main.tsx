import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { loadAssets } from './assets/assetLoader';

// Kick off the court/player/audience image loads the moment the app boots — while
// the player is still on the menu. loadAssets() is an idempotent singleton, so the
// renderer's own loadAssets() call later just awaits this same in-flight promise.
// Without this preload the first frame after entering a match drew the procedural
// greybox (bare court lines) because the PNGs hadn't decoded yet, then snapped to
// the real art a beat later ("一進去沒換背景，過一會才變圖").
loadAssets();

// No StrictMode: it double-mounts effects, which would boot two CanvasRenderer
// instances (each with its own RAF loop + keyboard listener) over one canvas. The
// renderer owns an imperative loop, so a single deterministic mount is correct.
createRoot(document.getElementById('root')!).render(<App />);
