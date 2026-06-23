import test from "node:test";
import assert from "node:assert/strict";
import { loadManifests } from "../../src/domain/acm.js";
import { toArdResourceDescriptor } from "../../src/adapters/ard.js";
import { buildDistributionPackage } from "../../src/adapters/distribution.js";
import { buildPublicRegistryIndex, buildRobotsTxt, buildSitemap } from "../../src/services/public-index.js";
import { createCheckout, listPlans } from "../../src/services/payments.js";
import { buildInvocationPlan, executeCapability } from "../../src/services/execution.js";

test("public registry index exposes crawlable manifest URLs", async () => {
  const records = await loadManifests("data/manifests");
  const index = buildPublicRegistryIndex(records, "https://registry.example");
  const sitemap = buildSitemap(records, "https://registry.example");
  const robots = buildRobotsTxt("https://registry.example");

  assert.equal(index.count, 3);
  assert.ok(index.manifests[0].urls.manifest.startsWith("https://registry.example/api/manifests/"));
  assert.ok(sitemap.includes("<urlset"));
  assert.ok(robots.includes("Sitemap: https://registry.example/sitemap.xml"));
});

test("payment plans support self-serve checkout links", () => {
  const plans = listPlans();
  const checkout = createCheckout("professional", "https://registry.example");

  assert.equal(plans.length, 3);
  assert.equal(checkout.ok, true);
  assert.ok(checkout.checkoutUrl.includes("checkout-demo.html") || checkout.checkoutUrl.startsWith("https://"));
});

test("distribution package maps ACM to MCP, A2A, and ARD-style formats", async () => {
  const records = await loadManifests("data/manifests");
  const manifest = records.find(
    (record) => record.manifest.namespace === "io.saasguard.security"
  ).manifest;
  const ard = toArdResourceDescriptor(manifest);
  const distribution = buildDistributionPackage(manifest, "https://registry.example");

  assert.equal(ard.kind, "AgenticResource");
  assert.equal(ard.id, "io.saasguard.security");
  assert.ok(ard.resources.length > 0);
  assert.ok(distribution.formats.mcp.url.includes("/api/adapters/mcp/"));
  assert.ok(distribution.formats.a2a.url.includes("/api/adapters/a2a/"));
  assert.ok(distribution.formats.ard.url.includes("/api/adapters/ard/"));
  assert.ok(distribution.readiness.distributionScore > 0);
});

test("execution planner builds callable API details and demo result", async () => {
  const records = await loadManifests("data/manifests");
  const manifest = records.find(
    (record) => record.manifest.namespace === "com.najd.procurement"
  ).manifest;
  const input = {
    category: "concrete-barriers",
    quantity: 120,
    deliveryLocation: "Riyadh"
  };
  const plan = buildInvocationPlan(manifest, "request-supplier-quotes", input);
  const execution = await executeCapability(manifest, "request-supplier-quotes", input);

  assert.equal(plan.ok, true);
  assert.equal(plan.request.method, "POST");
  assert.ok(plan.request.endpoint.endsWith("/v1/rfqs"));
  assert.equal(execution.mode, "demo");
  assert.ok(execution.result.quotes.length > 0);
});
