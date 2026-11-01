/**
 * One-off: regenerate demos/synthetic-flow from the synthetic fixture DB.
 * Usage: node --experimental-strip-types test/make-demo.ts
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { buildFixtureDb } from "./fixtures.ts";

const out = join(import.meta.dirname, "..", "demos", "synthetic-fixture");
rmSync(out, { recursive: true, force: true });
console.log(buildFixtureDb(out));
