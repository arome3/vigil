import { create } from "zustand";

interface UIState {
  commandPaletteOpen: boolean;
  shortcutOverlayOpen: boolean;
  keyboardContext: string;
  theme: "dark" | "light";
  setCommandPaletteOpen: (open: boolean) => void;
  setShortcutOverlayOpen: (open: boolean) => void;
  pushKeyboardContext: (context: string) => void;
  popKeyboardContext: () => void;
  toggleTheme: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  commandPaletteOpen: false,
  shortcutOverlayOpen: false,
  keyboardContext: "global",
  theme: "dark",
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setShortcutOverlayOpen: (open) => set({ shortcutOverlayOpen: open }),
  pushKeyboardContext: (context) => set({ keyboardContext: context }),
  popKeyboardContext: () => set({ keyboardContext: "global" }),
  toggleTheme: () =>
    set((s) => {
      const next = s.theme === "dark" ? "light" : "dark";
      if (typeof document !== "undefined") {
        document.documentElement.classList.toggle("dark", next === "dark");
      }
      return { theme: next };
    }),
}));
