# Dnols Firebase Deploy

Firebase project / Hosting site:

```text
dnols-2a394
```

Hosting domains:

```text
dnols-2a394.web.app
dnols-2a394.firebaseapp.com
dnols.com
```

## 1. Install Firebase CLI

```bash
npm install -g firebase-tools
```

## 2. Login

```bash
npm run firebase:login
```

Or directly:

```bash
firebase login
```

## 3. Select Your Firebase Project

After login, select the Firebase project:

```text
dnols-2a394
```

```bash
npm run firebase:use
```

Or directly:

```bash
firebase use --add
```

Give it the alias `default`.

This creates a local `.firebaserc` file with:

```json
{
  "projects": {
    "default": "dnols-2a394"
  }
}
```

## 4. Preview Locally

```bash
npm run firebase:serve
```

Open the local Hosting URL that Firebase prints.

## 5. Deploy Free Hosting + Firestore Rules

Before deploying after profile approvals, regenerate the public registry files:

```bash
npm run publish:registry
```

This reads approved entries from `data/public-profiles.json` and updates:

- `public/registry.json`
- `public/agents/index.json`
- `public/agents/{namespace}.json`
- `public/sitemap.xml`
- `public/robots.txt`

See `public/GENERATED.md` for generated file ownership and safety rules.

Publishing is still an admin-reviewed static workflow on the Spark/free architecture:

- Dashboard `pending_review` means the owner requested review.
- `data/public-profiles.json` is the reviewed public source.
- The publish script rejects private agent rules, execution secrets, and private minimum prices before writing public registry files.

```bash
npm run firebase:deploy
```

Or directly:

```bash
firebase deploy --only hosting,firestore:rules
```

If you prefer passing the project explicitly:

```bash
firebase deploy --only hosting,firestore:rules --project dnols-2a394
```

This deployment works on the Firebase Spark/free plan because it does not deploy Firebase Functions.

Live backend APIs now run on Render, not Firebase Functions. Keep Firebase Hosting for the public UI/dashboard and use the Render service for Claude chat, business email verification, and server-side notification providers.

The Hosting deploy target is the site `dnols-2a394` because `firebase.json` contains:

```json
"hosting": {
  "site": "dnols-2a394"
}
```

## What Deploys Now

- Static landing page: `public/index.html`
- Business agent onboarding page: `public/onboarding.html`
- Deal request page: `public/deals.html`
- Human approval page: `public/approvals.html`
- Static crawl files:
  - `/registry.json`
  - `/agents/index.json`
  - `/agents/{namespace}.json`
  - `/.well-known/agent-registry.json`
  - `/.well-known/agent-capabilities.json`
  - `/robots.txt`
  - `/sitemap.xml`
- Firestore rules for public onboarding submissions, deal requests, approval decisions, and audit events

The onboarding page runs in the browser and saves accepted agent profile submissions to the Firestore `submissions` collection for review. The deal and approval pages save to `dealRequests` and `dealApprovals`. Public users can create records only; they cannot read, edit, or delete records.

## Public Publishing Workflow

The business dashboard lets an owner submit a profile for review. That updates private owner-scoped Firestore status fields only; it does not expose private negotiation rules or API secrets.

For the Spark/free version, publication is an admin step:

1. Review the submitted business profile in Firebase Console.
2. Copy only safe public fields into `data/public-profiles.json`.
3. Set `reviewStatus` to `published` or `approved`.
4. Run `npm run publish:registry`.
5. Deploy Hosting + Firestore rules.

Do not put private floor prices, API keys, internal notes, or secrets in `data/public-profiles.json`.

## Render Backend

Use Render for backend endpoints that need secrets or live server execution:

```text
Build Command: npm install
Start Command: npm start
Health Check: /api/health
```

Required or optional Render environment variables:

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
AT_API_KEY=...
AT_USERNAME=sandbox
AT_SENDER_ID=DNOLS
AT_ENV=sandbox
# Optional Firestore-backed SMS deal state for the Render service.
DEAL_STORE_BACKEND=firestore
FIREBASE_PROJECT_ID=dnols-2a394
GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/firebase-service-account.json
# Prefer Render Cron for production reminder runs.
SMS_REMINDER_INTERVAL_ENABLED=false
SMS_REMINDER_INTERVAL_MS=900000
```

Do not expose these values in Firebase Hosting or any `public/` file.

### SMS Notification Operations

Africa's Talking inbound SMS callback should point to the Render service:

```text
https://<render-service-host>/api/sms/webhook
```

The webhook accepts Africa's Talking form fields: `from`, `to`, `text`, `linkId`, `id`, and `date`. The backend resolves the deal by `linkId` or `dealId`, then by sender phone, and derives the reply role from the stored buyer or seller phone number.

SMS backend endpoints:

```http
POST /api/sms/notify
POST /api/sms/webhook
POST /api/sms/run-reminders
```

Use `POST /api/sms/notify` with `event: "new_deal"` to persist a deal and send the initial seller request. Use `POST /api/sms/run-reminders` from Render Cron, or another scheduler, to send the 2-hour reminder SMS for active deals that have not yet been reminded. Keep in-process reminders disabled in production unless there is only one backend instance.

Firestore rules deploy server-only `deals` and `dealPhoneIndex` collections with client `read` and `write` denied. The Render backend may still write them through `firebase-admin`, because Admin SDK access bypasses Firestore Security Rules.

## Stripe Payment Links

Optional later. Live checkout links need backend support. When you are ready to use Functions, create `functions/.env`:

```bash
cp functions/.env.example functions/.env
```

Then fill:

```bash
STRIPE_BASIC_PAYMENT_LINK=https://buy.stripe.com/...
STRIPE_PRO_PAYMENT_LINK=https://buy.stripe.com/...
STRIPE_ENTERPRISE_PAYMENT_LINK=https://buy.stripe.com/...
```

For now, the public pages save free agent profiles, deal requests, and approval decisions to Firestore. Stripe checkout can be connected later.
