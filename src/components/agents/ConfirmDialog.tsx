import { Dialog, DialogContent, DialogHeader } from "../ui/dialog";
import { Button } from "../ui/controls";

/** Minimal destructive-action confirm; no "always allow" anywhere (SPEC F6 spirit). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel = "Delete",
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void> | void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(400px,92vw)]" aria-describedby={undefined}>
        <DialogHeader title={title} />
        <div className="px-5 py-4 text-[13px] text-muted">{body}</div>
        <div className="flex justify-end gap-2 border-t-[1.5px] border-line px-5 py-3.5">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              await onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
