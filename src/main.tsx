import { createRoot } from 'react-dom/client';
import { App } from './ui/App';

// No StrictMode: it double-mounts effects, which would boot two CanvasRenderer
// instances (each with its own RAF loop + keyboard listener) over one canvas. The
// renderer owns an imperative loop, so a single deterministic mount is correct.
createRoot(document.getElementById('root')!).render(<App />);
