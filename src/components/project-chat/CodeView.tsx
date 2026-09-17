import { useRef } from "react";
import {
  useProjectChatStore,
} from "../../lib/project-chat-store";
import { useProjectFile } from "../../hooks/use-projects";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";
import { withAlpha } from "../dashboard/helpers";
import { highlightLine } from "./highlight";

/**
 * Code pane (demo CodeView port): macOS-style header over a gutter + tokenized
 * source. File content comes from GET /projects/:id/file via the store's
 * selectedFileId; syntax colors come from ./highlight (palette is data, not
 * theme). `busy` (turn-in-flight dots) is optional — wire it when turn state
 * is observable outside the chat panel (Phase 3 streaming); the pulsing dot is
 * the always-on indicator.
 */
export function CodeView({ projectId, busy = false }: { projectId: string; busy?: boolean }) {
  const styles = useThemeStyles();
  const selectedFileId = useProjectChatStore((s) => s.selectedFileId);
  const fileQuery = useProjectFile(projectId, selectedFileId);
  const scrollRef = useRef<HTMLDivElement>(null);

  useScrollFade(scrollRef);

  const content = fileQuery.data?.content ?? "";
  const lines = content.split("\n");
  const fileName = selectedFileId ? (selectedFileId.split("/").pop() ?? selectedFileId) : null;

  return (
    <div
      className="flex flex-col h-full rounded-2xl overflow-hidden"
      style={{
        backgroundColor: styles.card,
        borderColor: styles.border,
        boxShadow: styles.softShadow,
      }}
    >
      {/* Code header */}
      <div
        className="h-10 flex items-center gap-3 px-4 border-b shrink-0"
        style={{ borderColor: styles.border }}
      >
        {/* decorative macOS traffic lights — intentional exception */}
        <div className="flex gap-1.5 shrink-0">
          <span
            className="w-2.5 h-2.5 rounded-full"
            style={{ background: "#FF5F56", border: "1px solid rgba(0,0,0,0.1)" }}
          />
          <span
            className="w-2.5 h-2.5 rounded-full"
            style={{ background: "#FFBD2E", border: "1px solid rgba(0,0,0,0.1)" }}
          />
          <span
            className="w-2.5 h-2.5 rounded-full"
            style={{ background: "#27C93F", border: "1px solid rgba(0,0,0,0.1)" }}
          />
        </div>
        <span className="text-[12px] font-mono font-medium truncate" style={{ color: styles.text }}>
          {fileName ?? "no file"}
        </span>
        <div
          className="hidden md:inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[10px] font-mono border"
          style={{
            backgroundColor: styles.inputBg,
            borderColor: styles.inputBorder,
            color: styles.textTertiary,
          }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full animate-pulse"
            style={{ backgroundColor: SEMANTIC_COLORS.success }}
          />
          editing
          {busy && (
            <span className="flex gap-0.5 ml-1">
              {[0, 0.15, 0.3].map((delay, i) => (
                <span
                  key={i}
                  className="w-1 h-1 rounded-full"
                  style={{
                    background: styles.textTertiary,
                    animation: `bounceDot 1s infinite ${delay}s`,
                  }}
                />
              ))}
            </span>
          )}
        </div>
      </div>

      {/* Code body */}
      <div ref={scrollRef} className="flex-1 overflow-auto flex min-h-0 auto-scroll">
        {!selectedFileId ? (
          <div className="flex-1 grid place-items-center">
            <span className="font-mono text-[12px]" style={{ color: styles.textTertiary }}>
              Select a file from the explorer
            </span>
          </div>
        ) : fileQuery.isLoading ? (
          <div className="flex-1 grid place-items-center">
            <span className="font-mono text-[12px]" style={{ color: styles.textTertiary }}>
              Loading…
            </span>
          </div>
        ) : fileQuery.isError ? (
          <div className="flex-1 grid place-items-center gap-2">
            <span className="text-[12px]" style={{ color: SEMANTIC_COLORS.danger }}>
              {fileQuery.error instanceof Error ? fileQuery.error.message : "Failed to load file"}
            </span>
            <button
              onClick={() => void fileQuery.refetch()}
              className="text-[12px] underline"
              style={{ color: styles.accent }}
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <div
              className="w-[48px] shrink-0 py-4 text-right pr-3 select-none font-mono text-[12px] leading-[22px]"
              style={{
                color: styles.textTertiary,
                backgroundColor: withAlpha(styles.inputBg, styles.isDark ? 0.4 : 0.55),
              }}
            >
              {lines.map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <pre
              // R100-D: 12.5→12px mono (the no-half-pixel rule — matches the
              // CodeBlock body tier).
              className="flex-1 py-4 pl-4 pr-6 font-mono text-[12px] leading-[22px] whitespace-pre-wrap break-words"
              style={{ color: styles.text }}
            >
              {lines.map((line, i) => (
                <div key={i}>
                  <span style={{ color: i < 2 ? styles.textTertiary : undefined }}>
                    {highlightLine(line).map((token, ti) =>
                      token.color ? (
                        <span key={ti} style={{ color: token.color }}>
                          {token.text}
                        </span>
                      ) : (
                        <span key={ti}>{token.text}</span>
                      ),
                    )}
                  </span>
                </div>
              ))}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
