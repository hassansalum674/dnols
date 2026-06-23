import test from "node:test";
import assert from "node:assert/strict";
import { buildOnboardingResult } from "../../src/services/manifest-builder.js";
import { extractWebsiteProfile } from "../../src/services/website-generator.js";

test("backend onboarding builder creates a valid ACM manifest", () => {
  const result = buildOnboardingResult({
    publisherName: "Acme Industrial Supply",
    domain: "acme-industrial.example",
    namespace: "com.acme.industrial",
    contact: "agents@acme-industrial.example",
    serviceName: "Industrial Parts Availability",
    summary:
      "Agent-ready inventory lookup for industrial parts, live availability, supplier substitutions, and fulfillment windows.",
    capabilityId: "check-parts-availability",
    capabilityDescription:
      "Check whether requested industrial parts are available, identify approved substitutes, and return estimated delivery dates.",
    tags: "inventory, procurement, industrial-parts",
    baseUrl: "https://api.acme-industrial.example",
    protocol: "rest",
    authType: "apiKey",
    pricingModel: "usage"
  });

  assert.equal(result.accepted, true);
  assert.equal(result.manifest.namespace, "com.acme.industrial");
  assert.equal(result.manifest.capabilities[0].id, "check-parts-availability");
  assert.equal(result.validation.valid, true);
});

test("website profile extraction infers onboarding fields from public HTML", () => {
  const profile = extractWebsiteProfile(
    "https://example-security.com",
    `<!doctype html>
    <title>Example Security Platform</title>
    <meta name="description" content="Security compliance evidence, vendor risk scoring, and procurement readiness for enterprise software.">
    <h1>Automate vendor security reviews</h1>
    <a href="/docs/api">API docs</a>
    <a href="/pricing">Pricing</a>`
  );

  assert.equal(profile.domain, "example-security.com");
  assert.equal(profile.pricingModel, "subscription");
  assert.ok(profile.tags.includes("security"));
  assert.ok(profile.baseUrl.includes("/docs/api"));
});
