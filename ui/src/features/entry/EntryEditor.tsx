import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ListChecks, Sparkles, Trash2 } from "lucide-react";
import { Banner, Button, MenuItem, MoreMenu } from "@/components/ui";
import { DiaryEditor } from "@/editor/DiaryEditor";
import { useAiStatus } from "@/features/ai/AskPanel";
import { openAsk } from "@/features/ai/askBus";
import { aiName } from "@/features/ai/aiName";
import { ActionScanBanner, type ScanState } from "@/features/ai/ActionScanBanner";
import { RecordProperties } from "@/features/database/RecordProperties";
import { IconPicker } from "@/features/pages/IconPicker";
import { Backlinks, Breadcrumbs, SubPages } from "@/features/pages/PageRelations";
import { DELAYS, type SaveState } from "@/lib/autosave";
import { withProp } from "@/lib/db";
import { todayLocal } from "@/lib/dates";
import { saverFor, updateCaches } from "@/lib/savers";
import { EMPTY_DOC, sameDoc } from "@/lib/text";
import { useSyncStatus } from "@/hooks/useSyncStatus";
import { store } from "@platform";
import type { Entry, EntryDraft, EntryMeta } from "@/platform/types";
import { ConflictBanner } from "./ConflictBanner";
import { clearLocalDraft, loadLocalDraft, saveLocalDraft, type LocalDraft } from "./localDraft";

type Props = {
  entry: Entry | null; // null: not created yet (created on the first keystroke)
  id: string;
  entryDate: string | null;
  parentId?: string | null; // for a new sub-page or record
  defaultTitle: string;
};

