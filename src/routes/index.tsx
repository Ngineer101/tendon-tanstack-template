import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

const features = [
  {
    title: "Type-Safe Routing",
    desc: "Routes and links stay in sync across every page — no string paths, no guessing.",
  },
  {
    title: "Server Functions",
    desc: "Call server code directly from your UI without writing API boilerplate.",
  },
  {
    title: "Auth Ready",
    desc: "Email/password authentication wired up via Better Auth and Drizzle ORM.",
  },
  {
    title: "Edge Native",
    desc: "Deploys to Cloudflare Workers with D1, KV, and R2 bindings out of the box.",
  },
];

function Home() {
  return (
    <main className="mx-auto max-w-5xl px-4 pb-20 pt-20">
      {/* Hero */}
      <section
        className="animate-in fade-in-0 slide-in-from-bottom-4 duration-700"
        style={{ animationFillMode: "both" }}
      >
        <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-primary">
          TanStack Start
        </p>
        <h1 className="mb-5 max-w-2xl text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          Start simple,
          <br />
          ship quickly.
        </h1>
        <p className="mb-10 max-w-lg text-base text-muted-foreground">
          A minimal starter with routing, authentication, and a D1 database — ready to deploy to the
          edge.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            to="/sign-up"
            className="inline-flex h-9 items-center bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-85"
          >
            Get started
          </Link>
          <a
            href="https://tanstack.com/start"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 items-center border border-border px-5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            Documentation
          </a>
        </div>
      </section>

      <div className="my-16 border-t border-border" />

      {/* Features */}
      <section
        className="animate-in fade-in-0 slide-in-from-bottom-2 duration-700"
        style={{ animationDelay: "200ms", animationFillMode: "both" }}
      >
        <div className="grid gap-px border border-border bg-border sm:grid-cols-2">
          {features.map(({ title, desc }) => (
            <article key={title} className="bg-background p-6">
              <h2 className="mb-2 text-sm font-semibold text-foreground">{title}</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">{desc}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
