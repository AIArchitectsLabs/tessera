import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type CompiledPlaybookGraph,
  CompiledPlaybookGraphSchema,
  PlaybookGraphCompileMetadataSchema,
} from "@tessera/contracts";

interface FileError extends Error {
  code?: string;
}

function cacheSegment(value: string): string {
  return `v-${Buffer.from(value, "utf8").toString("base64url")}`;
}

function artifactPath(root: string, playbookId: string, graphHash: string): string {
  return join(root, cacheSegment(playbookId), `${cacheSegment(graphHash)}.json`);
}

function sourceArtifactPath(
  root: string,
  playbookId: string,
  graphHash: string,
  sourceHash: string
): string {
  return join(
    root,
    cacheSegment(playbookId),
    cacheSegment(graphHash),
    `${cacheSegment(sourceHash)}.json`
  );
}

function latestPath(root: string, playbookId: string): string {
  return join(root, cacheSegment(playbookId), "latest.json");
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    const fileError = error as FileError | undefined;
    if (fileError?.code === "ENOENT") {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonFile(path: string, content: string): Promise<void> {
  const tempPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export interface PlaybookGraphCache {
  get(playbookId: string, graphHash: string): Promise<CompiledPlaybookGraph | undefined>;
  getSource(
    playbookId: string,
    graphHash: string,
    sourceHash: string
  ): Promise<CompiledPlaybookGraph | undefined>;
  getLatest(playbookId: string): Promise<CompiledPlaybookGraph | undefined>;
  save(compiled: CompiledPlaybookGraph): Promise<string>;
}

export function createPlaybookGraphCache(root: string): PlaybookGraphCache {
  const cache: PlaybookGraphCache = {
    async get(playbookId, graphHash) {
      const artifact = await readJsonFile<unknown>(artifactPath(root, playbookId, graphHash));
      if (!artifact) {
        return undefined;
      }

      const parsedArtifact = CompiledPlaybookGraphSchema.safeParse(artifact);
      return parsedArtifact.success ? parsedArtifact.data : undefined;
    },
    async getSource(playbookId, graphHash, sourceHash) {
      const sourceArtifact = await readJsonFile<unknown>(
        sourceArtifactPath(root, playbookId, graphHash, sourceHash)
      );
      if (sourceArtifact) {
        const parsedSourceArtifact = CompiledPlaybookGraphSchema.safeParse(sourceArtifact);
        if (parsedSourceArtifact.success) return parsedSourceArtifact.data;
      }

      const artifact = await cache.get(playbookId, graphHash);
      return artifact?.metadata.sourceHash === sourceHash ? artifact : undefined;
    },
    async getLatest(playbookId) {
      const metadata = await readJsonFile<unknown>(latestPath(root, playbookId));
      if (!metadata) {
        return undefined;
      }

      const parsedMetadata = PlaybookGraphCompileMetadataSchema.safeParse(metadata);
      if (!parsedMetadata.success) {
        return undefined;
      }

      return cache.get(playbookId, parsedMetadata.data.graphHash);
    },
    async save(compiled) {
      const parsed = CompiledPlaybookGraphSchema.parse(compiled);
      const playbookDir = join(root, cacheSegment(parsed.metadata.playbookId));
      await mkdir(playbookDir, { recursive: true });

      const artifact = artifactPath(root, parsed.metadata.playbookId, parsed.metadata.graphHash);
      const sourceArtifact = sourceArtifactPath(
        root,
        parsed.metadata.playbookId,
        parsed.metadata.graphHash,
        parsed.metadata.sourceHash
      );
      const latest = latestPath(root, parsed.metadata.playbookId);
      const artifactContent = `${JSON.stringify(parsed, null, 2)}\n`;
      const latestContent = `${JSON.stringify(parsed.metadata, null, 2)}\n`;

      await writeJsonFile(artifact, artifactContent);
      await mkdir(dirname(sourceArtifact), { recursive: true });
      await writeJsonFile(sourceArtifact, artifactContent);
      await writeJsonFile(latest, latestContent);

      return artifact;
    },
  };
  return cache;
}
