import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("package identity is pi-shell-specialization", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.name, "pi-shell-specialization");
});
