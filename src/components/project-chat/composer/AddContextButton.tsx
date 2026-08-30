import { useState } from "react";
import { FolderOpen, HardDriveUpload, Paperclip } from "lucide-react";
import { pickFilesViaBackend } from "../../../lib/api";
import { pushLocalToast } from "../../../hooks/use-notifications";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { ProjectFilePicker } from "./ProjectFilePicker";
import { useDismiss } from "./composer-utils";
import { useProjectFilePaths } from "./useProjectFiles";

/**
 * ROUND-50 (R50-c2): Add Context — the composer's bottom-left entry point
 * (owner: "I can upload files from there and I can also mark the files of my
 * project from there too. I can click Add Attach File and it will open up the
 * Windows file picker…").
 *
 * ROUND-51 (R51-c): the button is ICON-ONLY (owner: "To add the context there
 * should be just the logo") — the Paperclip carries aria-label="Add context"
 * + the title tooltip; the menu below is unchanged.
 *
 * Menu:
 *  1. "Attach files…" → the REAL OS picker (pickFilesViaBackend — Tauri rfd
 *     inside the app, the sidecar dialog route in browser dev); the chosen
 *     absolute paths are then read server-side by the composer.
 *  2. "Add project files…" → the searchable multi-select ProjectFilePicker
 *     over the project tree (same list as the @ quick-picker).
 *  3. Hint line: "type @ to mention a project file".
 */
export function AddContextButton({
  projectId,
  disabled,
  onAttachPaths,
}: {
  projectId: string;
  disabled: boolean;
  /** Read the given paths (absolute or project-relative) + stage chips. */
  onAttachPaths: (paths: string[], source: "picker" | "project") => void | Promise<void>;
}) {
  const styles = useThemeStyles();
  const [open, setOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useDismiss(open, () => {
    setOpen(false);
    setPickerOpen(false);
  });
  const { files, isLoading } = useProjectFilePaths(projectId);

  const attachFromOsPicker = async (): Promise<void> => {
    setBusy(true);
    try {
      const paths = await pickFilesViaBackend();
      // [] = the user cancelled (or no dialog backend) — never an error.
      if (paths.length > 0) {
        setOpen(false);
        await onAttachPaths(paths, "picker");
      }
    } catch (err) {
      pushLocalToast(
        "File picker failed",
        err instanceof Error ? err.message : String(err),
        "task_failed",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setPickerOpen(false);
        }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add context"
        title={disabled ? "Attachments need the app backend" : "Attach files or project files"}
        className="flex items-center justify-center h-7 w-7 rounded-[10px] text-[11px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ color: styles.textSecondary }}
        onMouseEnter={(e) => {
          if (!disabled) e.currentTarget.style.background = styles.subtleHover;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        {/* ROUND-51 (R51-c, owner: "there should be just the logo. There
            should not be the context or text or anything like that") — the
            Paperclip icon alone; the name lives on aria-label + the title
            tooltip. The menu behavior below is untouched. */}
        <Paperclip size={12} className="shrink-0" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Add context"
          className="absolute bottom-9 left-0 w-64 rounded-2xl border p-1.5 z-50"
          style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
        >
          {pickerOpen ? (
            <ProjectFilePicker
              files={files}
              isLoading={isLoading}
              onConfirm={(paths) => {
                setPickerOpen(false);
                setOpen(false);
                void onAttachPaths(paths, "project");
              }}
              onCancel={() => setPickerOpen(false)}
            />
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => void attachFromOsPicker()}
                disabled={busy}
                className="w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-lg text-[11.5px] font-medium transition-colors disabled:opacity-50"
                style={{ color: styles.textSecondary }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = styles.subtleHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <HardDriveUpload size={12} className="shrink-0" style={{ color: styles.accent }} />
                Attach files…
                {busy ? (
                  <span className="ml-auto font-mono text-[9.5px]" style={{ color: styles.textTertiary }}>
                    picking…
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => setPickerOpen(true)}
                className="w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-lg text-[11.5px] font-medium transition-colors"
                style={{ color: styles.textSecondary }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = styles.subtleHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <FolderOpen size={12} className="shrink-0" style={{ color: styles.accent }} />
                Add project files…
              </button>
              <div
                className="mt-1 pt-1.5 border-t px-2 py-1 font-mono text-[9.5px]"
                style={{ borderColor: styles.borderSubtle, color: styles.textTertiary }}
              >
                type @ to mention a project file
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
