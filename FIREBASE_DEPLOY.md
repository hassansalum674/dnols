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

## What Waits Until Blaze

Firebase Functions require the Blaze/pay-as-you-go plan, so these live backend features are paused:

- `/api/generate-from-website`
- `/api/plans`
- `/api/checkout`
- `/api/manifests`
- live agent execution endpoints

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
