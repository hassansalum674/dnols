# Agent Discovery Registry MVP

This is a startup MVP for the idea in the strategic memo: a business-to-agent onboarding and distribution layer where companies become discoverable by AI agents across competing standards.

The competitive posture is deliberate: ACM is not treated as a proprietary standard bet. It is the internal normalization format that lets a business onboard once and publish outward as ACM, MCP, A2A, ARD-style resource metadata, REST discovery, and crawlable registry data.

The first product wedge is intentionally focused:

- An open ACM manifest shape for agent-ready business services.
- A guided onboarding flow so companies answer business questions while the backend builds our standard ACM format.
- Automated Layer 1 generation from public website metadata into an ACM draft.
- A validator and readiness score for onboarding businesses.
- A searchable registry API.
- Public crawlable registry indexes for AI agents.
- Self-serve payment handoff through configurable Stripe Payment Links.
- Domain discovery via `/.well-known/agent-capabilities.json` and a simulated `_agent` DNS TXT record.
- MCP, A2A, and ARD-style adapter projections from the same manifest.
- Executable capability planning and safe demo invocation.
- A web demo that makes the concept easy to show.

## Quick Start

Requirements: Node.js 20 or newer. No external npm dependencies are required.

```bash
npm start
```

Open `http://localhost:3000`.

Validate the seed catalog:

```bash
npm run validate
```

Run tests:

```bash
npm test
```

## Render Backend

Dnols uses Firebase Hosting for the static dashboard and a Render Node service for server-only API work. Render should use:

```text
Runtime: Node
Root Directory: empty
Build Command: npm install
Start Command: npm start
```

The backend reads `process.env.PORT`, exposes health checks at:

```http
GET /health
GET /api/health
```

Server-only features:

```http
POST /api/agent-chat
POST /api/business-email/start
POST /api/business-email/verify
POST /api/email-verification/request
POST /api/email-verification/confirm
```

Set these Render environment variables as needed:

```bash
NODE_ENV=production
# Primary low-cost AI provider (preferred). Used first when set.
GROQ_API_KEY=...
GROQ_MODEL=llama-3.1-8b-instant
# Second AI provider. Used only if Groq is unset or fails.
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash-lite
# Final fallback AI provider. Used only if Groq and Gemini are unset or fail.
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-3-5-haiku-20241022
ANTHROPIC_MAX_TOKENS=1000
RESEND_API_KEY=...
RESEND_FROM_EMAIL=...
RESEND_FROM_NAME=Dnols
BUSINESS_EMAIL_VERIFICATION_SECRET=...
# Required for server-side Firebase Auth password reset completion.
FIREBASE_PROJECT_ID=dnols-2a394
GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/firebase-service-account.json
AT_API_KEY=...
AT_USERNAME=sandbox
AT_SENDER_ID=DNOLS
AT_ENV=sandbox
# Founder/admin personal phone for management SMS summaries.
FOUNDER_PHONE=+255712000000
# Optional persisted SMS deal store. Without this, the service uses memory.
DEAL_STORE_BACKEND=firestore
# Optional in-process reminder loop. Prefer Render Cron for production.
SMS_REMINDER_INTERVAL_ENABLED=false
SMS_REMINDER_INTERVAL_MS=900000
```

Never put these values in `public/` files or commit them. The browser calls the backend; the backend calls Claude, Resend, and Africa's Talking.

Password reset completion updates Firebase Auth through the Admin SDK on the Render backend after the business-email code is verified. If `firebase-admin` or the Firebase project/service account environment is missing, `/api/password-reset/complete` returns a safe 503 and does not update the password.

## SMS Deal Notifications

SMS notifications run on the Render backend, not Firebase Hosting. All messages use sender ID `DNOLS`, plain ASCII text, and templates capped at 160 characters.

Configure Africa's Talking inbound SMS callback to:

```text
https://<render-service-host>/api/sms/webhook
```

