import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * Radix Dialog skinned in the demo's visual language: card surface, 1.5px
 * line border, 12px radius. Open/close transitions come from the keyframes in
 * src/index.css.
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { children: ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay fixed inset-0 z-40 bg-black/40" />
      <DialogPrimitive.Content
        className={cn(
          "dialog-content fixed top-1/2 left-1/2 z-50 w-[min(560px,92vw)] max-h-[86vh]",
          "flex flex-col rounded-xl border-[1.5px] border-line bg-card text-ink shadow-2xl",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label="Close dialog"
          className="absolute top-3.5 right-3.5 rounded-md p-1 text-muted transition-colors hover:bg-hover hover:text-ink"
        >
          <X size={14} />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="border-b-[1.5px] border-line px-5 py-4 pr-10">
      <DialogPrimitive.Title className="text-base font-bold tracking-tight">
        {title}
      </DialogPrimitive.Title>
      {description ? (
        <DialogPrimitive.Description className="mt-0.5 text-xs text-muted">
          {description}
        </DialogPrimitive.Description>
      ) : null}
    </div>
  );
}
