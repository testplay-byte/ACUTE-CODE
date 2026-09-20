import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ExternalLink, FileCode2, X } from "lucide-react";
import { useProjects } from "../../hooks/use-projects";
import { useProjectDemos } from "../../hooks/use-demos";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { ease } from "../../lib/motion";
import { withAlpha } from "../dashboard/helpers";

/**
 * DemoViewerScreen (Round-28 WS-I): an in-app area to view demos the agent
 * (or the owner) creates. Demos live at <project>/demos/<name>/index.html (or
 * a single .html file at <project>/demos/<name>.html). Clicking a demo card
 * opens it in a sandboxed iframe (full-viewport modal) via srcDoc (the
 * content is fetched as text + injected; no raw-HTML-serving route needed).
 *
 * Owner R28 directive: "maybe we should give an area inside our own
 * application itself to view this demo too and other kinds of things."
 *
 * R113-d (owner: the page headers are "unnecessary, unneeded, and not
 * required"): the 22px font-black "Demos" header + description block is
 * DELETED — the per-project sections (their own in-content h2 labels) are
 * the top of the page. Top padding snaps to the app's panel tier (py-6).
 */
interface DemoRow {
  projectId: string;
  projectName: string;
  projectColor: string;
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
}

export function DemoViewerScreen() {
  const styles = useThemeStyles();
  const projectsQuery = useProjects();
  const projects = projectsQuery.data ?? [];

  // Track which demo is open (for the iframe modal).
  const [openDemo, setOpenDemo] = useState<DemoRow | null>(null);
  const [openContent, setOpenContent] = useState<string>("");
  const [loadingContent, setLoadingContent] = useState(false);

  return (
    <div className="h-full overflow-y-auto" style={{ background: styles.bg }}>
      <div className="mx-auto max-w-5xl px-6 py-6">
        {/* R113-d: the header (h1 "Demos" + the <project>/demos/ explainer)
            is deleted per the owner's page-header directive — the project
            sections below are the content, each carrying its own label. */}

        {projectsQuery.isLoading ? (
          <div className="text-[13px]" style={{ color: styles.textTertiary }}>Loading projects…</div>
        ) : projects.length === 0 ? (
          <div className="text-[13px]" style={{ color: styles.textTertiary }}>
            No projects yet. Create a project, then ask the agent to build a demo (e.g. "create a demo at demos/test/index.html that shows a counter").
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {projects.map((p) => (
              <ProjectDemosSection
                key={p.id}
                projectId={p.id}
                projectName={p.name}
                projectColor={p.color}
                onOpen={async (row) => {
                  setOpenDemo(row);
                  setLoadingContent(true);
                  setOpenContent("");
                  try {
                    // Fetch the demo HTML content via the file route.
                    const { baseUrl, token } = await import("../../lib/config-store").then((m) => m.useConfigStore.getState());
                    const res = await fetch(`${baseUrl}/api/v1/projects/${row.projectId}/file?path=${encodeURIComponent(row.path)}`, {
                      headers: token ? { Authorization: `Bearer ${token}` } : {},
                    });
                    if (res.ok) {
                      const body = await res.json() as { content: string };
                      setOpenContent(body.content);
                    }
                  } catch {
                    setOpenContent(`<p style="font-family:system-ui;padding:2rem;color:#666">Demo not reachable. The sidecar may be down. Start it with <code>pnpm dev:full</code>.</p>`);
                  } finally {
                    setLoadingContent(false);
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Full-viewport iframe modal */}
      <AnimatePresence>
        {openDemo && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease }}
            className="fixed inset-0 z-[100] flex flex-col"
            style={{ background: "rgba(0,0,0,0.6)" }}
            onClick={() => { setOpenDemo(null); setOpenContent(""); }}
          >
            <motion.div
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              transition={{ duration: 0.2, ease }}
              className="m-4 flex-1 flex flex-col rounded-[16px] overflow-hidden border-[1.5px]"
              style={{ background: styles.card, borderColor: styles.border }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal header */}
              <div className="shrink-0 h-11 flex items-center gap-2 px-3 border-b" style={{ borderColor: styles.border, background: styles.subtle }}>
                <span className="text-[12px] font-mono truncate" style={{ color: styles.textSecondary }}>
                  {openDemo.projectName} / {openDemo.path}
                </span>
                <button
                  onClick={() => { setOpenDemo(null); setOpenContent(""); }}
                  aria-label="Close demo"
                  className="ml-auto w-7 h-7 rounded-md grid place-items-center transition-colors"
                  style={{ color: styles.textSecondary }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <X size={14} />
                </button>
              </div>
              {/* Iframe (sandboxed — scripts run, but no top-nav/forms/popups) */}
              <div className="flex-1 bg-white">
                {loadingContent ? (
                  <div className="h-full grid place-items-center text-[13px]" style={{ color: styles.textTertiary }}>Loading demo…</div>
                ) : (
                  <iframe
                    srcDoc={openContent}
                    sandbox="allow-scripts allow-same-origin"
                    title={`${openDemo.projectName} / ${openDemo.name}`}
                    className="w-full h-full border-0 bg-white"
                  />
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Per-project demos section. Fetches the demos list for one project. */
function ProjectDemosSection({
  projectId, projectName, projectColor, onOpen,
}: {
  projectId: string;
  projectName: string;
  projectColor: string;
  onOpen: (row: DemoRow) => void;
}) {
  const styles = useThemeStyles();
  const { data: demos, isLoading } = useProjectDemos(projectId);
  if (isLoading) return null;
  if (!demos || demos.length === 0) return null;

  return (
    <section>
      <h2 className="flex items-center gap-2 text-[14px] font-bold mb-2" style={{ color: styles.text }}>
        <span className="w-5 h-5 rounded-[6px] grid place-items-center text-[10px] font-black" style={{ background: projectColor, color: "#fff" }}>
          {projectName.charAt(0).toUpperCase()}
        </span>
        {projectName}
        <span className="text-[11px] font-mono ml-1" style={{ color: styles.textTertiary }}>
          ({demos.length})
        </span>
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {demos.map((d) => (
          <button
            key={`${projectId}-${d.path}`}
            onClick={() => onOpen({
              projectId, projectName, projectColor,
              name: d.name, path: d.path, size: d.size, modifiedAt: d.modifiedAt,
            })}
            className="flex flex-col gap-2 rounded-[14px] border-[1.5px] p-3 text-left transition-all hover:-translate-y-0.5"
            style={{ background: styles.card, borderColor: styles.border }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = withAlpha(styles.accent, 0.5))}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = styles.border)}
          >
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-[8px] grid place-items-center" style={{ background: withAlpha(styles.accent, 0.12) }}>
                <FileCode2 size={14} style={{ color: styles.accent }} />
              </div>
              <span className="text-[13px] font-bold truncate" style={{ color: styles.text }}>{d.name}</span>
            </div>
            <div className="text-[11px] font-mono truncate" style={{ color: styles.textTertiary }}>{d.path}</div>
            <div className="flex items-center gap-1.5 text-[10px]" style={{ color: styles.textTertiary }}>
              <ExternalLink size={10} /> {(d.size / 1024).toFixed(1)} KB
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
