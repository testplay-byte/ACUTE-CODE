import { useState } from "react";
import { motion } from "framer-motion";
import { Database, Server } from "lucide-react";
import { fadeInUp } from "../lib/motion";
import { useConfigStore } from "../lib/config-store";
import { Button, Field, inputClass } from "../components/ui/controls";

/**
 * Settings shell — only the data-source panel is functional in Wave 1 (the
 * rest lands with the real settings screens). The panel exists so the app is
 * switchable between the fixture adapter and the live sidecar before/after
 * the backend lands.
 */
export function SettingsPage() {
  const { baseUrl, token, demoData, setBaseUrl, setToken, setDemoData } = useConfigStore();
  const [urlDraft, setUrlDraft] = useState(baseUrl);
  const [tokenDraft, setTokenDraft] = useState(token ?? "");
  const [saved, setSaved] = useState(false);

  const save = () => {
    setBaseUrl(urlDraft);
    setToken(tokenDraft.trim() || null);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b-[1.5px] border-line px-5 py-3.5">
        <h1 className="text-[15px] font-bold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-[11px] text-muted">
          F9 · permissions, denylist and defaults arrive in a later wave
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <motion.section
          variants={fadeInUp}
          initial="initial"
          animate="animate"
          className="max-w-xl rounded-lg border-[1.5px] border-line p-4"
        >
          <div className="mb-3 flex items-center gap-2">
            <Server size={14} className="text-accent" />
            <h2 className="text-[13px] font-bold">Agent core connection</h2>
          </div>

          <div className="flex flex-col gap-3.5">
            <Field label="Data source" hint="Demo data uses an in-memory fixture backend; live reads the sidecar REST API.">
              <div className="flex gap-0.5 rounded-lg bg-hover p-0.5" role="group" aria-label="Data source">
                <button
                  onClick={() => setDemoData(true)}
                  aria-pressed={demoData}
                  className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border-[1.5px] px-2.5 py-1.5 text-[11px] font-semibold transition-all duration-200"
                  style={{
                    borderColor: demoData ? "var(--accent)" : "transparent",
                    backgroundColor: demoData ? "var(--card)" : "transparent",
                    color: demoData ? "var(--accent)" : "var(--muted)",
                  }}
                >
                  <Database size={12} />
                  Demo data
                </button>
                <button
                  onClick={() => setDemoData(false)}
                  aria-pressed={!demoData}
                  className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border-[1.5px] px-2.5 py-1.5 text-[11px] font-semibold transition-all duration-200"
                  style={{
                    borderColor: !demoData ? "var(--accent)" : "transparent",
                    backgroundColor: !demoData ? "var(--card)" : "transparent",
                    color: !demoData ? "var(--accent)" : "var(--muted)",
                  }}
                >
                  <Server size={12} />
                  Live sidecar
                </button>
              </div>
            </Field>

            <Field label="Base URL" hint="Loopback only; the Tauri shell overrides this at runtime via sidecar_endpoint().">
              <input
                className={`${inputClass} font-mono text-xs`}
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                placeholder="http://127.0.0.1:5178"
              />
            </Field>

            <Field
              label="Bearer token (dev only)"
              hint="Kept in memory only — never persisted. In the packaged app this arrives from the shell; dev fallback is VITE_ACUTE_TOKEN."
            >
              <input
                type="password"
                className={`${inputClass} font-mono text-xs`}
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                placeholder="dev token"
              />
            </Field>

            <div className="flex items-center gap-2">
              <Button variant="primary" onClick={save}>
                Save connection
              </Button>
              {saved ? <span className="text-[11px] text-accent">Saved</span> : null}
            </div>
          </div>
        </motion.section>
      </div>
    </div>
  );
}
