import { z } from "zod";

// IPC envelope — all messages between frontend and sidecar use this shape.
export const IpcEnvelopeSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.unknown(),
});

export type IpcEnvelope = z.infer<typeof IpcEnvelopeSchema>;

// Sidecar reports its connection info to the Rust shell on stdout at boot.
export const SidecarReadySchema = z.discriminatedUnion("transport", [
  z.object({
    type: z.literal("ready"),
    transport: z.literal("unix"),
    path: z.string(),
    token: z.string(),
  }),
  z.object({
    type: z.literal("ready"),
    transport: z.literal("tcp"),
    port: z.number(),
    token: z.string(),
  }),
]);

export type SidecarReady = z.infer<typeof SidecarReadySchema>;

// Spawn a registered CLI binary via the sidecar.
export const SpawnRequestSchema = z.object({
  binary: z.enum(["workspace-cli"]),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().max(60_000).default(10_000),
});

export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

export const SpawnResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  signal: z.string().nullable(),
  durationMs: z.number().nonnegative(),
});

export type SpawnResult = z.infer<typeof SpawnResultSchema>;
