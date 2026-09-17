import { useRef, type ReactNode } from "react";
import { useProjectFile } from "../../hooks/use-projects";
// R99-A: the ONE sanctioned link router — markdown links inside viewed files
// open in the app's OWN browser panel (the owner's native-browser directive),
// never a dead <a target="_blank"> swallowed by WebView2.
import { openLink } from "../../lib/open-link";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { highlightLine, getFileColor, SYNTAX_COLORS } from "../project-chat/highlight";
import { withAlpha } from "../dashboard/helpers";

/**
 * ROUND-38/39 right-sidebar File tab (owner: "for the codes… it can display
 * and render various kinds of files like .md files and various other code
 * files too"). ROUND-39: each file is its OWN tab in the right-sidebar strip
 * (browser-style), so this panel renders ONE file (no internal open-file
 * strip anymore — that was the old design). Code renders with line numbers +
 * token highlight; .md/.mdx renders through a lightweight markdown renderer.
 *
 * The active file's path comes from the tab. The chat's tool rows (DiffDetail
 * "Open") and the Explorer call openFile(projectId, path) which adds a tab.
 *
 * ROUND-48 (R48-c): isMarkdown + Markdown are EXPORTED so the right-sidebar
 * file explorer (FilesExplorerPanel) renders file content through the exact
 * same renderer as the single-file tab — one markdown/code presentation, not
 * two. No behavior change for this panel's own tab rendering.
 */
