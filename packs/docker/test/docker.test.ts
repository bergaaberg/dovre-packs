/** Docker Pack (`docker`) tests. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { testContext } from "dovre/packs/testing.ts";
import { createDockerPack } from "../index.ts";
import { dockerPage } from "../view.ts";

const H = `<script>alert(1)</script><img src=x onerror=alert(1)>`;

test("docker: parses docker ps JSON lines and escapes hostile container names", async () => {
  const pack = createDockerPack({
    run: async () => ({
      stdout: [
        JSON.stringify({ ID: "abcdef1234567890", Names: "postgres-dev", Image: "postgres:16", State: "running", Status: "Up 2 hours", Ports: "5432/tcp" }),
        JSON.stringify({ ID: "9999991234567890", Names: H, Image: H, State: "exited", Status: H, Ports: "" }),
      ].join("\n"),
      stderr: "",
    }),
  });
  await pack.refresh!(testContext());
  assert.equal(pack.kept()!.containers.length, 2);
  assert.equal(pack.kept()!.containers[0]!.name, "postgres-dev");
  const out = String(await dockerPage(pack.kept()));
  assert.ok(!out.includes("<script>") && !out.includes("<img"));
});
