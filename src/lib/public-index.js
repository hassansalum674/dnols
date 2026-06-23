import { summarizeManifest } from "./acm.js";
import { buildDistributionReadiness } from "./standards.js";

export function buildPublicRegistryIndex(records, origin) {
  const generatedAt = new Date().toISOString();
  const validRecords = records.filter((record) => record.validation.valid);

  return {
    registry: "Agent Discovery Registry MVP",
    acmVersion: "0.1.x",
    generatedAt,
    count: validRecords.length,
    discovery: {
      registryIndex: `${origin}/registry.json`,
      wellKnownRegistry: `${origin}/.well-known/agent-registry.json`,
      sitemap: `${origin}/sitemap.xml`,
      robots: `${origin}/robots.txt`
    },
    manifests: validRecords.map((record) => {
      const summary = summarizeManifest(record.manifest);
      const distribution = buildDistributionReadiness(record.manifest);
      return {
        namespace: summary.namespace,
        name: summary.name,
        summary: summary.summary,
        publisher: summary.publisher,
        tags: summary.tags,
        protocols: (summary.endpoints?.protocols ?? []).map((protocol) => protocol.type),
        executable: (record.manifest.capabilities ?? []).some((capability) => capability.execution),
        trust: summary.trust?.verificationStatus ?? "unverified",
        score: summary.score.score,
        distributionScore: distribution.distributionScore,
        distributionGaps: distribution.gaps,
        urls: {
          manifest: `${origin}/api/manifests/${encodeURIComponent(summary.namespace)}`,
          mcp: `${origin}/api/adapters/mcp/${encodeURIComponent(summary.namespace)}`,
          a2a: `${origin}/api/adapters/a2a/${encodeURIComponent(summary.namespace)}`,
          ard: `${origin}/api/adapters/ard/${encodeURIComponent(summary.namespace)}`,
          distribution: `${origin}/api/distribution/${encodeURIComponent(summary.namespace)}`,
          wellKnown: `${origin}/.well-known/agent-capabilities.json?namespace=${encodeURIComponent(summary.namespace)}`
        }
      };
    })
  };
}

export function buildSitemap(records, origin) {
  const urls = [
    `${origin}/`,
    `${origin}/registry.json`,
    `${origin}/.well-known/agent-registry.json`,
    ...records
      .filter((record) => record.validation.valid)
      .flatMap((record) => {
        const namespace = encodeURIComponent(record.manifest.namespace);
        return [
          `${origin}/api/manifests/${namespace}`,
          `${origin}/api/adapters/mcp/${namespace}`,
          `${origin}/api/adapters/a2a/${namespace}`,
          `${origin}/api/adapters/ard/${namespace}`,
          `${origin}/api/distribution/${namespace}`
        ];
      })
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${escapeXml(url)}</loc></url>`).join("\n")}
</urlset>
`;
}

export function buildRobotsTxt(origin) {
  return `User-agent: *
Allow: /

Sitemap: ${origin}/sitemap.xml
`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
