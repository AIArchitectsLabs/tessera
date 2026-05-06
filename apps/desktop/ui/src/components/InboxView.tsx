import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { InboxMessage, InboxStatus } from "@tessera/contracts";
import { Clock3, RefreshCw } from "lucide-react";
import {
  inboxActionLabel,
  inboxSeverityClass,
  inboxStatusLabel,
  inboxTypeLabel,
} from "../lib/inbox";

const INBOX_STATUSES: InboxStatus[] = ["open", "snoozed", "resolved"];

interface InboxViewProps {
  error: string | null;
  loading: boolean;
  messages: InboxMessage[];
  onRefresh: () => void;
  onResolve: (message: InboxMessage, actionId: string) => void;
  onSelectMessage: (messageId: string) => void;
  onSnooze: (message: InboxMessage) => void;
  onStatusChange: (status: InboxStatus) => void;
  selectedMessage: InboxMessage | null;
  status: InboxStatus;
  workspaceRoot: string | null;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function InboxView({
  error,
  loading,
  messages,
  onRefresh,
  onResolve,
  onSelectMessage,
  onSnooze,
  onStatusChange,
  selectedMessage,
  status,
  workspaceRoot,
}: InboxViewProps) {
  return (
    <main className="flex min-w-0 flex-1 bg-background">
      <aside className="flex w-80 flex-shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-sm font-semibold text-foreground">Inbox</h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {workspaceRoot ? "Workspace actions" : "Select a workspace"}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full"
              onClick={onRefresh}
              disabled={loading}
              title="Refresh inbox"
            >
              <RefreshCw size={14} />
            </Button>
          </div>
          <div className="mt-3 flex gap-1">
            {INBOX_STATUSES.map((item) => (
              <Button
                key={item}
                type="button"
                variant={status === item ? "secondary" : "ghost"}
                size="sm"
                className="h-7 rounded-full px-2 text-[11px]"
                onClick={() => onStatusChange(item)}
              >
                {inboxStatusLabel(item)}
              </Button>
            ))}
          </div>
        </div>
        {error ? (
          <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">Loading inbox...</div>
          ) : messages.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">No inbox items.</div>
          ) : (
            <div className="py-2">
              {messages.map((message) => (
                <button
                  key={message.id}
                  type="button"
                  className={cn(
                    "w-full border-l-2 px-4 py-3 text-left transition-colors hover:bg-background/70",
                    selectedMessage?.id === message.id
                      ? "border-primary bg-accent"
                      : "border-transparent"
                  )}
                  onClick={() => onSelectMessage(message.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {message.title}
                    </span>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                        inboxSeverityClass(message.severity)
                      )}
                    >
                      {message.severity}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{inboxTypeLabel(message.type)}</span>
                    <span>·</span>
                    <span>{inboxStatusLabel(message.status)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {selectedMessage ? (
          <>
            <div className="border-b border-border px-6 py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-medium text-muted-foreground">
                    {inboxTypeLabel(selectedMessage.type)} · {selectedMessage.source}
                  </div>
                  <h2 className="mt-1 text-lg font-semibold text-foreground">
                    {selectedMessage.title}
                  </h2>
                  {selectedMessage.body ? (
                    <p className="mt-1 text-sm text-muted-foreground">{selectedMessage.body}</p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-full"
                  onClick={() => onSnooze(selectedMessage)}
                  disabled={selectedMessage.status === "resolved"}
                >
                  <Clock3 size={14} />
                  Snooze
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <div className="grid gap-5">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    Context
                  </h3>
                  <pre className="mt-2 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground">
                    {formatJson(selectedMessage.context)}
                  </pre>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    Actions
                  </h3>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectedMessage.actions.map((action) => (
                      <Button
                        key={action.id}
                        type="button"
                        size="sm"
                        variant={action.style === "danger" ? "destructive" : "secondary"}
                        className="h-8 rounded-full"
                        onClick={() => onResolve(selectedMessage, action.id)}
                        disabled={selectedMessage.status === "resolved"}
                      >
                        {inboxActionLabel(action)}
                      </Button>
                    ))}
                  </div>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    Audit
                  </h3>
                  <div className="mt-2 divide-y divide-border rounded-md border border-border">
                    {selectedMessage.audit.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        No audit entries.
                      </div>
                    ) : (
                      selectedMessage.audit.map((entry) => (
                        <div key={entry.id} className="px-3 py-2 text-xs">
                          <div className="font-medium text-foreground">{entry.event}</div>
                          <div className="text-muted-foreground">
                            {entry.actor} · {new Date(entry.createdAt).toLocaleString()}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="max-w-sm text-center">
              <h2 className="text-base font-semibold text-foreground">No inbox item selected</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Select an item to review context, actions, and audit history.
              </p>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
