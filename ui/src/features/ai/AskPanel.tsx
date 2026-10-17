import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, FilePlus2, RotateCcw, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { Button, IconButton } from "@/components/ui";
import { renderAiMarkdown } from "@/lib/aiMarkdown";
import { openExternal } from "@/lib/external";
import { createPageFromMarkdown } from "@/lib/pages";
import { store } from "@platform";
import type { AiMessage, AiProposal, AiReply } from "@/platform/types";
import { aiName, aiPrivacy } from "./aiName";
import { onOpenAsk } from "./askBus";

export function useAiStatus() {
  return useQuery({ queryKey: ["ai-status"], queryFn: () => store.ai.status(), staleTime: 5 * 60_000, retry: false });
}

type Turn = { message: AiMessage; reply?: AiReply };

/** The page on screen: /entry/<id>, or the daily entry of /day/<date>. */
async function pageOnScreen(path: string): Promise<string | undefined> {
  const entry = /^\/entry\/([0-9a-f-]{36})/i.exec(path);
  if (entry) return entry[1];
  const day = /^\/day\/(\d{4}-\d{2}-\d{2})/.exec(path);
  if (day) return (await store.getEntryForDate(day[1]))?.id;
  if (path.startsWith("/today")) {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return (await store.getEntryForDate(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`))?.id;
  }
  return undefined;
}

const SUGGESTIONS_PAGE = ["Summarize this page", "What are my action items here?", "Turn this into a checklist"];
const SUGGESTIONS = ["What did I work on this week?", "What's due for me soon?", "Draft today's plan from my calendar and tasks"];

export function AskPanel() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  const { data: status } = useAiStatus();
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const onPage = /^\/(entry|day)\//.test(location.pathname) || location.pathname.startsWith("/today");

  const send = async (prompt: string) => {
    const q = prompt.trim();
    if (!q || busy) return;
    const history: Turn[] = [...turns, { message: { role: "user", text: q } }];
    setTurns(history);
    setText("");
    setError("");
    setBusy(true);
    try {
      const messages: AiMessage[] = history.flatMap((t) => (t.reply ? [t.message, { role: "model" as const, text: t.reply.text }] : [t.message]));
      const reply = await store.ai.chat(messages.slice(-40), await pageOnScreen(location.pathname));
      setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { ...t, reply } : t)));
    } catch (e) {
      setError((e as Error).message || "The assistant didn't answer. Try again.");
      setTurns((ts) => ts.slice(0, -1));
      setText(q);
    } finally {
      setBusy(false);
    }
  };

  useEffect(
    () =>
      onOpenAsk(({ prompt, send: now }) => {
        setOpen(true);
        if (prompt && now) void send(prompt);
        else if (prompt) setText(prompt);
        setTimeout(() => input.current?.focus(), 50);
      }),
    [turns, busy, location.pathname],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
        setTimeout(() => input.current?.focus(), 50);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  if (!open) return null;

  // Links inside answers: Dotion pages open in the app, others outside.
  const onAnswerClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    if (a.dataset.entry) {
      navigate(`/entry/${a.dataset.entry}`);
      if (window.innerWidth < 768) setOpen(false);
    } else if (a.dataset.external) openExternal(a.getAttribute("href")!);
  };

  return createPortal(
    <aside
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line bg-surface font-sans shadow-2xl sm:w-[26rem]"
      role="complementary"
      aria-label={`Ask ${aiName(status)}`}
      onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
    >
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Sparkles size={17} className="text-accent" />
        <h2 className="flex-1 text-sm font-semibold">
          Ask {aiName(status)} {status?.model && <span className="ml-1 text-xs font-normal text-muted">{status.model}</span>}
        </h2>
        {turns.length > 0 && (
          <IconButton label="New conversation" onClick={() => (setTurns([]), setError(""))} disabled={busy}>
            <RotateCcw size={16} />
          </IconButton>
        )}
        <IconButton label="Close (Ctrl+J)" onClick={() => setOpen(false)}>
          <X size={17} />
        </IconButton>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!status?.enabled ? (
          <p className="text-sm text-muted">
            {store.platform !== "web" && status === undefined
              ? "Checking…"
              : "The AI assistant isn't set up on your Dotion server, or the server can't be reached. See Settings → AI assistant."}
          </p>
        ) : turns.length === 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">
              Ask about anything you wrote. {aiName(status)} searches your notes and databases (and Calendar and Drive, when connected) and links the pages it used.
            </p>
            <div className="flex flex-col gap-1.5">
              {(onPage ? [...SUGGESTIONS_PAGE, ...SUGGESTIONS.slice(0, 1)] : SUGGESTIONS).map((s) => (
                <button key={s} type="button" onClick={() => void send(s)} className="rounded-lg border border-line px-3 py-2 text-left text-sm hover:border-accent hover:bg-accent-soft/40">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="flex flex-col gap-5">
            {turns.map((t, i) => (
              <li key={i} className="flex flex-col gap-3">
                <p className="self-end whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent-strong px-3.5 py-2 text-sm text-on-accent">{t.message.text}</p>
                {t.reply && <Answer reply={t.reply} onClick={onAnswerClick} />}
              </li>
            ))}
            {busy && (
              <li className="flex items-center gap-2 text-sm text-muted" role="status">
                <Sparkles size={14} className="animate-pulse text-accent" /> Reading your notes…
              </li>
            )}
          </ol>
        )}
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      </div>

      {status?.enabled && (
        <form
          className="flex items-end gap-2 border-t border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <textarea
            ref={input}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(text);
              }
            }}
            placeholder={onPage ? "Ask about this page or your notes" : "Ask about your notes"}
            aria-label={`Message to ${aiName(status)}`}
            className="max-h-40 min-h-[2.5rem] flex-1 resize-none rounded-xl border border-line bg-paper px-3 py-2 text-sm"
          />
          <IconButton label="Send" type="submit" disabled={busy || !text.trim()} className="!h-10 !w-10 rounded-xl bg-accent-strong text-on-accent hover:bg-accent-strong/90 hover:text-on-accent">
            <ArrowUp size={18} />
          </IconButton>
        </form>
      )}
      <p className="px-4 pb-3 text-[11px] text-muted">{aiPrivacy(status)} It can draft pages but never changes your notes.</p>
    </aside>,
    document.body,
  );
}

function Answer({ reply, onClick }: { reply: AiReply; onClick: (e: React.MouseEvent) => void }) {
  return (
    <div className="flex flex-col gap-3">
      {/* renderAiMarkdown escapes raw HTML and only emits page and http(s) links */}
      <div className="ai-answer text-sm leading-relaxed" onClick={onClick} dangerouslySetInnerHTML={{ __html: renderAiMarkdown(reply.text) }} />
      {reply.proposals.map((p, i) => (
        <ProposalCard key={i} proposal={p} />
      ))}
      {reply.sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Pages read" onClick={onClick}>
          {reply.sources.slice(0, 8).map((s) => (
            <a
              key={s.id}
              href="#"
              data-entry={s.id}
              className="max-w-full truncate rounded-full border border-line px-2.5 py-0.5 text-xs text-muted hover:border-accent hover:text-accent"
            >
              {s.title}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: AiProposal }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [created, setCreated] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <div className="rounded-xl border border-line bg-paper p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">Draft page</p>
      <p className="mt-0.5 font-serif text-base font-semibold">{proposal.title}</p>
      <pre className="mt-1 max-h-32 overflow-hidden whitespace-pre-wrap font-sans text-xs text-muted">{proposal.markdown.slice(0, 600)}</pre>
      <div className="mt-2 flex gap-2">
        {created ? (
          <Button variant="outline" className="h-8 px-2.5 text-xs" onClick={() => navigate(`/entry/${created}`)}>
            <Check size={14} /> Created · Open
          </Button>
        ) : (
          <Button
            variant="primary"
            className="h-8 px-2.5 text-xs"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                setCreated(await createPageFromMarkdown(qc, proposal.title, proposal.markdown, proposal.parentId ?? null, "✨"));
                void qc.invalidateQueries({ queryKey: ["pages"] });
              } finally {
                setSaving(false);
              }
            }}
          >
            <FilePlus2 size={14} /> {saving ? "Creating…" : "Create page"}
          </Button>
        )}
      </div>
    </div>
  );
}
