import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
rmSync(new URL("dist/", root), { recursive: true, force: true });
const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [compiler], {
  cwd: fileURLToPath(root),
  stdio: "inherit",
});
if (result.error) console.error("Could not start the TypeScript compiler.");
process.exitCode = result.status ?? 1;
