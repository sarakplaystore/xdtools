/** Small layout helpers that need the browser rather than CSS: the on-screen keyboard, safe areas. */
import { useEffect, useState } from 'react';

/**
 * The height the page can actually be seen in, in CSS pixels.
 *
 * On a phone with the keyboard open this is much smaller than `window.innerHeight`, and it changes
 * while a field is focused. Where `visualViewport` is missing the layout viewport is the best
 * available answer, so the two are the same on desktop and older browsers.
 */
function visibleHeight(): number {
  const vv = window.visualViewport;
  return Math.round(vv ? vv.height : window.innerHeight);
}

export function useViewportHeight(): number {
  const [height, setHeight] = useState(() => (typeof window === 'undefined' ? 0 : visibleHeight()));
  useEffect(() => {
    const update = () => setHeight(visibleHeight());
    // `resize` covers the keyboard opening and closing; `scroll` covers iOS moving the page up
    // under a focused field (the visual viewport's offset changes without a resize).
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    update();
    return () => {
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
  return height;
}
