import { useState } from "react";
import { FolderOpen, HardDriveUpload, Paperclip } from "lucide-react";
import { pickFilesViaBackend } from "../../../lib/api";
import { pushLocalToast } from "../../../hooks/use-notifications";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { ProjectFilePicker } from "./ProjectFilePicker";
import { useDismiss } from "./composer-utils";
import { useNativeOptionsMenu } from "./useNativeOptionsMenu";
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
 *
 * ROUND-92 (R92-A — the owner: opening the add-context menu cleared out the
 * embedded browser): inside the Tauri shell the TOP-LEVEL menu opens in the
 * MENU OVERLAY WINDOW (useNativeOptionsMenu) so it rides ABOVE the OS-level
 * browser webview and the browser never pauses. The nested ProjectFilePicker
 * (a rich searchable multi-select — NOT a simple options menu) stays a DOM
 * popover: picking "Add project files…" closes the overlay and re-enters the
 * DOM dropdown at the picker stage, exactly as before R92. That picker's
 * geometry can still cover the browser panel, but the R92-A caption-honesty
 * change makes the hide read as deliberate ("browser paused while the menu
 * is open") instead of a cleared-out blank.
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // R92-A: the overlay-first ladder — `menu.open` is the DOM leg. The local
  // `open` below covers ONLY the nested-picker re-entry (an overlay pick of
  // "project-files" re-enters the DOM dropdown at the picker stage).
  const menu = useNativeOptionsMenu({
    title: "Add context",
    menuWidth: 256, // the DOM menu's w-64
    align: "left", // the DOM menu's left-0
    rowHeight: 30, // label-only rows (the hint rides its own row)
    buildItems: () => [
      { id: "attach-files", label: "Attach files…", icon: "hard-drive-upload" as const },
      { id: "project-files", label: "Add project files…", icon: "folder-open" as const },
      // The hint line, carried as a non-selected informational row (the
      // only affordance the DOM menu had beyond the two actions).
      { id: "at-hint", label: "type @ to mention a project file" },
    ],
    onPick: (id) => {
      if (id === "attach-files") {
        void attachFromOsPicker();
      } else if (id === "project-files") {
        // The nested picker is DOM-only (see the header) — reopen the DOM
        // dropdown straight at its stage.
        setPickerOpen(true);
        setDomOpen(true);
      }
      // "at-hint" is informational — the pick just closes the menu.
    },
  });
  const [domOpen, setDomOpen] = useState(false);
  // The DOM dropdown's render truth: the hook's DOM leg (web / overlay
  // failed) OR the local nested-picker re-entry.
  const open = menu.open || domOpen;
  const menuRef = useDismiss(open, () => {
    setDomOpen(false);
    setPickerOpen(false);
    menu.closeAll();
  });
  const { files, isLoading } = useProjectFilePaths(projectId);

  const attachFromOsPicker = async (): Promise<void> => {
    setBusy(true);
    try {
      const paths = await pickFilesViaBackend();
      // [] = the user cancelled (or no dialog backend) — never an error.
      if (paths.length > 0) {
        setDomOpen(false);
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
          setPickerOpen(false);
          setDomOpen(false);
          menu.toggle(menuRef.current);
        }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={menu.isOpen || domOpen}
        aria-label="Add context"
        title={disabled ? "Attachments need the app backend" : "Attach files or project files"}
        // R126-3d-4: the chip grammar (the brief's material spec): resting
        // bg-well + the clay rim hairline + 12px/600 secondary ink; hover =
        // the CSS wash (border-accent + bg-accent-tint — the class leg; the
        // old JS color leg is gone).
        className="flex items-center justify-center h-7 w-7 rounded-lg border border-clay-rim bg-well text-muted text-[12px] font-semibold transition-colors duration-100 hover:border-accent hover:bg-accent-tint disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:border-clay-rim"
      >
        {/* ROUND-51 (R51-c, owner: "there should be just the logo. There
            should not be the context or text or anything like that") — the
            Paperclip icon alone; the name lives on aria-label + the title
            tooltip. The menu behavior below is untouched. */}
        <Paperclip size={12} className="shrink-0" />
      </button>
      {/* R92-A: the DOM dropdown renders ONLY on the web/fallback leg (and
          for the nested project-file picker) — while the overlay window is
          the menu a hidden duplicate here would fire the overlay guard and
          blank the browser (the bug this round fixes). */}
      {open ? (
        <div
          role="menu"
          aria-label="Add context"
          // R126-3d-4: the flyout = the clay card (card + rim + .ac-clay-sm
          // — the small-surface shadow step; the old bentoShadow/border JS
          // legs retired).
          className="absolute bottom-9 left-0 w-64 rounded-2xl border border-clay-rim bg-card p-1.5 z-50 ac-clay-sm"
        >
          {pickerOpen ? (
            <ProjectFilePicker
              files={files}
              isLoading={isLoading}
              onConfirm={(paths) => {
                setPickerOpen(false);
                setDomOpen(false);
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
                className="w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-lg text-[12px] transition-colors hover:bg-hover disabled:opacity-50 text-muted"
              >
                <HardDriveUpload size={12} className="shrink-0 text-accent" />
                Attach files…
                {busy ? (
                  <span className="ml-auto font-mono text-[10px]" style={{ color: styles.textTertiary }}>
                    picking…
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => setPickerOpen(true)}
                className="w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-lg text-[12px] transition-colors hover:bg-hover text-muted"
              >
                <FolderOpen size={12} className="shrink-0 text-accent" />
                Add project files…
              </button>
              <div
                className="mt-1 pt-1.5 border-t px-2 py-1 font-mono text-[10px]"
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
