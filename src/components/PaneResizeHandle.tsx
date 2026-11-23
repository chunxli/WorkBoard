"use client";

import { useRef, useState, type ReactNode } from "react";

type ResizeMotion = { value: number; move(deltaX: number): number };

export default function PaneResizeHandle({
  className, controls, label, title = "Drag to resize. Double-click to reset.", value, min, max, resetValue,
  formatValue, measure, keyboard, preview, commit, children,
}: {
  className: string;
  controls: string;
  label: string;
  title?: string;
  value: number;
  min: number;
  max: number;
  resetValue: number;
  formatValue(value: number): string;
  measure(handle: HTMLDivElement): ResizeMotion | null;
  keyboard(value: number, key: string): number | null;
  preview(value: number | null): void;
  commit(value: number): void;
  children?: ReactNode;
}) {
  const [previewValue, setPreviewValue] = useState<number | null>(null);
  const drag = useRef<{ pointerId: number; x: number; motion: ResizeMotion } | null>(null);

  function finish(handle: HTMLDivElement, pointerId: number, next: number | null) {
    if (drag.current?.pointerId !== pointerId) return;
    drag.current = null;
    setPreviewValue(null);
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    if (next === null) preview(null);
    else commit(next);
  }

  return <div
    className={className}
    data-dragging={previewValue !== null || undefined}
    role="separator"
    tabIndex={0}
    aria-label={label}
    aria-controls={controls}
    aria-orientation="vertical"
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={previewValue ?? value}
    aria-valuetext={formatValue(previewValue ?? value)}
    title={title}
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0 || drag.current) return;
      const motion = measure(event.currentTarget);
      if (!motion) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, x: event.clientX, motion };
      setPreviewValue(motion.value);
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      if (start?.pointerId !== event.pointerId) return;
      const next = start.motion.move(event.clientX - start.x);
      setPreviewValue(next);
      preview(next);
    }}
    onPointerUp={(event) => {
      const start = drag.current;
      if (start?.pointerId !== event.pointerId) return;
      const next = start.motion.move(event.clientX - start.x);
      finish(event.currentTarget, event.pointerId, next === start.motion.value ? null : next);
    }}
    onPointerCancel={(event) => finish(event.currentTarget, event.pointerId, null)}
    onLostPointerCapture={(event) => finish(event.currentTarget, event.pointerId, null)}
    onDoubleClick={() => commit(resetValue)}
    onKeyDown={(event) => {
      if (drag.current) {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(event.currentTarget, drag.current.pointerId, null);
        }
        return;
      }
      const current = measure(event.currentTarget);
      const next = current && keyboard(current.value, event.key);
      if (next === null) return;
      event.preventDefault();
      commit(next);
    }}
  >{children}</div>;
}
