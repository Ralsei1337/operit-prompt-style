#!/usr/bin/env node
/**
 * 打包脚本：把 manifest / dist / 文档 打成 .toolpkg（ZIP，manifest 位于根目录）。
 *
 * 打包前会做三项校验：
 *   1. manifest.json 可解析，且 main / subpackages[].entry 指向真实存在的文件；
 *   2. dist/main.js 导出了 registerToolPkg；
 *   3. 产物在本目录之外，避免把自身打进包里。
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const INCLUDE = [
  "manifest.json",
  "dist/main.js",
  "dist/tools/style_tools.js",
  "README.md",
  "docs/DESIGN.md",
  "docs/RUNTIME-FACTS.md",
  "docs/STYLE-GUIDE.md",
  "LICENSE",
];

function fail(message) {
  console.error("打包失败：" + message);
  process.exit(1);
}

const manifestPath = path.join(root, "manifest.json");
if (!fs.existsSync(manifestPath)) fail("缺少 manifest.json");

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail("manifest.json 不是合法 JSON：" + error.message);
}

for (const field of ["toolpkg_id", "version", "main", "api_version"]) {
  if (typeof manifest[field] !== "string" || manifest[field].trim() === "") {
    fail("manifest 缺少字段 " + field);
  }
}
if (manifest.api_version !== "2.0.0") fail("api_version 必须是 2.0.0");
if (manifest.schema_version !== 1) fail("schema_version 必须是 1");

const entryFiles = [manifest.main];
for (const sub of manifest.subpackages ?? []) {
  if (typeof sub.entry !== "string") fail("子包 " + sub.id + " 缺少 entry");
  entryFiles.push(sub.entry);
}

for (const rel of INCLUDE) {
  if (!fs.existsSync(path.join(root, rel))) fail("缺少打包文件 " + rel);
}

// 入口必须真的导出 registerToolPkg，否则装上也注册不出钩子。
const mainSource = fs.readFileSync(path.join(root, manifest.main), "utf8");
if (!/exports\.registerToolPkg\s*=/.test(mainSource)) {
  fail(manifest.main + " 没有导出 registerToolPkg");
}
for (const sub of manifest.subpackages ?? []) {
  const subSource = fs.readFileSync(path.join(root, sub.entry), "utf8");
  if (!/METADATA/.test(subSource)) fail(sub.entry + " 缺少 METADATA 块");
}

const artifactsDir = path.join(root, "artifacts");
fs.mkdirSync(artifactsDir, { recursive: true });
const outPath = path.join(artifactsDir, `${manifest.toolpkg_id}-${manifest.version}.toolpkg`);

/* ---------- 极简 ZIP 写入（deflate + CRC32），避免额外依赖 ---------- */

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

const localChunks = [];
const centralChunks = [];
let offset = 0;

for (const rel of INCLUDE) {
  const data = fs.readFileSync(path.join(root, rel));
  const compressed = deflateRawSync(data, { level: 9 });
  const nameBuf = Buffer.from(rel.replace(/\\/g, "/"), "utf8");
  const crc = crc32(data);
  const isUtf8 = /[^\x00-\x7F]/.test(rel) ? 0x0800 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(isUtf8, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  localChunks.push(local, nameBuf, compressed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(isUtf8, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);
  centralChunks.push(central, nameBuf);

  offset += local.length + nameBuf.length + compressed.length;
}

const centralBuf = Buffer.concat(centralChunks);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(INCLUDE.length, 8);
end.writeUInt16LE(INCLUDE.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

fs.writeFileSync(outPath, Buffer.concat([...localChunks, centralBuf, end]));

const size = fs.statSync(outPath).size;
console.log(`已生成 ${path.relative(root, outPath)}  (${size} bytes, ${INCLUDE.length} 个文件)`);
