import { scoreManifest, validateManifest } from "./acm.js";
import { buildDistributionReadiness } from "./standards.js";

export function buildManifestFromOnboarding(input = {}) {
  const domain = clean(input.domain);
  const namespace = clean(input.namespace);
  const baseUrl = clean(input.baseUrl).replace(/\/$/, "");
  const protocol = clean(input.protocol) || "rest";
  const capabilityId = clean(input.capabilityId);
  const publisherName = clean(input.publisherName);
  const serviceName = clean(input.serviceName);
  const capabilityDescription = clean(input.capabilityDescription);
  const tags = clean(input.tags)
    .split(",")
    .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter(Boolean);

  return {
    acmVersion: "0.1.0",
    namespace,
    name: serviceName,
    summary: clean(input.summary),
    publisher: {
      name: publisherName,
      domain,
      did: domain ? `did:web:${domain}` : "",
      contact: clean(input.contact)
    },
    capabilities: [
      {
        id: capabilityId,
        name: serviceName,
        description: capabilityDescription,
        tags,
        inputSchema: {
          type: "object",
          required: ["request"],
          properties: {
            request: {
              type: "string",
              description: "Natural-language or structured request from the calling agent."
            }
          }
        },
        outputSchema: {
          type: "object",
          required: ["result"],
          properties: {
            result: {
              type: "string",
              description: "Business response returned to the calling agent."
            }
          }
        },
        execution: {
          method: "POST",
          path: `/v1/capabilities/${capabilityId}/invoke`,
          mode: clean(input.pricingModel) === "quote" ? "quote" : "workflow",
          requiresConfirmation: clean(input.pricingModel) !== "free",
          idempotencyKeyRequired: clean(input.pricingModel) !== "free"
        },
        examples: [
          {
            intent: `Ask ${publisherName || "the business"} to ${capabilityDescription.toLowerCase() || "complete this capability"}`,
            input: {
              request: "Example agent request goes here."
            }
          }
        ],
        mediaTypes: ["application/json"]
      }
    ],
    pricing: {
      model: clean(input.pricingModel) || "usage",
      currency: "USD",
      plans: [
        {
          name: "Default plan",
          price: Number(input.pricePerRequest ?? 0),
          unit: "request"
        }
      ]
    },
    trust: {
      verificationStatus: "self-attested",
      credentials: [],
      reputation: {
        score: 0,
        transactionCount: 0,
        disputeRate: 0
      }
    },
    endpoints: {
      baseUrl,
      manifestUrl: domain ? `https://${domain}/.well-known/agent-capabilities.json` : "",
      protocols: [
        {
          type: protocol,
          url: protocol === "rest" ? `${baseUrl}/v1` : baseUrl
        }
      ],
      auth: {
        type: clean(input.authType) || "apiKey"
      },
      rateLimits: {
        requestsPerMinute: Number(input.requestsPerMinute ?? 60)
      },
      sla: {
        availability: Number(input.availability ?? 99.5),
        p95LatencyMs: Number(input.p95LatencyMs ?? 500)
      }
    }
  };
}

export function buildOnboardingResult(input = {}) {
  const manifest = buildManifestFromOnboarding(input);
  const validation = validateManifest(manifest);
  const score = scoreManifest(manifest);
  const distribution = buildDistributionReadiness(manifest);

  return {
    accepted: validation.valid,
    validation,
    score,
    distribution,
    manifest,
    nextSteps: validation.valid
      ? [
          "Backend ACM package is ready for publishing.",
          `Distribution readiness score: ${distribution.distributionScore}/100.`,
          "Publish it at your domain's /.well-known/agent-capabilities.json URL.",
          "Use the generated MCP, A2A, and ARD mappings to avoid standard lock-in.",
          "Submit the domain for registry verification."
        ]
      : [
          "Fix the required business and capability fields.",
          "Generate again until the ACM passes validation."
        ]
  };
}

function clean(value) {
  return String(value ?? "").trim();
}
