"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { KEYBOARD_SHORTCUTS } from "@/lib/constants";
import { useUIStore } from "@/stores/ui-store";

export function KeyboardShortcutOverlay() {
  const open = useUIStore((s) => s.shortcutOverlayOpen);
  const setOpen = useUIStore((s) => s.setShortcutOverlayOpen);

  const sections = [
    { title: "Global", shortcuts: KEYBOARD_SHORTCUTS.global },
    { title: "Incident List", shortcuts: KEYBOARD_SHORTCUTS.incidentList },
    { title: "Incident Detail", shortcuts: KEYBOARD_SHORTCUTS.incidentDetail },
    { title: "Approval Modal", shortcuts: KEYBOARD_SHORTCUTS.approvalModal },
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Keyboard Shortcuts</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          {sections.map((section, i) => (
            <div key={section.title}>
              {i > 0 && <Separator className="mb-3" />}
              <h3 className="text-xs font-medium text-muted-foreground mb-2">{section.title}</h3>
              <div className="space-y-1.5">
                {section.shortcuts.map((shortcut) => (
                  <div key={shortcut.label} className="flex items-center justify-between">
                    <span className="text-xs">{shortcut.description}</span>
                    <kbd className="inline-flex items-center px-2 py-0.5 rounded bg-muted text-muted-foreground font-mono text-[10px]">
                      {shortcut.label}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
