import { Button } from "@/components/ui/button";
import { Blocks, CheckCircle2, Inbox, LogOut, Settings, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type AppView = "tasks" | "inbox";

interface RailNavProps {
  activeView: AppView;
  onLogout: () => void;
  onOpenSettings: () => void;
  onViewChange: (view: AppView) => void;
}

export function RailNav({ activeView, onLogout, onOpenSettings, onViewChange }: RailNavProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstMenuItemRef = useRef<HTMLButtonElement>(null);
  const navItemClass = (view: AppView) =>
    activeView === view
      ? "rounded-full bg-background text-foreground shadow-sm hover:bg-background"
      : "rounded-full text-muted-foreground hover:text-foreground";

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    firstMenuItemRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      setMenuOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

  return (
    <nav className="relative flex w-16 flex-shrink-0 flex-col items-center gap-6 border-r border-border bg-secondary py-4">
      <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-background text-primary shadow-sm">
        <div className="absolute -left-[18px] top-1/2 -translate-y-1/2 w-1 h-5 bg-primary rounded-r-full" />
        <Blocks size={20} strokeWidth={2.5} />
      </div>
      <div className="flex flex-col gap-4">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={navItemClass("tasks")}
          title="Tasks"
          aria-current={activeView === "tasks" ? "page" : undefined}
          onClick={() => onViewChange("tasks")}
        >
          <CheckCircle2 size={20} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={navItemClass("inbox")}
          title="Inbox"
          aria-current={activeView === "inbox" ? "page" : undefined}
          onClick={() => onViewChange("inbox")}
        >
          <Inbox size={20} />
        </Button>
      </div>
      <div className="mt-auto" ref={menuRef}>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="icon"
          className="rounded-full bg-background text-foreground shadow-sm hover:bg-background"
          title="User menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls="user-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <User size={18} />
        </Button>
        {menuOpen && (
          <div
            id="user-menu"
            role="menu"
            className="absolute bottom-12 left-14 z-20 w-40 rounded-xl border border-border bg-popover p-1 shadow-lg"
          >
            <Button
              ref={firstMenuItemRef}
              type="button"
              variant="ghost"
              role="menuitem"
              className="h-8 w-full justify-start rounded-lg px-2 text-xs"
              onClick={() => {
                setMenuOpen(false);
                onOpenSettings();
              }}
            >
              <Settings size={14} />
              Settings
            </Button>
            <Button
              type="button"
              variant="ghost"
              role="menuitem"
              className="h-8 w-full justify-start rounded-lg px-2 text-xs text-muted-foreground"
              onClick={() => {
                setMenuOpen(false);
                triggerRef.current?.focus();
                onLogout();
              }}
            >
              <LogOut size={14} />
              Logout
            </Button>
          </div>
        )}
      </div>
    </nav>
  );
}
