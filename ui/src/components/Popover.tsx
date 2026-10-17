import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Pos = { top: number; left: number };

/** A small panel under its trigger (the popover's parent element). It renders
 *  on top of the page, so scrolling tables and boards never clip it, and
 *  closes on outside click or Escape. */
export function Popover({ open, onClose, children, align = "left", className = "" }: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const marker = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const anchor = marker.current?.parentElement;
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const width = panel.current?.offsetWidth ?? 0;
      const height = panel.current?.offsetHeight ?? 0;
      let left = align === "right" ? r.right - width : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      // Open upwards when there is no room below.
      const below = r.bottom + 4;
      const top = below + height > window.innerHeight - 8 && r.top - height - 4 > 8 ? r.top - height - 4 : below;
      setPos({ top, left });
    };
    place();
    const raf = requestAnimationFrame(place); // again once the panel has a size
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const anchor = marker.current?.parentElement;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor?.contains(t)) return; // the trigger toggles itself
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <>
      <span ref={marker} hidden />
      {open &&
        createPortal(
          <div
            ref={panel}
            style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            className={`z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-line bg-surface p-2 text-sm text-ink shadow-lg ${className}`}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
