import { summarizeManifest, toA2aAgentCard, toMcpServerManifest } from "./acm.js";

export function toArdResourceDescriptor(manifest) {
  const summary = summarizeManifest(manifest);
  const baseUrl = summary.endpoints?.baseUrl;

  return {
    ardVersion: "0.1",
    kind: "AgenticResource",
    id: summary.namespace,
    name: summary.name,
    description: summary.summary,
    publisher: {
      name: summary.publisher?.name,
      domain: summary.publisher?.domain,
      did: summary.publisher?.did,
      contact: summary.publisher?.contact
    },
    resources: summary.capabilities.map((capability) => ({
      id: capability.id,
      name: capability.name,
      description: capability.description,
      categories: capability.tags,
      inputSchema: manifest.capabilities.find((item) => item.id === capability.id)?.inputSchema,
      outputSchema: manifest.capabilities.find((item) => item.id === capability.id)?.outputSchema,
      execution: manifest.capabilities.find((item) => item.id === capability.id)?.execution,
      invoke: {
        url: baseUrl,
        auth: summary.endpoints?.auth,
        protocols: summary.endpoints?.protocols ?? []
      }
    })),
    commerce: summary.pricing,
    trust: summary.trust,
    discovery: {
      canonicalManifest: summary.endpoints?.manifestUrl,
      namespace: summary.namespace,
      tags: summary.tags
    }
  };
}

export function buildDistributionPackage(manifest, origin = "") {
  const namespace = manifest.namespace;
  const encodedNamespace = encodeURIComponent(namespace);
  const localUrl = (path) => (origin ? `${origin}${path}` : path);

  return {
    namespace,
    positioning:
      "ACM is the normalization layer. Businesses onboard once, then publish across MCP, A2A, ARD, REST, and crawlable registry surfaces.",
    readiness: buildDistributionReadiness(manifest),
    formats: {
      acm: {
        label: "Canonical ACM",
        url: localUrl(`/api/manifests/${encodedNamespace}`),
        payload: manifest
      },
      mcp: {
        label: "MCP Tool Metadata",
        url: localUrl(`/api/adapters/mcp/${encodedNamespace}`),
        payload: toMcpServerManifest(manifest)
      },
      a2a: {
        label: "A2A Agent Card",
        url: localUrl(`/api/adapters/a2a/${encodedNamespace}`),
        payload: toA2aAgentCard(manifest)
      },
      ard: {
        label: "ARD-Style Resource Descriptor",
        url: localUrl(`/api/adapters/ard/${encodedNamespace}`),
        payload: toArdResourceDescriptor(manifest)
      }
    },
    crawlable: {
      registry: localUrl("/registry.json"),
      wellKnownRegistry: localUrl("/.well-known/agent-registry.json"),
      sitemap: localUrl("/sitemap.xml"),
      robots: localUrl("/robots.txt")
    }
  };
}

export function buildDistributionReadiness(manifest) {
  const protocols = new Set((manifest.endpoints?.protocols ?? []).map((protocol) => protocol.type));
  const gaps = [];
  const strengths = [];

  if (protocols.has("mcp")) {
    strengths.push("MCP exposure available.");
  } else {
    gaps.push("Add native MCP endpoint for Claude/Cursor-style tool discovery.");
  }

  if (protocols.has("a2a")) {
    strengths.push("A2A exposure available.");
  } else {
    gaps.push("Add A2A Agent Card endpoint for agent-to-agent ecosystems.");
  }

  if (manifest.endpoints?.manifestUrl) {
    strengths.push("Domain-owned well-known manifest URL is present.");
  } else {
    gaps.push("Publish manifest at /.well-known/agent-capabilities.json.");
  }

  if (manifest.trust?.verificationStatus === "verified") {
    strengths.push("Verified trust status improves agent selection.");
  } else {
    gaps.push("Complete business verification to improve agent selection.");
  }

  strengths.push("ARD-style descriptor can be generated from ACM.");

  return {
    strengths,
    gaps,
    distributionScore: Math.max(0, 100 - gaps.length * 15)
  };
}