Africa's Talking sends `application/x-www-form-urlencoded` fields such as `from`, `to`, `text`, `linkId`, `id`, and `date`. The backend resolves `linkId` or `dealId` first, then falls back to the sender phone index. Replies are processed by phone role: buyer phones can send buyer actions such as `PAID`, and seller phones can send seller actions such as `YES`, `NO`, or `COUNTER`.

Server SMS endpoints:

```http
POST /api/sms/notify
POST /api/sms/webhook
POST /api/sms/run-reminders
POST /api/sms/run-fee-reminders
```

Start and persist a new deal, then send the seller the first request SMS:

```json
{
  "event": "new_deal",
  "deal": {
    "dealId": "DL-1001",
    "buyer": { "name": "Buyer", "phone": "+255712345678" },
    "seller": { "name": "Seller", "phone": "+255798765432" },
    "serviceDescription": "Freight Dar to Nairobi",
    "amount": 1500,
    "deadline": "2026-07-30"
  }
}
```

When `FOUNDER_PHONE` is configured, every deal event also sends a separate `DNOLS ADMIN` management summary to the founder: new deal, stalled/no-response reminder, deal closed, and other deal updates. `POST /api/sms/run-reminders` scans active deals and sends the 2-hour reminder SMS to businesses plus a founder stalled-deal summary when due. `POST /api/sms/run-fee-reminders` scans completed deals and sends the founder a fee-unpaid summary after 24 hours if `feeCollectionStatus` is still pending. Use Render Cron or another external scheduler to call reminder endpoints. For development only, set `SMS_REMINDER_INTERVAL_ENABLED=true` to run the 2-hour interval in-process.

The default deal store is in-memory. For production persistence, install/configure `firebase-admin` in the Render service environment and set `DEAL_STORE_BACKEND=firestore` with `FIREBASE_PROJECT_ID` or `GOOGLE_APPLICATION_CREDENTIALS`. The Admin SDK writes server-only `deals` and `dealPhoneIndex` collections; Firestore client rules deny direct browser access.

The business password reset flow also uses the Render service after the emailed 8-character code is verified. To complete password updates server-side, install/configure `firebase-admin` for the Render service and provide `FIREBASE_PROJECT_ID` plus Application Default Credentials via `GOOGLE_APPLICATION_CREDENTIALS`, or provide `FIREBASE_SERVICE_ACCOUNT_JSON` as a secret environment variable. If Admin SDK credentials are absent, the reset code verification still works but the final password update endpoint returns a generic configuration error.

## Risk Controls

Dnols includes code-level safeguards for high-risk deal flows:

- New or unverified sellers remain under manual review during the first 7 days and first 3 completed deals.
- Deal requests are limited to 5/day in browser-visible flows and carry risk metadata for reviewers.
- Deals above the configured hard max deal value cannot be auto-approved; AI fallback output is also clamped.
- SMS replies must include a deal ref when a sender has multiple active deals, and refs must match the sender phone.
- Counter-offer loops are capped at 3 rounds, then escalated for human handling.
- SMS failures or skipped provider delivery create dashboard fallback entries on the stored deal notification log.

Code does not replace real-world controls. Business/KYC verification, payment licensing decisions, disputes/refunds, backup operators, and provider outage monitoring still need operational and legal runbooks.

## Product Surfaces

### Guided Business Onboarding

Businesses should not submit their own custom manifest format. In the product UI they answer a short guided flow:

```text
Open http://localhost:3000
Go to Create Manifest
Step 1: Business identity
Step 2: Agent capability
Step 3: API access and pricing
Step 4: Review and submit
```

On submit, the backend:

- Normalizes the answers into the ACM structure.
- Validates the generated manifest.
- Scores agent-readiness.
- Returns next steps for publishing or registry review.

For integrations and technical users, the backend endpoint is:

```http
POST /api/build-manifest
Content-Type: application/json

{ ...business onboarding answers... }
```

There is also a developer-facing blank JSON template at:

