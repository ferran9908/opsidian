import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import {
  arrange,
  MIN_PANE,
  panes,
  type Direction,
  type Gutter,
  type Layout,
  type PaneState,
} from './panes';
import { cn } from '@/lib/utils';

interface Props {
  layout: Layout;
  renderPane(pane: PaneState, index: number): ReactNode;
  /** Moves a boundary to `fraction` of its split; `min` is the least each side keeps. */
  onResize(split: string, index: number, fraction: number, min: number): void;
}

const percent = (fraction: number) => `${fraction * 100}%`;

/**
 * Draws the panes. Every pane is a child of one box, placed by the layout, rather than nested
 * in a box per split: a split then moves a pane without remounting it, and its editor keeps its
 * text, history and unsaved edits.
 */
export function SplitView({ layout, renderPane, onResize }: Props) {
  const area = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<Direction | null>(null);
  const { panes: placed, gutters } = arrange(layout);
  const byId = new Map(panes(layout).map((pane) => [pane.id, pane]));

  useEffect(() => {
    if (!dragging) return;
    // Dragging past a note would otherwise select its text.
    document.body.classList.add('select-none');
    return () => document.body.classList.remove('select-none');
  }, [dragging]);

  const move = (gutter: Gutter, event: PointerEvent<HTMLDivElement>) => {
    if (!area.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const box = area.current.getBoundingClientRect();
    const row = gutter.direction === 'row';
    const start = row ? box.left + gutter.area.x * box.width : box.top + gutter.area.y * box.height;
    const length = row ? gutter.area.w * box.width : gutter.area.h * box.height;
    if (length <= 0) return;
    const at = (row ? event.clientX : event.clientY) - start;
    onResize(gutter.split, gutter.index, at / length, MIN_PANE[gutter.direction] / length);
  };

  return (
    <div
      ref={area}
      className={cn(
        'relative min-h-0 min-w-0 flex-1',
        dragging && 'select-none',
        dragging === 'row' && 'cursor-col-resize',
        dragging === 'column' && 'cursor-row-resize',
      )}
    >
      {placed.map(({ id, rect }, index) => (
        <div
          key={id}
          className="absolute flex min-h-0 min-w-0 flex-col"
          style={{
            left: percent(rect.x),
            top: percent(rect.y),
            width: percent(rect.w),
            height: percent(rect.h),
          }}
        >
          {renderPane(byId.get(id)!, index)}
        </div>
      ))}
      {gutters.map((gutter) => {
        const row = gutter.direction === 'row';
        const { area: split, at } = gutter;
        return (
          <div
            key={`${gutter.split}:${gutter.index}`}
            role="separator"
            aria-orientation={row ? 'vertical' : 'horizontal'}
            className={cn(
              'no-drag absolute z-10 flex justify-center',
              row
                ? 'w-1.5 -translate-x-1/2 cursor-col-resize'
                : 'h-1.5 -translate-y-1/2 cursor-row-resize flex-col',
            )}
            style={
              row
                ? {
                    left: percent(split.x + at * split.w),
                    top: percent(split.y),
                    height: percent(split.h),
                  }
                : {
                    top: percent(split.y + at * split.h),
                    left: percent(split.x),
                    width: percent(split.w),
                  }
            }
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(gutter.direction);
            }}
            onPointerMove={(event) => move(gutter, event)}
            onPointerUp={() => setDragging(null)}
            onLostPointerCapture={() => setDragging(null)}
          >
            <div className={cn('bg-border', row ? 'h-full w-px' : 'h-px w-full')} />
          </div>
        );
      })}
    </div>
  );
}
