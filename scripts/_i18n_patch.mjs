// One-off helper: insert namespaces before the `empty:` block of en.ts / hi.ts.
import fs from "node:fs";
const [file, chunkFile] = process.argv.slice(2);
const src = fs.readFileSync(file, "utf8");
const chunk = fs.readFileSync(chunkFile, "utf8");
const marker = "\n  empty: {";
if (!src.includes(marker)) throw new Error("marker not found in " + file);
fs.writeFileSync(file, src.replace(marker, "\n" + chunk.trimEnd() + marker));
console.log("patched", file);
