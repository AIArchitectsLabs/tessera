import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { createPdfDocument } from "@tessera/core";
import type { GraphConnector } from "@tessera/core";
import type { ConnectorContext } from "./context.js";
import {
  formatGraphArtifactWriteContent,
  formatGraphMaterializationContent,
  pdfBlocksFromValue,
  renderGraphArtifactWritePath,
  workspaceEffectTarget,
} from "./workspace-materialization.js";

export const workspaceConnector: GraphConnector<ConnectorContext> = {
  adapterId: "workspace",
  label: "Workspace",
  effects: [
    {
      effectId: "workspace.write",
      capability: "tool.workspace.write",
      sideEffect: "write",
      idempotent: true,
      previewRequired: true,
      approvalRequired: true,
      handler: async ({ node }, ctx) => {
        const { path, format } = workspaceEffectTarget(node.input);
        const value = "value" in node.input ? node.input.value : undefined;
        const parentAbsolute = await ctx.workspaceGuard.resolveInsideWorkspaceForCreate(
          dirname(path)
        );
        await mkdir(parentAbsolute, { recursive: true });
        const absolute = await ctx.workspaceGuard.resolveInsideWorkspaceForCreate(path);
        const relativePath = relative(ctx.workspaceGuard.root, absolute);
        if (format === "pdf") {
          await createPdfDocument({
            outputPath: absolute,
            displayOutputPath: relativePath,
            blocks: pdfBlocksFromValue(value),
          });
          const file = await stat(absolute);
          return {
            outputReference: relativePath,
            output: {
              kind: "workspace",
              path: relativePath,
              format,
              bytes: file.size,
            },
          };
        }

        const content = formatGraphMaterializationContent(value, format);
        await writeFile(absolute, content, "utf8");
        return {
          outputReference: relativePath,
          output: {
            kind: "workspace",
            path: relativePath,
            format,
            bytes: Buffer.byteLength(content),
          },
        };
      },
    },
  ],
  tools: [],
  artifactWrite: {
    capability: "tool.workspace.write",
    handler: async ({ run, node, artifactVersion, value }, ctx) => {
      const renderedPath = renderGraphArtifactWritePath(node.path, run.input);
      const parentAbsolute = await ctx.workspaceGuard.resolveInsideWorkspaceForCreate(
        dirname(renderedPath)
      );
      await mkdir(parentAbsolute, { recursive: true });
      const absolute = await ctx.workspaceGuard.resolveInsideWorkspaceForCreate(renderedPath);
      const content = formatGraphArtifactWriteContent(value, renderedPath);
      await writeFile(absolute, content, "utf8");
      return {
        path: relative(ctx.workspaceGuard.root, absolute),
        bytes: Buffer.byteLength(content),
        artifactId: node.artifact,
        artifactVersionId: artifactVersion.versionId,
        contentHash: artifactVersion.contentHash,
      };
    },
  },
};
