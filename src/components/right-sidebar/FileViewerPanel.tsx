import { useRef, type ReactNode } from "react";
import { useProjectFile } from "../../hooks/use-projects";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";
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
 */
function isMarkdown(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

/** Lightweight markdown renderer (headings, bold, inline code, lists, code
 * fences, links). Enough for project README/rules files without a dep. */
function Markdown({ content }: { content: string }): ReactNode {
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
          className="my-2 rounded-[10px] p-3 font-mono text-[11.5px] leading-[1.55] overflow-x-auto auto-scroll border"
          style={{ background: "rgba(0,0,0,0.18)", borderColor: withAlpha(SYNTAX_COLORS.comment, 0.3), color: "#d4d4d4" }}
        >
          <code>{buf.join("\n")}</code>
          {lang ? (
            <span className="block mt-1 text-[10px] font-bold opacity-60">{lang}</span>
          ) : null}
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      const level = h[1].length;
      const sizes: Record<number, string> = { 1: "20px", 2: "17px", 3: "15px", 4: "14px", 5: "13px", 6: "12px" };
      out.push(
        <div key={`h-${key++}`} className="font-black mt-3 mb-1.5" style={{ fontSize: sizes[level] ?? "13px" }}>
          {inlineMd(h[2])}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (listKind !== "ul") { flushList(); listKind = "ul"; }
      listItems.push(<li key={`li-${key++}`}>{inlineMd(line.replace(/^\s*[-*]\s+/, ""))}</li>);
      i++;
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      if (listKind !== "ol") { flushList(); listKind = "ol"; }
      listItems.push(<li key={`li-${key++}`}>{inlineMd(line.replace(/^\s*\d+\.\s+/, ""))}</li>);
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
      <p key={`p-${key++}`} className="text-[12.5px] leading-[1.65] my-0.5">
        {inlineMd(line)}
      </p>,
    );
    i++;
  }
  flushList();
  return <div className="px-1">{out}</div>;
}

/** Inline markdown: **bold**, `code`, [text](url). */
function inlineMd(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(<span key={`t-${k++}`}>{text.slice(last, m.index)}</span>);
    if (m[2] !== undefined) {
      parts.push(<strong key={`b-${k++}`}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      parts.push(
        <code key={`c-${k++}`} className="px-1.5 py-0.5 rounded-md font-mono text-[11.5px]" style={{ background: "rgba(255,255,255,0.08)" }}>
          {m[3]}
        </code>,
      );
    } else if (m[4] !== undefined) {
      parts.push(
        <a key={`l-${k++}`} href={m[5]} target="_blank" rel="noreferrer" className="underline">
          {m[4]}
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
        <div className="text-[11.5px]" style={{ color: styles.textTertiary }}>
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
        className="shrink-0 flex items-center gap-1.5 px-3 h-7 border-b font-mono text-[10.5px] truncate"
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
          <div className="px-3 py-2 text-[11px] font-mono" style={{ color: "#ef4444" }}>
            {error instanceof Error ? error.message : "failed to load file"}
          </div>
        ) : isMd ? (
          <div className="px-3 py-3">
            <Markdown content={content} />
          </div>
        ) : (
          <pre className="p-2 font-mono text-[11.5px] leading-[1.6]">
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
