import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "lucide-react";

interface PlaybookRefreshButtonProps {
  label?: string;
  isRefreshing: boolean;
  onRefresh: () => void;
}

export function PlaybookRefreshButton({
  label,
  isRefreshing,
  onRefresh,
}: PlaybookRefreshButtonProps) {
  return (
    <Button
      disabled={isRefreshing}
      onClick={onRefresh}
      type="button"
      variant="default"
      size="sm"
      className="rounded-md"
    >
      {isRefreshing ? (
        <>
          <Loader2 size={14} className="animate-spin" />
          Refreshing…
        </>
      ) : (
        <>
          <RefreshCw size={14} />
          {label ?? "Refresh"}
        </>
      )}
    </Button>
  );
}
