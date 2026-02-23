"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, AlertTriangle, Bot, GraduationCap, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const MOBILE_NAV_ITEMS = [
  { label: "Dashboard", href: "/",          icon: LayoutDashboard },
  { label: "Incidents", href: "/incidents",  icon: AlertTriangle },
  { label: "Agents",    href: "/agents",     icon: Bot },
  { label: "Learning",  href: "/learning",   icon: GraduationCap },
  { label: "Settings",  href: "/settings",   icon: Settings },
] as const;

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 flex md:hidden items-center justify-around border-t border-border-subtle bg-surface-base/95 backdrop-blur-sm"
      style={{ height: 56, paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Mobile navigation"
    >
      {MOBILE_NAV_ITEMS.map((item) => {
        const isActive =
          item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex flex-col items-center justify-center gap-0.5 min-w-[44px] min-h-[44px] text-xs transition-colors",
              isActive ? "text-foreground" : "text-muted-foreground"
            )}
            aria-current={isActive ? "page" : undefined}
          >
            <Icon className="h-5 w-5" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
