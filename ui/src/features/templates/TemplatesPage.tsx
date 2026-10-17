import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, PageTitle } from "@/components/ui";
import { TEMPLATES, type Template } from "@/lib/templates";
import { store } from "@platform";

export function TemplatesPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const use = async (t: Template) => {
    setBusy(t.id);
    setError("");
    try {
      const { root, drafts } = t.build();
      // Parents first, so every record lands in an existing database.
      for (const d of drafts) await store.saveEntry(d, 0);
      await qc.invalidateQueries();
      navigate(`/entry/${root}`);
    } catch (e) {
      setError(`Couldn't create “${t.name}”: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <PageTitle>Templates</PageTitle>
        <p className="text-sm text-muted">Each template adds ordinary pages and databases with a few example records. Change or delete anything afterwards.</p>
      </div>
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      <ul className="grid gap-4 sm:grid-cols-2">
        {TEMPLATES.map((t) => (
          <li key={t.id} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5">
            <div className="flex items-center gap-3">
              <span className="text-3xl" aria-hidden>
                {t.icon}
              </span>
              <h2 className="font-serif text-lg font-semibold">{t.name}</h2>
            </div>
            <p className="flex-1 text-sm text-muted">{t.description}</p>
            <Button variant="primary" className="self-start" disabled={busy !== null} onClick={() => void use(t)}>
              {busy === t.id ? "Creating…" : "Use template"}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