```http
GET /schemas/acm.template.json
```

### Automated Website Generation

Layer 1 can draft an ACM from public website data:

```http
POST /api/generate-from-website
Content-Type: application/json

{
  "websiteUrl": "https://example.com"
}
```

The backend fetches the public HTML, extracts title, meta description, headings, useful API/pricing/contact links, infers tags, builds the ACM draft, validates it, and returns the manifest package. The UI exposes this as **Start from a public website** above the onboarding wizard.

### Self-Serve Payments

The MVP uses Stripe Payment Links so the product does not need invoice handling or card storage.

```http
GET /api/plans
POST /api/checkout
Content-Type: application/json

{
  "planId": "professional"
}
```

Set these environment variables for live checkout:

```bash
STRIPE_BASIC_PAYMENT_LINK=https://buy.stripe.com/...
STRIPE_PRO_PAYMENT_LINK=https://buy.stripe.com/...
STRIPE_ENTERPRISE_PAYMENT_LINK=https://buy.stripe.com/...
```

If they are not set, checkout goes to a local demo page so the flow still works.

### Web Demo

The landing page explains the product, shows the registry, and lets you search by capability, vertical, protocol, or verification status.

### Business Dashboard Settings

Signed-in businesses can manage account settings from `/dashboard`:

- Appearance: system, dark, or light theme saved to the account and browser.
- Account: business name, team email, approval email, plan/status, and password reset.
- Notifications: primary channel plus deal, approval, and weekly summary preferences.
- Product updates: current MVP version and recent platform changes.
- Data and privacy: public registry status and a safe profile JSON export that excludes private floor prices and internal rules.

### Registry API

```http
GET /api/manifests?q=procurement
GET /api/manifests?protocol=mcp&verified=true
GET /api/manifests/:namespace
```

### Capability Execution

Discovery tells an agent who can do something. Execution tells it how to actually ask the business to do it.

Each ACM capability can include:

- `method`: HTTP method such as `POST`.
- `path`: business API path such as `/v1/rfqs`.
- `mode`: `read`, `quote`, `transaction`, or `workflow`.
- `requiresConfirmation`: whether approval is required before live execution.
- `idempotencyKeyRequired`: whether write actions need a unique request ID.

Agents can call the MVP execution endpoint:

```http
POST /api/execute/:namespace/:capabilityId
Content-Type: application/json

{
  "input": {
    "category": "concrete-barriers",
    "quantity": 120,
    "deliveryLocation": "Riyadh"
  }
}
```

For demo `.example` businesses, this returns a simulated result plus the exact live API call plan. For real businesses, the same route can proxy a live call when `allowLiveExecution` and the required business credentials are supplied.

Execution does not require an LLM API key by default. The AI agent already has its own model/runtime. Our platform only needs:

- business API credentials when calling a real business API;
- payment credentials for Stripe Payment Links if collecting listing fees;
- optional LLM API keys later if we want richer AI-powered website-to-ACM generation.

### LLM API Isolation Rules

Any future Claude/OpenAI/Gemini call must go through `src/lib/llm-isolation.js` before sending data to a model. The guard enforces:

- Load one business profile by the verified auth uid, never by a request body `businessId`.
- Never pass all businesses, multiple profiles, or shared cross-business context into one model call.
- Treat deal request text as untrusted input inside `DEAL REQUEST START` / `DEAL REQUEST END` boundaries.
- Do not log full prompts. Store only owner-scoped audit metadata such as purpose, request hash, and character count.

The Firebase Spark deployment still does not run live model calls. This module is the backend safety contract for the API key integration when a trusted server environment is added.

### Multi-Standard Distribution

Each listing can expose a complete distribution package:

```http
GET /api/adapters/mcp/:namespace
GET /api/adapters/a2a/:namespace
GET /api/adapters/ard/:namespace
GET /api/distribution/:namespace
POST /api/execute/:namespace/:capabilityId
```

