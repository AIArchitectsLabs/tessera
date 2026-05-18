import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInflateRaw } from "node:zlib";

export interface ExtractZipArchiveOptions {
  zipPath: string;
  destinationRoot: string;
  maxCompressedBytes?: number;
  maxDeclaredUncompressedBytes?: number;
  maxInflatedBytes?: number;
}

export interface ExtractedZipArchive {
  root: string;
  files: string[];
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;
const DEFAULT_MAX_COMPRESSED_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  crcTable[index] = crc >>> 0;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("Invalid zip archive: missing central directory");
}

function normalizedZipPath(name: string): string {
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\") ||
    path.includes("\\")
  ) {
    throw new Error(`Invalid zip archive path: ${name}`);
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Invalid zip archive path: ${name}`);
  }
  return segments.join("/");
}

function isSymlinkExternalAttributes(value: number): boolean {
  const mode = (value >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

interface CentralDirectoryEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  externalAttributes: number;
}

function readCentralDirectory(buffer: Buffer): CentralDirectoryEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(eocdOffset + 6);
  const diskEntries = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntries !== totalEntries) {
    throw new Error("Unsupported zip archive: multi-disk archives are not supported");
  }
  if (
    totalEntries === 0xffff ||
    centralDirectorySize === ZIP64_SENTINEL ||
    centralDirectoryOffset === ZIP64_SENTINEL
  ) {
    throw new Error("Unsupported zip archive: zip64 is not supported");
  }
  if (centralDirectoryOffset + centralDirectorySize > buffer.length) {
    throw new Error("Invalid zip archive: central directory exceeds file bounds");
  }

  const entries: CentralDirectoryEntry[] = [];
  let offset = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;
  while (offset < end) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw new Error("Invalid zip archive: malformed central directory entry");
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const next = offset + 46 + fileNameLength + extraLength + commentLength;
    if (next > buffer.length || next > end) {
      throw new Error("Invalid zip archive: central directory entry exceeds bounds");
    }

    const rawName = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    const name = normalizedZipPath(rawName);
    if ((flags & 0x01) !== 0) {
      throw new Error("Unsupported zip archive: encrypted entries are not supported");
    }
    if ((flags & 0x08) !== 0) {
      throw new Error("Unsupported zip archive: data descriptors are not supported");
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`Unsupported zip compression method: ${method}`);
    }
    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localHeaderOffset === ZIP64_SENTINEL
    ) {
      throw new Error("Unsupported zip archive: zip64 is not supported");
    }
    if (isSymlinkExternalAttributes(externalAttributes)) {
      throw new Error(`Unsupported zip archive entry: symlink ${name}`);
    }

    if (!rawName.endsWith("/")) {
      entries.push({
        name,
        flags,
        method,
        crc,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        externalAttributes,
      });
    }
    offset = next;
  }

  if (offset !== end) {
    throw new Error("Invalid zip archive: central directory size mismatch");
  }
  return entries;
}

function inflateRawBounded(input: {
  compressed: Buffer;
  maxBytes: number;
  expectedBytes: number;
  entryName: string;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const inflater = createInflateRaw();
    const chunks: Buffer[] = [];
    let inflatedBytes = 0;

    inflater.on("data", (chunk: Buffer) => {
      inflatedBytes += chunk.length;
      if (inflatedBytes > input.maxBytes) {
        inflater.destroy(new Error("Zip archive exceeds inflated byte limit"));
        return;
      }
      chunks.push(chunk);
    });
    inflater.on("error", reject);
    inflater.on("end", () => {
      const inflated = Buffer.concat(chunks, inflatedBytes);
      if (inflated.length !== input.expectedBytes) {
        reject(new Error(`Invalid zip archive: inflated size mismatch for ${input.entryName}`));
        return;
      }
      resolve(inflated);
    });
    inflater.end(input.compressed);
  });
}

async function readLocalFile(input: {
  buffer: Buffer;
  entry: CentralDirectoryEntry;
  maxInflatedBytes: number;
}): Promise<Buffer> {
  const { buffer, entry } = input;
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`Invalid zip archive: malformed local header for ${entry.name}`);
  }

  const flags = buffer.readUInt16LE(offset + 6);
  const method = buffer.readUInt16LE(offset + 8);
  const crc = buffer.readUInt32LE(offset + 14);
  const compressedSize = buffer.readUInt32LE(offset + 18);
  const uncompressedSize = buffer.readUInt32LE(offset + 22);
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const nameStart = offset + 30;
  const dataStart = nameStart + fileNameLength + extraLength;
  const dataEnd = dataStart + compressedSize;

  if (dataEnd > buffer.length) {
    throw new Error(`Invalid zip archive: local file data exceeds bounds for ${entry.name}`);
  }
  const localName = normalizedZipPath(
    buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf8")
  );
  if (
    localName !== entry.name ||
    flags !== entry.flags ||
    method !== entry.method ||
    crc !== entry.crc ||
    compressedSize !== entry.compressedSize ||
    uncompressedSize !== entry.uncompressedSize
  ) {
    throw new Error(`Invalid zip archive: central/local metadata mismatch for ${entry.name}`);
  }

  const compressed = buffer.subarray(dataStart, dataEnd);
  const inflated =
    method === 0
      ? Buffer.from(compressed)
      : await inflateRawBounded({
          compressed: Buffer.from(compressed),
          maxBytes: input.maxInflatedBytes,
          expectedBytes: uncompressedSize,
          entryName: entry.name,
        });
  if (inflated.length !== uncompressedSize) {
    throw new Error(`Invalid zip archive: inflated size mismatch for ${entry.name}`);
  }
  if (crc32(inflated) !== crc) {
    throw new Error(`Invalid zip archive: CRC mismatch for ${entry.name}`);
  }
  return inflated;
}

export async function extractZipArchive(
  options: ExtractZipArchiveOptions
): Promise<ExtractedZipArchive> {
  const maxCompressedBytes = options.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES;
  const maxDeclaredUncompressedBytes =
    options.maxDeclaredUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
  const maxInflatedBytes = options.maxInflatedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
  const archiveStat = await stat(options.zipPath);
  if (archiveStat.size > maxCompressedBytes) {
    throw new Error("Zip archive exceeds compressed byte limit");
  }
  const archive = await readFile(options.zipPath);

  const entries = readCentralDirectory(archive);
  const seen = new Set<string>();
  const seenLowercase = new Set<string>();
  let declaredUncompressedBytes = 0;
  let inflatedBytes = 0;

  try {
    await mkdir(options.destinationRoot, { recursive: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (seen.has(entry.name) || seenLowercase.has(entry.name.toLowerCase())) {
        throw new Error(`Invalid zip archive: duplicate path ${entry.name}`);
      }
      seen.add(entry.name);
      seenLowercase.add(entry.name.toLowerCase());
      declaredUncompressedBytes += entry.uncompressedSize;
      if (declaredUncompressedBytes > maxDeclaredUncompressedBytes) {
        throw new Error("Zip archive exceeds declared uncompressed byte limit");
      }

      const content = await readLocalFile({
        buffer: archive,
        entry,
        maxInflatedBytes: maxInflatedBytes - inflatedBytes,
      });
      inflatedBytes += content.length;
      if (inflatedBytes > maxInflatedBytes) {
        throw new Error("Zip archive exceeds inflated byte limit");
      }

      const outputPath = join(options.destinationRoot, entry.name);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, content);
      files.push(entry.name);
    }
    return { root: options.destinationRoot, files };
  } catch (error) {
    await rm(options.destinationRoot, { recursive: true, force: true });
    throw error;
  }
}