export function EntryEditor({ entry, id, entryDate, parentId = entry?.parentId ?? null, defaultTitle }: Props) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const editorRef = useRef<Editor | null>(null);
  const [title, setTitle] = useState(entry?.title ?? defaultTitle);
  const titleRef = useRef(title);
  const [meta, setMeta] = useState<EntryMeta>(entry?.meta ?? {});
  const metaRef = useRef(meta);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [conflict, setConflict] = useState<{ current: Entry; copy: Entry } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanState | null>(null);
  const ai = useAiStatus();
  const [restore, setRestore] = useState<LocalDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exists, setExists] = useState(!!entry);
  const saver = saverFor(qc, id, entry?.version ?? 0);

  const web = store.platform === "web";
  const { data: parent } = useQuery({ queryKey: ["entry", parentId ?? ""], queryFn: () => store.getEntry(parentId!), enabled: !!parentId });
  const isRecord = parent?.kind === "database";
  const kindLabel = isRecord ? "record" : entryDate ? "entry" : "page";

  const replaceContent = useCallback((e: Entry) => {
    const ed = editorRef.current;
    if (ed && !sameDoc(ed.getJSON(), e.body)) {
      const { scrollY } = window;
      ed.commands.setContent(e.body ?? EMPTY_DOC, false); // false: not a user change
      window.scrollTo({ top: scrollY });
    }
    titleRef.current = e.title;
    setTitle(e.title);
    metaRef.current = e.meta;
    setMeta(e.meta);
  }, []);

  // This view's reactions to the shared saver.
  useEffect(
    () =>
      saver.on({
        onState: setSaveState,
        onSaved: () => setExists(true),
        onConflict: (current, copy) => {
          replaceContent(current);
          setConflict({ current, copy });
        },
        onDraft: web ? saveLocalDraft : undefined,
        onClearDraft: web ? clearLocalDraft : undefined,
      }),
    [saver, web, replaceContent],
  );

  const draft = useCallback(
    (): EntryDraft => ({
      id, entryDate, kind: "page", parentId, title: titleRef.current,
      body: editorRef.current?.getJSON() ?? EMPTY_DOC, meta: metaRef.current,
    }),
    [id, entryDate, parentId],
  );
  const changed = useCallback(() => saver.change(draft()), [saver, draft]);
  const flush = useCallback(() => void saver.flush(), [saver]);
  const setMetaAndSave = useCallback(
    (next: EntryMeta) => {
      metaRef.current = next;
      setMeta(next);
      changed();
    },
    [changed],
  );

  // Flush on route change / unmount, window close, Ctrl+S, and the desktop close hook.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        flush();
      }
    };
    const onUnload = () => flush();
    saver.revive(); // StrictMode remounts effects in development
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onUnload);
    const offFlush = store.onFlushRequest(flush);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onUnload);
      offFlush();
      void saver.flush();
    };
  }, [saver, flush]);

  // The open entry is special: a refetch must not overwrite what is being typed.
  useEffect(() => {
    if (!entry || saver.busy() || entry.version <= saver.base) return;
    const ed = editorRef.current;
    const same = ed ? sameDoc(ed.getJSON(), entry.body) && titleRef.current === entry.title : false;
    saver.adopt(entry); // our own save echoing back, or a newer copy
    if (entry.deletedAt) {
      setNotice("This entry was deleted on another device. Typing here will restore it.");
      return;
    }
    // Properties may change from a table view without touching the text.
    metaRef.current = entry.meta;
    setMeta(entry.meta);
    if (!same) {
      replaceContent(entry);
      setNotice("Updated from another device");
      const t = setTimeout(() => setNotice(null), 3000);
      return () => clearTimeout(t);
    }
  }, [entry, saver, replaceContent]);

  // Desktop: the sync engine reports conflicts for this entry asynchronously.
  useEffect(
    () =>
      store.onConflict(async ({ id: conflictId, copyId }) => {
        if (conflictId !== id) return;
        const [current, copy] = await Promise.all([store.getEntry(id), store.getEntry(copyId)]);
        if (!current || !copy) return;
        saver.base = current.version;
        replaceContent(current);
        setConflict({ current, copy });
        updateCaches(qc, current);
      }),
    [id, saver, qc, replaceContent],
  );

  // Web: offer unsaved text left over from a lost connection or closed tab.
  useEffect(() => {
    if (!web) return;
    const d = loadLocalDraft({ id, entryDate });
    if (!d) return;
    const newer = !entry || Date.parse(d.savedAt) > Date.parse(entry.updatedAt);
    const differs = !entry || !sameDoc(d.body, entry.body) || d.title !== entry.title;
    if (newer && differs) setRestore(d);
    else clearLocalDraft({ id, entryDate });
  }, []); // runs once per mounted entry

  const onReady = useCallback((ed: Editor) => {
    editorRef.current = ed;
  }, []);

  const doRestore = () => {
    if (!restore || !editorRef.current) return;
    editorRef.current.commands.setContent(restore.body, false);
    titleRef.current = restore.title;
    setTitle(restore.title);
    if (restore.meta) {
      metaRef.current = restore.meta;
      setMeta(restore.meta);
    }
    // Saved through the normal path, so a conflict is still detected.
    saver.base = restore.baseVersion;
    setRestore(null);
    changed();
    flush();
  };

  const doDelete = async () => {
    await saver.flush();
    if (exists) await store.deleteEntry(id, saver.base);
    clearLocalDraft({ id, entryDate });
    void qc.invalidateQueries();
    if (parentId) navigate(`/entry/${parentId}`, { replace: true });
    else navigate(entryDate && entryDate !== todayLocal() ? `/day/${entryDate}` : "/today", { replace: true });
  };

  return (
    <article className="flex flex-col gap-4">
      {entry && <Breadcrumbs entry={{ ...entry, parentId }} />}
      {!entry && parent && <Breadcrumbs entry={{ id, parentId } as Entry} />}
      {restore && (
        <Banner
          tone="warn"
          actions={
            <>
              <Button onClick={doRestore}>Restore unsaved text</Button>
              <Button
                onClick={() => {
                  clearLocalDraft({ id, entryDate });
                  setRestore(null);
                }}
              >
                Discard
              </Button>
            </>
          }
        >
          This page has text from {new Date(restore.savedAt).toLocaleString()} that didn't reach the server.
        </Banner>
      )}
      {conflict && <ConflictBanner current={conflict.current} copy={conflict.copy} onDismiss={() => setConflict(null)} />}
      {notice && <Banner>{notice}</Banner>}
      {scan && <ActionScanBanner state={scan} name={aiName(ai.data)} onDismiss={() => setScan(null)} />}

      {confirmDelete && (
        <Banner
          tone="warn"
          actions={
            <>
              <Button variant="danger" onClick={() => void doDelete()}>
                <Trash2 size={15} /> Delete
              </Button>
              <Button onClick={() => setConfirmDelete(false)}>Keep</Button>
            </>
          }
        >
          <p className="font-medium">Delete this {kindLabel} everywhere?</p>
          <p className="text-muted">It disappears from all your devices.</p>
        </Banner>
      )}

      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <IconPicker value={meta.icon} onChange={(icon) => setMetaAndSave({ ...metaRef.current, icon })} />
          <div className="flex items-center gap-2">
            <SaveIndicator state={saveState} onRetry={flush} />
            {(exists || saveState !== "idle") && (
              <MoreMenu label={`${kindLabel} actions`}>
                {(close) => (
                  <>
                    {ai.data?.enabled && exists && (
                      <>
                        <MenuItem
                          icon={<Sparkles size={15} />}
                          onClick={() => {
                            close();
                            openAsk({ prompt: "Summarize this page", send: true });
                          }}
                        >
                          Summarize with {aiName(ai.data)}
                        </MenuItem>
                        <MenuItem
                          icon={<ListChecks size={15} />}
                          onClick={async () => {
                            close();
                            setScan({ status: "running" });
                            try {
                              await saver.flush(); // scan what is on screen
                              if (store.app) {
                                await store.app.syncNow(); // the server reads the page, so send it first
                                await new Promise((r) => setTimeout(r, 1500));
                              }
                              setScan({ status: "done", result: await store.ai.scanActions(id) });
                            } catch (e) {
                              setScan({ status: "error", message: (e as Error).message });
                            }
                          }}
                        >
                          Find my action items
                        </MenuItem>
                      </>
                    )}
                    <MenuItem
                      danger
                      icon={<Trash2 size={15} />}
                      onClick={() => {
                        close();
                        setConfirmDelete(true);
                      }}
                    >
                      Delete {kindLabel}
                    </MenuItem>
                  </>
                )}
              </MoreMenu>
            )}
          </div>
        </div>
        <input
          id="entry-title"
          aria-label="Title"
          value={title}
          placeholder="Untitled"
          maxLength={300}
          onChange={(e) => {
            titleRef.current = e.target.value;
            setTitle(e.target.value);
            changed();
          }}
          onBlur={flush}
          className="w-full bg-transparent font-serif text-[2.4rem] font-semibold leading-tight tracking-tight text-ink placeholder:text-muted/50 focus:outline-none focus-visible:outline-none"
        />
      </header>

      {isRecord && parentId && (
        <RecordProperties
          databaseId={parentId}
          meta={meta}
          onChange={(propId, value) => {
            const d = withProp({ ...draft(), meta: metaRef.current }, propId, value);
            setMetaAndSave(d.meta);
          }}
        />
      )}

      <DiaryEditor initialContent={entry?.body ?? EMPTY_DOC} onReady={onReady} onUserChange={changed} onBlur={flush} />

      {!entryDate && !isRecord && exists && <SubPages id={id} />}
      {exists && <Backlinks id={id} />}
    </article>
  );
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const sync = useSyncStatus();
  let text = "";
  switch (state) {
    case "editing":
      text = "Editing…";
      break;
    case "saving":
      text = "Saving…";
      break;
    case "saved":
      text = "Saved";
      break;
    case "queued":
      text = sync.state === "synced" && !sync.pending ? "Saved" : "Saved on this device · will sync";
      break;
    case "error":
      return (
        <span className="text-xs text-danger" role="status">
          Couldn't save. Retrying in {DELAYS.retry / 1000} s ·{" "}
          <button type="button" className="underline" onClick={onRetry}>
            Retry now
          </button>
        </span>
      );
    case "idle":
      return null;
  }
  return (
    <span className="text-xs text-muted" role="status">
      {text}
    </span>
  );
}