The distribution package shows the canonical ACM payload, protocol-specific projections, crawlable URLs, strengths, gaps, and a distribution readiness score. This is the hedge against standard-war risk.

### Public Agent Crawl Index

AI agents and crawlers can discover the registry without using the UI:

```http
GET /registry.json
GET /.well-known/agent-registry.json
GET /.well-known/agent-capabilities.json
GET /agents/index.json
GET /agents/com.sanelx.json
GET /robots.txt
GET /sitemap.xml
```

On the Firebase Spark/free version, publishing is static. After reviewing a business profile, add only safe public fields to `data/public-profiles.json`, then run:

```bash
npm run publish:registry
npm run firebase:deploy
```

Do not publish private floor prices, API keys, internal notes, or any secret business rules. The generated public files are meant for crawler discovery and human-approved deal routing.

### Manifest Validation

```http
POST /api/validate
Content-Type: application/json

{ ...agent capability manifest... }
```

The validator returns blocking errors and non-blocking warnings. The scoring logic rewards identity, trust credentials, pricing, examples, SLA metadata, and protocol coverage.

### Domain Discovery

```http
GET /.well-known/agent-capabilities.json?namespace=com.najd.procurement
GET /dns/_agent?domain=najd-procurement.example
```

The DNS endpoint simulates the proposed `_agent.example.com TXT "acm=..."` convention from the memo.

### Protocol Projections

```http
GET /api/adapters/mcp/:namespace
GET /api/adapters/a2a/:namespace
GET /api/adapters/ard/:namespace
```

These endpoints translate one ACM manifest into MCP-style tool metadata, A2A-style Agent Card metadata, and ARD-style resource metadata.

## CLI

```bash
node src/cli.js validate data/manifests
node src/cli.js score data/manifests
node src/cli.js search procurement compliance
```

## MVP Architecture

See `ARCHITECTURE.md` for the current ownership model, migration rules, and target module boundaries. The summary below shows the active MVP entry points.

```text
schemas/acm.schema.json       Open ACM schema draft
schemas/acm.template.json     Developer-facing fill-in template
data/manifests/               Seed business capability manifests
src/domain/                   Pure backend business rules and low-cost LLM capsules
src/services/                 Backend service integrations and execution helpers
src/adapters/                 Protocol projection helpers
src/lib/acm.js                Validation, scoring, search, adapters
src/lib/manifest-builder.js   Backend onboarding-to-ACM builder
src/lib/website-generator.js  Public website-to-ACM generator
src/lib/public-index.js       Crawlable registry index, sitemap, robots
src/lib/payments.js           Self-serve payment plan/checkout helpers
src/lib/standards.js          MCP/A2A/ARD/distribution mapping layer
src/lib/execution.js          Invocation planning and safe execution layer
src/server.js                 Registry API, discovery, static web app
src/cli.js                    Operator/developer CLI
public/                       Demo UI
test/                         Node test coverage
```

## Seed Verticals

- `com.najd.procurement`: procurement RFQs and supplier compliance.
- `com.orbit.logistics`: freight quotes and delivery exception tracking.
- `io.saasguard.security`: vendor security evidence and risk scoring.

## Near-Term Startup Roadmap

1. Get 50 real paying businesses in one wedge: procurement/vendor trust.
2. Add persisted manifest submission after checkout.
3. Persist manifests and payment status in a database instead of local JSON files.
4. Add hosted manifest URLs and namespace ownership checks.
5. Build a real MCP server that exposes registry search as tools.
6. Add customer-facing verification workflow and evidence upload.
7. Track ARD/MCP/A2A spec changes and update mappings quickly.

## What Is Deliberately Not Included Yet

This MVP does not implement DIDs, Verifiable Credentials, full payment reconciliation, enterprise middleware connectors, or real DNS automation. Those are later layers. The first milestone is proving that the standard, registry, validation loop, automated website draft generation, crawlable index, and checkout handoff are coherent and demoable.
# new-dnols
