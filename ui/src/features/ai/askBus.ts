// Opens the Ask AI panel from anywhere (sidebar, Ctrl+J, page menus).
type Request = { prompt?: string; send?: boolean };
const subs = new Set<(r: Request) => void>();

export function openAsk(r: Request = {}): void {
  subs.forEach((cb) => cb(r));
}

export function onOpenAsk(cb: (r: Request) => void): () => void {
  subs.add(cb);
  return () => void subs.delete(cb);
}
