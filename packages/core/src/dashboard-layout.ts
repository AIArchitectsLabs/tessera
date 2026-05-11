export function resolveBinding(outputs: unknown, binding: string): unknown {
  if (!binding) return undefined;

  const parts = binding.split(".");
  let cursor: unknown = outputs;

  for (const part of parts) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
    if (cursor === undefined) return undefined;
  }

  return cursor;
}
