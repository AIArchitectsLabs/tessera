import {
  type DashboardLayout,
  type DashboardSection,
  resolveDashboardBinding,
} from "@tessera/contracts";

interface DashboardViewProps {
  layout: DashboardLayout;
  outputs: Record<string, unknown>;
}

export function DashboardView({ layout, outputs }: DashboardViewProps) {
  return (
    <div className="space-y-5">
      {layout.sections.map((section, index) => (
        <DashboardSectionView
          key={`${section.type}:${index}`}
          section={section}
          outputs={outputs}
        />
      ))}
    </div>
  );
}

function DashboardSectionView({
  section,
  outputs,
}: {
  section: DashboardSection;
  outputs: Record<string, unknown>;
}) {
  if (section.type === "metrics") {
    return (
      <section>
        {section.title ? (
          <h3 className="mb-2 text-sm font-semibold text-foreground">{section.title}</h3>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {section.items.map((item, index) => {
            const value = resolveDashboardBinding(outputs, item.binding);
            return (
              <div
                key={`${item.binding}:${index}`}
                className="rounded-md border border-border bg-background p-4"
              >
                <div className="text-2xl font-semibold text-foreground">{formatValue(value)}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {item.label}
                  {item.unit ? ` (${item.unit})` : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  if (section.type === "list") {
    const value = resolveDashboardBinding(outputs, section.binding);
    const items = Array.isArray(value) ? value : [];
    return (
      <section className="rounded-md border border-border bg-background p-4">
        <h3 className="text-sm font-semibold text-foreground">{section.title}</h3>
        {items.length === 0 ? (
          <div className="mt-2 text-sm text-muted-foreground">
            {section.emptyLabel ?? "Nothing to show."}
          </div>
        ) : (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-foreground">
            {items.map((entry) => (
              <li key={stableKey(entry)}>{formatValue(entry)}</li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  if (section.type === "text") {
    const value = resolveDashboardBinding(outputs, section.binding);
    return (
      <section className="rounded-md border border-border bg-background p-4">
        <h3 className="text-sm font-semibold text-foreground">{section.title}</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{formatValue(value)}</p>
      </section>
    );
  }

  if (section.type === "table") {
    const value = resolveDashboardBinding(outputs, section.binding);
    const rows = Array.isArray(value) ? value : [];
    return (
      <section className="overflow-hidden rounded-md border border-border bg-background">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">{section.title}</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary text-xs text-muted-foreground">
              <tr>
                {section.columns.map((column) => (
                  <th key={column.key} className="px-4 py-2 text-left font-medium">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={stableKey(row)}>
                  {section.columns.map((column) => (
                    <td key={column.key} className="px-4 py-2 text-foreground">
                      {formatValue(valueAtKey(row, column.key))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  return null;
}

function valueAtKey(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function stableKey(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