export function isMarkdown(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

/** Lightweight markdown renderer (headings, bold, inline code, lists, code
 * fences, links). Enough for project README/rules files without a dep.
 * ROUND-48 (R48-c): exported for reuse by FilesExplorerPanel.
 * ROUND-99 (R99-A): optional `projectId` — when a caller provides it, the
 * rendered links route through the central link router (in-app browser by
 * default); without it the anchor keeps its plain navigation (the legacy
 * behavior — no caller is left without a project in practice). */
export function Markdown({ content, projectId }: { content: string; projectId?: string }): ReactNode {
  const lines = content.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  // Accumulate consecutive list items, then flush as a single <ul>/<ol>.
  let listKind: "ul" | "ol" | null = null;
  let listItems: ReactNode[] = [];
  const flushList = () => {
    if (listKind !== null && listItems.length > 0) {
      if (listKind === "ul") {
        out.push(<ul key={`ul-${key++}`} className="my-1 ml-4 list-disc space-y-0.5">{listItems}</ul>);
      } else {
        out.push(<ol key={`ol-${key++}`} className="my-1 ml-4 list-decimal space-y-0.5">{listItems}</ol>);
      }
    }
    listKind = null;
    listItems = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    // Code fence
    if (/^```/.test(line)) {
      flushList();
      const lang = line.replace(/^```/, "").trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      out.push(
        <pre
          key={`pre-${key++}`}
          className="my-2 rounded-lg p-3 font-mono text-[12px] leading-[1.55] overflow-x-auto auto-scroll border"
          style={{ background: "rgba(0,0,0,0.18)", borderColor: withAlpha(SYNTAX_COLORS.comment, 0.3), color: "#d4d4d4" }}
        >
          <code>{buf.join("\n")}</code>
          {lang ? (
            <span className="block mt-1 text-[10px] font-medium opacity-60">{lang}</span>
          ) : null}
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      const level = h[1].length;
      // R100-G: markdown headings snap to the ladder per TOKENS §2 (the
      // ChatMarkdown HEADING_SIZES grammar) — h1–h3 = 13px/600, h4–h6 =
      // 12px/600; the old 20/17/15/14/13/12 font-black staircase was the
      // measured "AI-generated" tell.
      const sizes: Record<number, string> = { 1: "13px", 2: "13px", 3: "13px", 4: "12px", 5: "12px", 6: "12px" };
      out.push(
        <div key={`h-${key++}`} className="font-semibold mt-3 mb-1.5" style={{ fontSize: sizes[level] ?? "13px" }}>
          {inlineMd(h[2], projectId)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (listKind !== "ul") { flushList(); listKind = "ul"; }
      listItems.push(<li key={`li-${key++}`}>{inlineMd(line.replace(/^\s*[-*]\s+/, ""), projectId)}</li>);
      i++;
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      if (listKind !== "ol") { flushList(); listKind = "ol"; }
      listItems.push(<li key={`li-${key++}`}>{inlineMd(line.replace(/^\s*\d+\.\s+/, ""), projectId)}</li>);
      i++;
      continue;
    }
    if (line.trim() === "") {
      flushList();
      out.push(<div key={`sp-${key++}`} className="h-2" />);
      i++;
      continue;
    }
    flushList();
    out.push(
      <p key={`p-${key++}`} className="text-[13px] leading-[1.65] my-0.5">
        {inlineMd(line, projectId)}
      </p>,
    );
    i++;
  }
  flushList();
  return <div className="px-1">{out}</div>;
}

/** Inline markdown: **bold**, `code`, [text](url).
 * ROUND-99 (R99-A): when projectId is known, link clicks route through the
 * central openLink router (preventDefault — the app's own browser panel by
 * default); the REAL href + rel stay on the anchor (hover preview, copy-
 * link, keyboard Enter — which fires click and rides the same router).
 * Middle-click (aux button 1) routes the same way; right-click keeps the
 * native context menu. */
function inlineMd(text: string, projectId?: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  const route = (e: React.MouseEvent<HTMLAnchorElement>, url: string): void => {
    if (projectId === undefined) return; // no project context — legacy navigation
    e.preventDefault();
    void openLink(url, { projectId });
  };
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(<span key={`t-${k++}`}>{text.slice(last, m.index)}</span>);
    if (m[2] !== undefined) {
      parts.push(<strong key={`b-${k++}`}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      parts.push(
        <code key={`c-${k++}`} className="px-1.5 py-0.5 rounded-md font-mono text-[12px]" style={{ background: "rgba(255,255,255,0.08)" }}>
          {m[3]}
        </code>,
      );
    } else if (m[4] !== undefined) {
      // Capture the match's fields BEFORE building the element — the loop
      // variable `m` is reassigned by re.exec and is null by the time a click
      // handler's closure runs (the R99-A routing initially closed over `m`
      // directly and crashed on the first click).
      const url = m[5] as string;
      const label = m[4];
      parts.push(
        <a
          key={`l-${k++}`}
          href={url}
          target="_blank"
          rel="noreferrer"
          className="underline"
          onClick={(e) => route(e, url)}
          onAuxClick={(e) => {
            if (e.button === 1) route(e, url);
          }}
        >
          {label}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<span key={`t-${k++}`}>{text.slice(last)}</span>);
  return parts;
}

export function FileViewerPanel({ projectId, tab }: { projectId: string; tab: RightSidebarTab }) {
  const styles = useThemeStyles();
  const filePath = tab.filePath ?? null;
  const fileQuery = useProjectFile(projectId, filePath);
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(scrollRef);

  const content = fileQuery.data?.content ?? "";
  const loading = fileQuery.isLoading;
  const error = fileQuery.error;

  if (filePath === null) {
    return (
      <div className="h-full grid place-items-center px-6 text-center">
        <div className="text-[12px]" style={{ color: styles.textTertiary }}>
          No file bound to this tab.
        </div>
      </div>
    );
  }

  const isMd = isMarkdown(filePath);
  const lines = content.split("\n");
  const fileName = filePath.split("/").pop() ?? filePath;
  const fileColor = getFileColor(fileName);

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* File path breadcrumb */}
      <div
        className="shrink-0 flex items-center gap-1.5 px-3 h-7 border-b font-mono text-[11px] truncate"
        style={{
          borderColor: styles.border,
          color: styles.textSecondary,
          background: styles.isDark ? "rgba(0,0,0,0.15)" : styles.subtle,
        }}
        title={filePath}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: fileColor }} aria-hidden />
        <span className="truncate">{filePath}</span>
      </div>

      {/* Body */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto auto-scroll">
        {loading ? (
          <div className="px-3 py-2 text-[11px] font-mono" style={{ color: styles.textTertiary }}>
            loading…
          </div>
        ) : error ? (
          <div className="px-3 py-2 text-[11px] font-mono" style={{ color: SEMANTIC_COLORS.danger }}>
            {error instanceof Error ? error.message : "failed to load file"}
          </div>
        ) : isMd ? (
          <div className="px-3 py-3">
            <Markdown content={content} projectId={projectId} />
          </div>
        ) : (
          <pre className="p-2 font-mono text-[12px] leading-[1.6]">
            {lines.map((line, idx) => (
              <div key={idx} className="flex">
                <span
                  className="w-8 shrink-0 text-right pr-3 select-none font-mono text-[10px] leading-[1.6]"
                  style={{ color: styles.textTertiary }}
                >
                  {idx + 1}
                </span>
                <code className="flex-1 whitespace-pre-wrap break-words" style={{ color: styles.text }}>
                  {highlightLine(line).map((tok, ti) => (
                    <span key={ti} style={tok.color ? { color: tok.color } : undefined}>
                      {tok.text}
                    </span>
                  ))}
                  {line === "" ? " " : null}
                </code>
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}
