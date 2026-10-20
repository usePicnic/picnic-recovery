import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const sections = new Map();
for (const [path, meta] of Object.entries(lock.packages)) {
  if (!path || meta.dev || !existsSync(`${path}/package.json`)) continue;
  const pkg = JSON.parse(readFileSync(`${path}/package.json`, "utf8"));
  const key = `${pkg.name}@${pkg.version}`;
  if (sections.has(key)) continue;
  const files = readdirSync(path).filter(n => /^(licen[sc]e|copying|notice)(\.|$)/i.test(n));
  sections.set(key, [`${key} (${pkg.license ?? "See upstream package"})`, ...files.map(n => readFileSync(`${path}/${n}`, "utf8"))].join("\n\n"));
}
writeFileSync("docs/THIRD_PARTY_LICENSES.txt", [...sections.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v).join("\n\n---\n\n").split(/\r?\n/).map(l => l.trimEnd()).join("\n").trimEnd() + "\n");
console.log(`Notices for ${sections.size} installed production dependencies`);
