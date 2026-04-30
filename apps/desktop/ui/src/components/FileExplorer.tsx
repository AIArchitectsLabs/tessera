import { cn } from "@/lib/utils";
import { readDir } from "@tauri-apps/plugin-fs";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";

interface FileExplorerProps {
  workspaceRoot: string;
}

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  isOpen?: boolean;
}

const sortNodes = (nodes: FileNode[]) => {
  return [...nodes].sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });
};

function TreeNode({
  node,
  level = 0,
  onToggle,
}: {
  node: FileNode;
  level?: number;
  onToggle: (path: string) => void;
}) {
  const handleToggle = () => {
    onToggle(node.path);
  };

  return (
    <div>
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2 py-1 px-2 cursor-pointer hover:bg-black/5 rounded-md text-sm transition-colors bg-transparent border-0 text-left",
          node.isDirectory ? "text-foreground" : "text-muted-foreground"
        )}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
        onClick={handleToggle}
      >
        {node.isDirectory ? (
          <>
            <span className="w-4 h-4 flex items-center justify-center text-muted-foreground">
              {node.isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
            {node.isOpen ? (
              <FolderOpen size={14} className="text-primary" />
            ) : (
              <Folder size={14} className="text-primary/80" />
            )}
          </>
        ) : (
          <>
            <span className="w-4 h-4" />
            <FileText size={14} className="opacity-70" />
          </>
        )}
        <span className="truncate">{node.name}</span>
      </button>

      {node.isDirectory && node.isOpen && node.children && (
        <div className="flex flex-col">
          {node.children.map((child) => (
            <TreeNode key={child.path} node={child} level={level + 1} onToggle={onToggle} />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileExplorer({ workspaceRoot }: FileExplorerProps) {
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceRoot) {
      setNodes([]);
      return;
    }

    const loadRoot = async () => {
      setLoading(true);
      setError(null);
      try {
        const entries = await readDir(workspaceRoot);
        const initialNodes: FileNode[] = entries
          .filter((entry) => !entry.name.startsWith(".")) // Hide dotfiles
          .map((entry) => ({
            name: entry.name,
            path: `${workspaceRoot}/${entry.name}`,
            isDirectory: entry.isDirectory,
          }));

        setNodes(sortNodes(initialNodes));
      } catch (err) {
        console.error(err);
        setError("Failed to load workspace directory.");
      } finally {
        setLoading(false);
      }
    };

    void loadRoot();
  }, [workspaceRoot]);

  const handleToggle = async (targetPath: string) => {
    const updateNodes = async (currentNodes: FileNode[]): Promise<FileNode[]> => {
      const newNodes = [...currentNodes];
      for (let i = 0; i < newNodes.length; i++) {
        const node = newNodes[i];
        if (!node) continue;
        if (node.path === targetPath) {
          if (!node.isDirectory) return newNodes; // Files don't toggle

          if (node.isOpen) {
            node.isOpen = false;
          } else {
            node.isOpen = true;
            if (!node.children) {
              try {
                const entries = await readDir(node.path);
                const children: FileNode[] = entries
                  .filter((entry) => !entry.name.startsWith(".")) // Hide dotfiles
                  .map((entry) => ({
                    name: entry.name,
                    path: `${node.path}/${entry.name}`,
                    isDirectory: entry.isDirectory,
                  }));
                node.children = sortNodes(children);
              } catch (err) {
                console.error("Failed to read dir", err);
              }
            }
          }
          return newNodes;
        }
        if (node.children) {
          node.children = await updateNodes(node.children);
        }
      }
      return newNodes;
    };

    const nextNodes = await updateNodes(nodes);
    setNodes(nextNodes);
  };

  if (!workspaceRoot) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground p-4 text-center">
        No workspace selected.
      </div>
    );
  }

  if (loading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading files...</div>;
  }

  if (error) {
    return <div className="p-4 text-sm text-destructive">{error}</div>;
  }

  return (
    <div className="flex flex-col py-2">
      {nodes.map((node) => (
        <TreeNode key={node.path} node={node} onToggle={handleToggle} />
      ))}
      {nodes.length === 0 && (
        <div className="px-4 py-2 text-sm text-muted-foreground italic">Empty directory</div>
      )}
    </div>
  );
}
