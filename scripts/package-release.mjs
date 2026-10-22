import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Commit source before packaging a release");
const walk = path => readdirSync(path).sort().flatMap(name => { const p = `${path}/${name}`; return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = [...walk("dist"), "README.md", "LICENSE", "NOTICE.md", "scripts/serve.mjs", ...walk("docs")].sort();
const entries = files.map(name => ({ name, data: readFileSync(name) }));
entries.push({ name: "BUILD.json", data: Buffer.from(JSON.stringify({ commit, files: Object.fromEntries(entries.map(e => [e.name, createHash("sha256").update(e.data).digest("hex")])) }, null, 2) + "\n") });
const chunks = [];
for (const { name, data } of entries) {
  if (Buffer.byteLength(name) > 100) throw new Error(`Tar path too long: ${name}`);
  const h = Buffer.alloc(512);
  const octal = (offset, length, value) => h.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length);
  h.write(name); octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, data.length); octal(136, 12, 0);
  h.fill(32, 148, 156); h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263);
  const checksum = h.reduce((a, b) => a + b, 0); h.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  chunks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
}
chunks.push(Buffer.alloc(1024));
mkdirSync("artifacts", { recursive: true });
const name = `picnic-recovery-${commit.slice(0, 12)}.tar.gz`;
const archive = gzipSync(Buffer.concat(chunks), { level: 9 });
writeFileSync(`artifacts/${name}`, archive);
writeFileSync(`artifacts/${name}.sha256`, `${createHash("sha256").update(archive).digest("hex")}  ${name}\n`);
console.log(`artifacts/${name}`);
