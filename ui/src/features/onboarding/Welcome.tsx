import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Field, inputClass } from "@/components/ui";
import { useSyncStatus } from "@/hooks/useSyncStatus";
import { writeJSON } from "@/lib/storage";
import { store } from "@platform";

/** Desktop first run: server address, test, sign in if needed. */
export function Welcome() {
  const appApi = store.app!;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const status = useSyncStatus();
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: appApi.getSettings });
  const [url, setUrl] = useState("");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);

  const address = url || settings?.serverUrl || "";

  const submit = async () => {
    setBusy(true);
    setMessage("");
    try {
      const r = needsPassword ? await appApi.signIn(address, password) : await appApi.connect(address);
      setNeedsPassword(r.needsPassword);
      setMessage(r.message);
      if (r.ok) {
        setConnected(true);
        void qc.invalidateQueries();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <div className="flex w-full max-w-md flex-col gap-6 rounded-xl border border-line bg-surface p-6">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold">Welcome to Dotion</h1>
          <p className="text-sm text-muted">Connect to your Dotion server to sync this device with your others.</p>
        </div>

        {connected ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm">Connected. {status.state === "syncing" ? status.message ?? "Downloading your entries…" : "Your entries are in sync."}</p>
            <div className="h-1.5 overflow-hidden rounded-full bg-accent-soft" aria-hidden>
              <div className={`h-full bg-accent ${status.state === "syncing" ? "w-2/3 animate-pulse" : "w-full"}`} />
            </div>
            <Button variant="primary" onClick={() => navigate("/today", { replace: true })}>
              Start writing
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Field label="Server address" htmlFor="server-url" hint="Usually https://dotion.<your-tailnet>.ts.net. Tailscale must be running on this device.">
              <input
                id="server-url"
                autoFocus
                value={address}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setNeedsPassword(false);
                }}
                placeholder="https://dotion.example.ts.net"
                className={inputClass}
              />
            </Field>
            {needsPassword && (
              <Field label="Password" htmlFor="server-password">
                <input
                  id="server-password"
                  type="password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputClass}
                />
              </Field>
            )}
            {message && (
              <p className="text-sm text-danger" role="alert">
                {message}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button type="submit" variant="primary" disabled={busy || !address}>
                {busy ? "Checking…" : needsPassword ? "Sign in" : "Test connection"}
              </Button>
              <Button
                onClick={() => {
                  writeJSON("offline-only", true);
                  navigate("/today", { replace: true });
                }}
              >
                Use offline for now
              </Button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
