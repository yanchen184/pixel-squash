import { useEffect, useState } from 'react';

/**
 * Whether the viewport is currently portrait (taller than wide). The game is a
 * fixed 16:9 LANDSCAPE court, so on a phone held upright the canvas would shrink
 * to a useless sliver — we use this to show a "rotate your phone" gate instead.
 *
 * Coarse-pointer + portrait is the trigger: a desktop browser window that happens
 * to be narrow (devtools, split-screen) should NOT get the rotate prompt, only an
 * actual touch device. Wide enough always passes regardless of pointer type.
 */
export function useIsPortraitPhone(): boolean {
  const [portrait, setPortrait] = useState(() => compute());

  useEffect(() => {
    const update = () => setPortrait(compute());
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return portrait;
}

function compute(): boolean {
  if (typeof window === 'undefined') return false;
  const isTouch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const isPortrait = window.innerHeight > window.innerWidth;
  // Only gate real touch devices held upright. A narrow desktop window plays fine.
  return isTouch && isPortrait;
}
