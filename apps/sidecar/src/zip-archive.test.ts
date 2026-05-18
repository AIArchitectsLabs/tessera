import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { extractZipArchive } from "./zip-archive.js";

const tempRoots: string[] = [];
let zipIndex = 0;
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

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

interface ZipEntry {
  name: string;
  content?: string;
  method?: 0 | 8;
  crc?: number;
  localName?: string;
  externalAttributes?: number;
  declaredUncompressedSize?: number;
  flags?: number;
  centralMethod?: number;
  forceZip64Size?: boolean;
}

function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = Buffer.from(entry.content ?? "", "utf8");
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name, "utf8");
    const localName = Buffer.from(entry.localName ?? entry.name, "utf8");
    const crc = entry.crc ?? crc32(raw);
    const uncompressedSize = entry.declaredUncompressedSize ?? raw.length;

    const local = Buffer.alloc(30 + localName.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(localName.length, 26);
    localName.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(entry.centralMethod ?? method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.forceZip64Size ? 0xffffffff : compressed.length, 20);
    central.writeUInt32LE(entry.forceZip64Size ? 0xffffffff : uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

async function writeZip(root: string, entries: ZipEntry[]): Promise<string> {
  zipIndex += 1;
  const zipPath = join(root, `archive-${zipIndex}.zip`);
  await writeFile(zipPath, makeZip(entries));
  return zipPath;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("extractZipArchive", () => {
  test("extracts minimal stored and deflated files", async () => {
    const root = await makeRoot("tessera-zip-");
    const zipPath = await writeZip(root, [
      { name: "manifest.json", content: "{}" },
      { name: "scripts/run.ts", content: "export default 1;\n", method: 8 },
    ]);
    const destinationRoot = join(root, "out");

    await expect(extractZipArchive({ zipPath, destinationRoot })).resolves.toMatchObject({
      files: ["manifest.json", "scripts/run.ts"],
    });
    await expect(readFile(join(destinationRoot, "scripts/run.ts"), "utf8")).resolves.toBe(
      "export default 1;\n"
    );
  });

  test("accepts a single top-level folder entry", async () => {
    const root = await makeRoot("tessera-zip-");
    const zipPath = await writeZip(root, [
      { name: "pkg/", content: "" },
      { name: "pkg/manifest.json", content: "{}" },
    ]);
    const destinationRoot = join(root, "out");

    await extractZipArchive({ zipPath, destinationRoot });

    await expect(readFile(join(destinationRoot, "pkg/manifest.json"), "utf8")).resolves.toBe("{}");
  });

  test("rejects unsafe and duplicate paths", async () => {
    const root = await makeRoot("tessera-zip-");
    const traversal = await writeZip(root, [{ name: "../manifest.json", content: "{}" }]);
    const drive = await writeZip(root, [{ name: "C:\\tmp\\manifest.json", content: "{}" }]);
    const unc = await writeZip(root, [{ name: "\\\\server\\share\\manifest.json", content: "{}" }]);
    const backslash = await writeZip(root, [{ name: "pkg\\manifest.json", content: "{}" }]);
    const duplicate = await writeZip(root, [
      { name: "manifest.json", content: "{}" },
      { name: "MANIFEST.json", content: "{}" },
    ]);

    await expect(
      extractZipArchive({ zipPath: traversal, destinationRoot: join(root, "traversal") })
    ).rejects.toThrow(/path/i);
    await expect(
      extractZipArchive({ zipPath: drive, destinationRoot: join(root, "drive") })
    ).rejects.toThrow(/path/i);
    await expect(
      extractZipArchive({ zipPath: unc, destinationRoot: join(root, "unc") })
    ).rejects.toThrow(/path/i);
    await expect(
      extractZipArchive({ zipPath: backslash, destinationRoot: join(root, "backslash") })
    ).rejects.toThrow(/path/i);
    await expect(
      extractZipArchive({ zipPath: duplicate, destinationRoot: join(root, "duplicate") })
    ).rejects.toThrow(/duplicate/i);
  });

  test("rejects declared and actual inflated size overflows", async () => {
    const root = await makeRoot("tessera-zip-");
    const declared = await writeZip(root, [
      { name: "manifest.json", content: "{}", declaredUncompressedSize: 100 },
    ]);
    const inflated = await writeZip(root, [{ name: "manifest.json", content: "hello" }]);

    await expect(
      extractZipArchive({
        zipPath: declared,
        destinationRoot: join(root, "declared"),
        maxDeclaredUncompressedBytes: 10,
      })
    ).rejects.toThrow(/declared/i);
    await expect(
      extractZipArchive({
        zipPath: inflated,
        destinationRoot: join(root, "inflated"),
        maxInflatedBytes: 2,
      })
    ).rejects.toThrow(/inflated/i);
  });

  test("rejects compressed byte limit, encrypted entries, zip64, and unsupported methods", async () => {
    const root = await makeRoot("tessera-zip-");
    const compressed = await writeZip(root, [{ name: "manifest.json", content: "{}" }]);
    const encrypted = await writeZip(root, [{ name: "manifest.json", content: "{}", flags: 0x01 }]);
    const zip64 = await writeZip(root, [
      { name: "manifest.json", content: "{}", forceZip64Size: true },
    ]);
    const unsupported = await writeZip(root, [
      { name: "manifest.json", content: "{}", centralMethod: 99 },
    ]);

    await expect(
      extractZipArchive({
        zipPath: compressed,
        destinationRoot: join(root, "compressed"),
        maxCompressedBytes: 1,
      })
    ).rejects.toThrow(/compressed byte limit/i);
    await expect(
      extractZipArchive({ zipPath: encrypted, destinationRoot: join(root, "encrypted") })
    ).rejects.toThrow(/encrypted/i);
    await expect(
      extractZipArchive({ zipPath: zip64, destinationRoot: join(root, "zip64") })
    ).rejects.toThrow(/zip64/i);
    await expect(
      extractZipArchive({ zipPath: unsupported, destinationRoot: join(root, "method") })
    ).rejects.toThrow(/compression method/i);
  });

  test("rejects central-local mismatch, CRC mismatch, and symlinks", async () => {
    const root = await makeRoot("tessera-zip-");
    const mismatch = await writeZip(root, [
      { name: "manifest.json", localName: "other.json", content: "{}" },
    ]);
    const crcMismatch = await writeZip(root, [{ name: "manifest.json", content: "{}", crc: 123 }]);
    const symlink = await writeZip(root, [
      { name: "manifest.json", content: "{}", externalAttributes: (0o120000 * 0x10000) >>> 0 },
    ]);

    await expect(
      extractZipArchive({ zipPath: mismatch, destinationRoot: join(root, "mismatch") })
    ).rejects.toThrow(/mismatch/i);
    await expect(
      extractZipArchive({ zipPath: crcMismatch, destinationRoot: join(root, "crc") })
    ).rejects.toThrow(/CRC/i);
    await expect(
      extractZipArchive({ zipPath: symlink, destinationRoot: join(root, "symlink") })
    ).rejects.toThrow(/symlink/i);
  });

  test("cleans up partial extraction failure", async () => {
    const root = await makeRoot("tessera-zip-");
    const zipPath = await writeZip(root, [
      { name: "ok.txt", content: "ok" },
      { name: "bad.txt", content: "bad", crc: 123 },
    ]);
    const destinationRoot = join(root, "out");
    await mkdir(destinationRoot, { recursive: true });

    await expect(extractZipArchive({ zipPath, destinationRoot })).rejects.toThrow(/CRC/i);

    await expect(readdir(destinationRoot)).rejects.toThrow();
  });
});
