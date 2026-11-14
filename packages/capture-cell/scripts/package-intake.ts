import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const pin = "1.3.14";
if (Bun.version !== pin || process.platform !== "linux" || process.arch !== "x64")
  throw new Error(`build needs Linux x64 Bun ${pin}`);
const sourceRef = process.env.CAPTURE_INTAKE_SOURCE_REF;
if (!sourceRef || !/^[0-9a-f]{40}$/u.test(sourceRef))
  throw new Error("CAPTURE_INTAKE_SOURCE_REF must name the reviewed source commit");
const output = process.argv[2];
if (!output) throw new Error("usage: bun scripts/package-intake.ts <new-output-directory>");
const root = resolve(import.meta.dir, "..");
const destination = resolve(output);
mkdirSync(destination); // refuse to overwrite any existing deliverable
const stage = join(destination, "capture-intake");
mkdirSync(join(stage, "bin"), { recursive: true });
async function bundle(entry: string, outfile: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    outdir: stage,
    naming: outfile,
    target: "bun",
    minify: true,
    sourcemap: "none",
  });
  if (!result.success) throw new Error(`bundle failed: ${result.logs.map(String).join("; ")}`);
}
await bundle("src/intake/cli.ts", "capture-intake.js");
await bundle("scripts/intake-smoke.ts", "smoke.js");
copyFileSync(process.execPath, join(stage, "bin", "bun"));
chmodSync(join(stage, "bin", "bun"), 0o755);
for (const name of ["capture-intake.service", "env.example", "README.md"])
  copyFileSync(join(root, "systemd", name), join(stage, name));
writeFileSync(join(stage, "BUN_VERSION"), `${pin}\n`);
writeFileSync(join(stage, "SOURCE_COMMIT"), `${sourceRef}\n`);
const entries = [
  "SOURCE_COMMIT",
  "BUN_VERSION",
  "bin/bun",
  "capture-intake.js",
  "smoke.js",
  "capture-intake.service",
  "env.example",
  "README.md",
];
function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
writeFileSync(
  join(stage, "SHA256SUMS"),
  entries.map((name) => `${hash(join(stage, name))}  ${name}\n`).join(""),
);
const archive = join(destination, `capture-intake-bun-${pin}-linux-x64.tar.gz`);
const tar = Bun.spawn(
  [
    "tar",
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "-czf",
    archive,
    "-C",
    stage,
    ".",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await tar.exited) !== 0) throw new Error("tar failed");
const sha256 = hash(archive);
writeFileSync(`${archive}.sha256`, `${sha256}  ${basename(archive)}\n`);
console.log(
  JSON.stringify({
    archive,
    sha256,
    source_ref: sourceRef,
    bun_version: pin,
    bun_sha256: hash(join(stage, "bin", "bun")),
  }),
);
