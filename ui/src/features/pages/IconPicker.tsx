import { useState } from "react";
import { Popover } from "@/components/Popover";

const ICONS = [
  "📄", "📝", "📓", "📚", "📌", "📎", "🗂️", "🗃️", "📁", "📊", "📈", "🧭",
  "💡", "🧠", "🎯", "✅", "🗓️", "⏰", "🏠", "💼", "🛠️", "⚙️", "🧪", "🔬",
  "💻", "🐞", "🚀", "🔒", "🌱", "🌍", "🎨", "🎵", "🏃", "🍳", "✈️", "💬",
  "❤️", "⭐", "🔥", "☕", "📷", "🎓",
];

/** Page icon: an emoji shown in the sidebar, links and the page header. */
export function IconPicker({ value, onChange, fallback = "📄" }: { value?: string; onChange: (icon: string | undefined) => void; fallback?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={value ? "Change icon" : "Add an icon"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-11 w-11 items-center justify-center rounded-lg text-2xl hover:bg-accent-soft ${value ? "" : "opacity-40 hover:opacity-100"}`}
      >
        {value || fallback}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="w-72">
        <div className="grid grid-cols-8 gap-1" role="listbox" aria-label="Icons">
          {ICONS.map((i) => (
            <button
              key={i}
              type="button"
              role="option"
              aria-selected={i === value}
              onClick={() => {
                onChange(i);
                setOpen(false);
              }}
              className={`flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-accent-soft ${i === value ? "bg-accent-soft" : ""}`}
            >
              {i}
            </button>
          ))}
        </div>
        {value && (
          <button
            type="button"
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
            className="mt-2 rounded px-2 py-1 text-xs text-muted hover:bg-accent-soft"
          >
            Remove icon
          </button>
        )}
      </Popover>
    </div>
  );
}
