"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUIStore } from "@/stores/ui-store";

export function useKeyboardShortcuts() {
  const router = useRouter();
  const { setCommandPaletteOpen, setShortcutOverlayOpen, keyboardContext } = useUIStore();

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable;

      // Cmd+K always works (even in inputs)
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      // Escape closes overlays
      if (e.key === "Escape") {
        setCommandPaletteOpen(false);
        setShortcutOverlayOpen(false);
        return;
      }

      // All other shortcuts suppressed in inputs
      if (isInput) return;

      // Global shortcuts
      if (keyboardContext === "global" || keyboardContext === "incidentList" || keyboardContext === "incidentDetail") {
        switch (e.key) {
          case "?":
            e.preventDefault();
            setShortcutOverlayOpen(true);
            return;
          case "d":
          case "D":
            e.preventDefault();
            router.push("/");
            return;
          case "i":
          case "I":
            e.preventDefault();
            router.push("/incidents");
            return;
          case "g":
          case "G":
            e.preventDefault();
            router.push("/agents");
            return;
          case "l":
          case "L":
            e.preventDefault();
            router.push("/learning");
            return;
        }
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [router, setCommandPaletteOpen, setShortcutOverlayOpen, keyboardContext]);
}
