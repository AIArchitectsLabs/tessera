import { Button } from "@/components/ui/button";
import { Blocks, CheckCircle2, FolderTree, MessageSquare, Sparkles, Wrench } from "lucide-react";

export type SidebarMode = "files" | "tasks";

interface RailNavProps {
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
}

export function RailNav({ mode, onModeChange }: RailNavProps) {
  const itemClass = (active: boolean) =>
    active
      ? "rounded-full bg-background text-foreground shadow-sm hover:bg-background"
      : "rounded-full text-muted-foreground hover:text-foreground";

  return (
    <nav className="w-16 flex-shrink-0 bg-secondary flex flex-col items-center py-4 border-r border-border gap-6 relative">
      <div className="relative w-10 h-10 bg-background rounded-xl shadow-sm flex items-center justify-center text-primary">
        <div className="absolute -left-[18px] top-1/2 -translate-y-1/2 w-1 h-5 bg-primary rounded-r-full" />
        <Blocks size={20} strokeWidth={2.5} />
      </div>
      <div className="flex flex-col gap-4">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={itemClass(mode === "files")}
          onClick={() => onModeChange("files")}
          title="Files"
        >
          <FolderTree size={20} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={itemClass(mode === "tasks")}
          onClick={() => onModeChange("tasks")}
          title="Tasks"
        >
          <CheckCircle2 size={20} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="rounded-full text-muted-foreground hover:text-foreground"
          title="Messages"
        >
          <MessageSquare size={20} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="rounded-full text-muted-foreground hover:text-foreground"
          title="Agents"
        >
          <Sparkles size={20} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="rounded-full text-muted-foreground hover:text-foreground"
          title="Settings"
        >
          <Wrench size={20} />
        </Button>
      </div>
    </nav>
  );
}
