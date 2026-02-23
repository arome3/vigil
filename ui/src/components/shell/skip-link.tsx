"use client";

export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="fixed top-0 left-0 z-[100] -translate-y-full bg-info px-4 py-2 text-sm font-medium text-white transition-transform focus:translate-y-0"
    >
      Skip to main content
    </a>
  );
}
