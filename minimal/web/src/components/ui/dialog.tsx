import { createContext, useContext, useEffect, useId, useRef, type ComponentProps, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

type DialogContextValue = { open: boolean; onOpenChange: (open: boolean) => void; titleId: string; descriptionId: string };
const DialogContext = createContext<DialogContextValue | null>(null);

function useDialog() {
  const value = useContext(DialogContext);
  if (!value) throw new Error("Dialog content requires a dialog root");
  return value;
}

export function Dialog({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const titleId = useId();
  const descriptionId = useId();
  return <DialogContext value={{ open, onOpenChange, titleId, descriptionId }}>{children}</DialogContext>;
}

export function DialogPopup({ children, className, bottomStickOnMobile: _bottomStickOnMobile, ...props }: ComponentProps<"dialog"> & { bottomStickOnMobile?: boolean }) {
  const dialog = useDialog();
  const element = useRef<HTMLDialogElement>(null);
  // The browser supplies modal focus containment and focus restoration without injected styles.
  useEffect(() => {
    if (dialog.open && !element.current?.open) element.current?.showModal();
    else if (!dialog.open && element.current?.open) element.current.close();
  }, [dialog.open]);
  return <dialog {...props} ref={element} className={cn("native-dialog dialog-glass rounded-2xl border", className)} aria-labelledby={dialog.titleId} aria-describedby={dialog.descriptionId} onCancel={event => { event.preventDefault(); dialog.onOpenChange(false); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.onOpenChange(false);
  }}>
    {dialog.open && children}
    {dialog.open && <Button className="dialog-close-button" size="icon" variant="ghost" aria-label="Close dialog" onClick={() => dialog.onOpenChange(false)}><XIcon /></Button>}
  </dialog>;
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-2 p-6 pb-3", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col-reverse gap-2 border-t bg-muted/72 px-6 py-4 sm:flex-row sm:justify-end", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 id={useDialog().titleId} className={cn("wrap-anywhere font-semibold text-xl leading-none pr-8", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: ComponentProps<"p">) {
  return <p id={useDialog().descriptionId} className={cn("text-muted-foreground text-sm", className)} {...props} />;
}

export function DialogPanel({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("dialog-panel space-y-4 p-6 pt-2", className)} {...props} />;
}
