import { MoreHorizontal } from "lucide-react";
import { forwardRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Popover } from "./Popover";

type Variant = "primary" | "quiet" | "outline" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent-strong text-on-accent shadow-sm hover:bg-accent-strong/90",
  quiet: "text-ink hover:bg-ink/[0.06]",
  outline: "border border-line text-ink hover:bg-ink/[0.04]",
  danger: "text-danger hover:bg-danger/10",
};

export function Button({ variant = "quiet", className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}

/** A square button holding one icon; label is required for screen readers. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: "sm" | "md" }>(
  function IconButton({ label, active, size = "md", className = "", children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        title={label}
        aria-label={label}
        aria-pressed={active}
        className={`inline-flex shrink-0 items-center justify-center rounded-md transition-colors ${size === "sm" ? "h-7 w-7" : "h-8 w-8"} ${
          active ? "bg-accent-soft text-accent" : "text-muted hover:bg-ink/[0.06] hover:text-ink"
        } ${className}`}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

/** "⋯" menu for page-level actions such as Delete. */
export function MoreMenu({ label = "More actions", children }: { label?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <IconButton label={label} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal size={18} />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} align="right" className="w-56 p-1">
        {children(() => setOpen(false))}
      </Popover>
    </div>
  );
}

export function MenuItem({ icon, children, danger, onClick }: { icon?: ReactNode; children: ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
        danger ? "text-danger hover:bg-danger/10" : "text-ink hover:bg-ink/[0.06]"
      }`}
    >
      {icon && <span className="flex w-4 justify-center opacity-80">{icon}</span>}
      {children}
    </button>
  );
}

export function Banner({ tone = "info", children, actions }: { tone?: "info" | "warn"; children: ReactNode; actions?: ReactNode }) {
  const toneClass = tone === "warn" ? "border-warn/40 bg-warn-soft text-ink" : "border-line bg-surface text-ink";
  return (
    <div role="status" className={`flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm shadow-sm sm:flex-row sm:items-center sm:justify-between ${toneClass}`}>
      <div className="min-w-0 space-y-0.5">{children}</div>
      {actions && <div className="flex shrink-0 flex-wrap gap-1.5">{actions}</div>}
    </div>
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="text-balance font-serif text-[2rem] font-semibold leading-tight tracking-tight">{children}</h1>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-muted">{children}</p>;
}

export function Field({ label, htmlFor, children, hint }: { label: string; htmlFor: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

export const inputClass =
  "h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted/70 transition-colors focus:border-accent-strong focus:outline-none focus:ring-2 focus:ring-accent-strong/30";
