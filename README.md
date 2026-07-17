Welcome to your new TanStack Start app!

# Getting Started

To run this application:

```bash
pnpm install
pnpm dev
```

# Building For Production

To build this application for production:

```bash
pnpm build
```

## Stripe Billing

This starter includes user-owned Stripe billing for two models that can be used at the same time:

- Fixed monthly subscriptions unlock paid feature entitlements.
- Prepaid credits are purchased up front and consumed by usage-based features.

The example catalog has a `free` tier, a `pro_monthly` subscription with the `premium_dashboard`
entitlement, three non-expiring credit packs (`1,000`, `5,000`, and `20,000` credits), and an
`ai_generation` action costing `10` credits. Credit usage is blocked when the balance reaches zero.

Catalog labels, display prices, entitlements, and credit costs live in `src/lib/billing/config.ts`.
Stripe remains the source of truth for payments and subscription status. D1 stores a local
subscription projection and an append-only credit ledger so feature checks stay fast.

### Stripe Dashboard Setup

1. In Stripe test mode, create a recurring monthly Pro product and three one-time credit-pack
   products.
2. Copy each Stripe Price ID into the matching variable in `.env.local`. Use `.env.example` as the
   template.
3. Enable and configure the Stripe Customer Portal in the Stripe Dashboard.
4. Create a webhook endpoint for `https://<your-domain>/api/billing/webhook` and subscribe it to:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Copy the endpoint signing secret to `STRIPE_WEBHOOK_SECRET`.
6. Apply the D1 migration with `pnpm run db:migrate` locally and `pnpm run db:migrate:prod` in
   production.

For local webhook testing, install the Stripe CLI and forward events:

```sh
stripe listen --forward-to localhost:3000/api/billing/webhook
```

Set production secrets with Wrangler rather than committing them:

```sh
pnpm exec wrangler secret put STRIPE_SECRET_KEY
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET
pnpm exec wrangler secret put STRIPE_PRO_MONTHLY_PRICE_ID
pnpm exec wrangler secret put STRIPE_CREDITS_1000_PRICE_ID
pnpm exec wrangler secret put STRIPE_CREDITS_5000_PRICE_ID
pnpm exec wrangler secret put STRIPE_CREDITS_20000_PRICE_ID
```

To enable Stripe Tax after configuring it in the Dashboard, set `STRIPE_TAX_ENABLED=true` locally
and add it as a Wrangler variable or secret in production.

### Using Billing In Features

Use the billing core from server-side feature code. Call `requireCredits` before doing paid work so
the feature fails closed when the balance is too low:

```ts
import { hasEntitlement, requireCredits } from "#/lib/billing/core.server";

const allowed = await hasEntitlement(env, userId, "premium_dashboard");
await requireCredits(env, userId, "ai_generation");

// Run the paid feature only after credits have been reserved successfully.
```

`requireCredits` debits the balance atomically and throws `InsufficientCreditsError` when the debit
cannot be made. Its lower-level `consumeCredits` helper returns `{ consumed: false }` instead if a
feature needs custom control flow. Both use a conditional D1 update so simultaneous requests cannot
spend below zero.
Stripe webhook handling is idempotent, and each credit purchase can only be granted once.

For promotions or manual admin grants, call `grantCredits` from an admin-only server route:

```ts
await grantCredits(env, userId, 500, {
  type: "admin_grant", // Use "promotion" for automated campaigns.
  description: "Customer support credit",
  reference: `admin-grant:${requestId}`,
});
```

The unique reference is required to make retries safe. This starter intentionally does not expose
an admin grant endpoint until the host app adds its own admin authorization policy.

### Optional Product Decisions

- Billing is attached to an individual user. Introduce an organization-owned billing account if
  the product later adds teams.
- Credits never expire. Add grant lots with expiry timestamps if the product needs expiration.
- Credit balances cannot go negative. Change the conditional debit only if the product explicitly
  supports overages.
- The starter uses prepaid app credits, not Stripe Billing Credits. Stripe Billing Credits target
  metered subscription invoicing rather than immediate in-app balance enforcement.
- Display prices in `src/lib/billing/config.ts` must match the corresponding Stripe Price objects.

## MCP Server Connections

Users can connect Model Context Protocol (MCP) servers from `/dashboard` — with OAuth discovery,
PKCE authorization, and AES-256-GCM encrypted credential storage. Free-plan users can connect up
to 3 servers; the Pro plan unlocks unlimited connections via the `unlimited_mcp_servers`
entitlement.

Set the encryption key as an environment secret (generate with `openssl rand -base64 32`):

```sh
pnpm exec wrangler secret put MCP_ENCRYPTION_KEY
```

See `docs/mcp-servers.md` for the architecture, connection flow, security controls, and all
implementation decisions.

## Cloudflare Background Jobs

This template includes light boilerplate for Cloudflare Queues, Cron Triggers, and Workflows.

- `src/worker.ts` wires Cloudflare Worker events and delegates HTTP requests to TanStack Start.
- `src/worker/queues.ts` defines queue message payloads and routes messages by `type`.
- `src/worker/crons.ts` routes scheduled jobs by cron expression.
- `src/worker/workflows.ts` exports workflow classes used by `wrangler.jsonc`.
- `src/worker/jobs.ts` contains small helper functions that app code can call to enqueue jobs or start workflows.

Before deploying a new app from this template, rename the placeholder resource names in `wrangler.jsonc` and create the backing Cloudflare resources:

```bash
pnpm exec wrangler queues create tanstack-start-app-jobs
pnpm exec wrangler queues create tanstack-start-app-jobs-dlq
pnpm exec wrangler d1 create tanstack-start-app-db
pnpm exec wrangler r2 bucket create tanstack-start-app-assets
```

