import { Button } from "@/components/ui/button";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Folder, Library } from "lucide-react";

interface WorkspacePickerProps {
  currentWorkspace: string | null;
  onWorkspaceSelect: (path: string) => void;
}

export function WorkspacePicker({ currentWorkspace, onWorkspaceSelect }: WorkspacePickerProps) {
  const handleOpenFolder = async () => {
    try {
      const selectedPath = await open({
        directory: true,
        multiple: false,
      });
      if (selectedPath && typeof selectedPath === "string") {
        onWorkspaceSelect(selectedPath);
      }
    } catch (err) {
      console.error("Failed to open dialog", err);
    }
  };

  const getWorkspaceName = () => {
    if (!currentWorkspace) return "Select Workspace";
    // Extract the folder name from the path
    const parts = currentWorkspace.split(/[/\\]/);
    return parts[parts.length - 1] || currentWorkspace;
  };

  return (
    <div className="flex flex-col gap-1 p-4">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
        Workspace
      </div>
      <Button
        variant="ghost"
        className="w-full justify-between px-2 h-12 hover:bg-black/5"
        onClick={handleOpenFolder}
      >
        <div className="flex items-center gap-3 overflow-hidden">
          <div className="w-8 h-8 rounded bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Library size={18} />
          </div>
          <div className="flex flex-col items-start overflow-hidden text-left">
            <span className="font-medium text-sm truncate w-full">{getWorkspaceName()}</span>
            {currentWorkspace && (
              <span className="text-xs text-muted-foreground truncate w-full opacity-70">
                {/* Simplify path display to simulate ~/Work/Marketing */}
                {currentWorkspace.replace(/\\/g, "/").split("/").slice(-2).join("/")}
              </span>
            )}
          </div>
        </div>
        <ChevronDown size={14} className="text-muted-foreground shrink-0" />
      </Button>
    </div>
  );
}
