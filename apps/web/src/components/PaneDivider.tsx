/**
 * Draggable vertical divider that resizes an adjacent pane. `side` is the pane
 * being resized relative to the divider: a left divider grows the left pane as
 * the pointer moves right; a right divider grows the right pane as it moves
 * left. Arrow keys nudge by a step for keyboard access.
 */

import { useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

const KEY_STEP = 16;

interface PaneDividerProps {
  side: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  onResize(width: number): void;
  onActive?(active: boolean): void;
}

export function PaneDivider({ side, width, min, max, onResize, onActive }: PaneDividerProps): React.JSX.Element {
  const start = useRef<{ x: number; width: number } | null>(null);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width };
    onActive?.(true);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!start.current) return;
    const delta = e.clientX - start.current.x;
    const next = side === 'left' ? start.current.width + delta : start.current.width - delta;
    onResize(next);
  }

  function endDrag(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!start.current) return;
    start.current = null;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    onActive?.(false);
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key === grow) onResize(width + KEY_STEP);
    else if (e.key === shrink) onResize(width - KEY_STEP);
    else return;
    e.preventDefault();
  }

  return (
    <div
      className="pane-divider"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="拖动调整宽度"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      <span className="pane-divider-hit" />
    </div>
  );
}