After changing `wrangler.jsonc`, regenerate Worker types:

```bash
pnpm cf-typegen
```

## Testing

This project uses [Vitest](https://vitest.dev/) for testing. You can run the tests with:

```bash
pnpm test
```

## Styling

This project uses [Tailwind CSS](https://tailwindcss.com/) for styling.

### Removing Tailwind CSS

If you prefer not to use Tailwind CSS:

1. Remove the demo pages in `src/routes/demo/`
2. Replace the Tailwind import in `src/styles.css` with your own styles
3. Remove `tailwindcss()` from the plugins array in `vite.config.ts`
4. Uninstall the packages: `pnpm add @tailwindcss/vite tailwindcss --dev`

# TanStack Chat Application

Am example chat application built with TanStack Start, TanStack Store, and Claude AI.

## .env Updates

```env
ANTHROPIC_API_KEY=your_anthropic_api_key
```

## ✨ Features

### AI Capabilities

- 🤖 Powered by Claude 3.5 Sonnet
- 📝 Rich markdown formatting with syntax highlighting
- 🎯 Customizable system prompts for tailored AI behavior
- 🔄 Real-time message updates and streaming responses (coming soon)

### User Experience

- 🎨 Modern UI with Tailwind CSS and Lucide icons
- 🔍 Conversation management and history
- 🔐 Secure API key management
- 📋 Markdown rendering with code highlighting

### Technical Features

- 📦 Centralized state management with TanStack Store
- 🔌 Extensible architecture for multiple AI providers
- 🛠️ TypeScript for type safety

## Architecture

### Tech Stack

- **Frontend Framework**: TanStack Start
- **Routing**: TanStack Router
- **State Management**: TanStack Store
- **Styling**: Tailwind CSS
- **AI Integration**: Anthropic's Claude API

## Shadcn

Add components using the latest version of [Shadcn](https://ui.shadcn.com/).

```bash
pnpm dlx shadcn@latest add button
```

## Setting up Better Auth

1. Generate and set the `BETTER_AUTH_SECRET` environment variable in your `.env.local`:

   ```bash
   pnpm dlx @better-auth/cli secret
   ```

2. Visit the [Better Auth documentation](https://www.better-auth.com) to unlock the full potential of authentication in your app.

### Adding a Database (Optional)

Better Auth can work in stateless mode, but to persist user data, add a database:

```typescript
// src/lib/auth.ts
import { betterAuth } from "better-auth";
import { Pool } from "pg";

export const auth = betterAuth({
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
  }),
  // ... rest of config
});
```

Then run migrations:

```bash
pnpm dlx @better-auth/cli migrate
```

## Routing

This project uses [TanStack Router](https://tanstack.com/router) with file-based routing. Routes are managed as files in `src/routes`.

### Adding A Route

To add a new route to your application just add a new file in the `./src/routes` directory.

TanStack will automatically generate the content of the route file for you.

Now that you have two routes you can use a `Link` component to navigate between them.

### Adding Links

To use SPA (Single Page Application) navigation you will need to import the `Link` component from `@tanstack/react-router`.

```tsx
import { Link } from "@tanstack/react-router";
```

Then anywhere in your JSX you can use it like so:

```tsx
<Link to="/about">About</Link>
```

This will create a link that will navigate to the `/about` route.

More information on the `Link` component can be found in the [Link documentation](https://tanstack.com/router/v1/docs/framework/react/api/router/linkComponent).

### Using A Layout

In the File Based Routing setup the layout is located in `src/routes/__root.tsx`. Anything you add to the root route will appear in all the routes. The route content will appear in the JSX where you render `{children}` in the `shellComponent`.

Here is an example layout that includes a header:

```tsx
import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "My App" },
    ],
  }),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <header>
          <nav>
            <Link to="/">Home</Link>
            <Link to="/about">About</Link>
          </nav>
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  ),
});
```

More information on layouts can be found in the [Layouts documentation](https://tanstack.com/router/latest/docs/framework/react/guide/routing-concepts#layouts).

## Server Functions

TanStack Start provides server functions that allow you to write server-side code that seamlessly integrates with your client components.

```tsx
import { createServerFn } from "@tanstack/react-start";

const getServerTime = createServerFn({
  method: "GET",
}).handler(async () => {
  return new Date().toISOString();
});

// Use in a component
function MyComponent() {
  const [time, setTime] = useState("");

  useEffect(() => {
    getServerTime().then(setTime);
  }, []);

  return <div>Server time: {time}</div>;
}
```

## API Routes

You can create API routes by using the `server` property in your route definitions:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

export const Route = createFileRoute("/api/hello")({
  server: {
    handlers: {
      GET: () => json({ message: "Hello, World!" }),
    },
  },
});
```

## Data Fetching

There are multiple ways to fetch data in your application. You can use TanStack Query to fetch data from a server. But you can also use the `loader` functionality built into TanStack Router to load the data for a route before it's rendered.

For example:

```tsx
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/people")({
  loader: async () => {
    const response = await fetch("https://swapi.dev/api/people");
    return response.json();
  },
  component: PeopleComponent,
});

function PeopleComponent() {
  const data = Route.useLoaderData();
  return (
    <ul>
      {data.results.map((person) => (
        <li key={person.name}>{person.name}</li>
      ))}
    </ul>
  );
}
```

Loaders simplify your data fetching logic dramatically. Check out more information in the [Loader documentation](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#loader-parameters).

# Demo files

Files prefixed with `demo` can be safely deleted. They are there to provide a starting point for you to play around with the features you've installed.

# Learn More

You can learn more about all of the offerings from TanStack in the [TanStack documentation](https://tanstack.com).

For TanStack Start specific documentation, visit [TanStack Start](https://tanstack.com/start).
