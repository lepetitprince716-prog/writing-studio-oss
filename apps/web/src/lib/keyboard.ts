/** Keyboard activation for non-button clickable elements (Enter / Space). */

import type { KeyboardEvent } from 'react';

export function onActivateKey(handler: () => void) {
  return (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler();
    }
  };
}
