import { ArrowUpRight, Calendar, CheckSquare, CircleDot, Hash, Link2, Loader, Tags, Type } from "lucide-react";
import type { PropType } from "@/platform/types";

const ICONS: Record<PropType | "title", typeof Type> = {
  title: Type,
  text: Type,
  number: Hash,
  select: CircleDot,
  multi_select: Tags,
  status: Loader,
  date: Calendar,
  checkbox: CheckSquare,
  url: Link2,
  relation: ArrowUpRight,
};

/** A small icon for a property type, used in column headers and lists. */
export function PropIcon({ type, size = 14 }: { type: PropType | "title"; size?: number }) {
  const Icon = ICONS[type];
  return <Icon size={size} className="shrink-0 opacity-70" aria-hidden />;
}
