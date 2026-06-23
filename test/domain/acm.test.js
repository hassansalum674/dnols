import test from "node:test";
import assert from "node:assert/strict";
import {
  loadManifests,
  searchManifests,
  toA2aAgentCard,
  toMcpServerManifest,
  validateManifest
} from "../../src/domain/acm.js";

test("seed manifests are valid", async () => {
  const records = await loadManifests("data/manifests");

  assert.equal(records.length, 3);
  for (const record of records) {
    assert.equal(record.validation.valid, true, record.validation.errors.join(", "));
    assert.ok(record.score.score >= 70);
  }
});

test("validator rejects missing required fields", () => {
  const result = validateManifest({
    acmVersion: "0.1.0"
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("namespace")));
  assert.ok(result.errors.some((error) => error.includes("capabilities")));
});

test("search ranks matching business capabilities", async () => {
  const records = await loadManifests("data/manifests");
  const results = searchManifests(records, "procurement compliance", {
    verified: "true"
  });

  assert.ok(results.length >= 2);
  assert.equal(results[0].trust.verificationStatus, "verified");
  assert.ok(results.some((result) => result.namespace === "io.saasguard.security"));
});

test("adapter projections expose agent protocol shapes", async () => {
  const records = await loadManifests("data/manifests");
  const manifest = records.find(
    (record) => record.manifest.namespace === "io.saasguard.security"
  ).manifest;

  const mcp = toMcpServerManifest(manifest);
  const a2a = toA2aAgentCard(manifest);

  assert.equal(mcp.name, "io.saasguard.security");
  assert.ok(mcp.tools.length > 0);
  assert.equal(a2a.provider.organization, "SaaSGuard");
  assert.ok(a2a.skills.length > 0);
});
