import { HeadContent, Link, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import Footer from "../components/Footer";
import Header from "../components/Header";
import TanStackQueryProvider from "../integrations/tanstack-query/root-provider";
import appCss from "../styles.css?url";
import type { QueryClient } from "@tanstack/react-query";

interface MyRouterContext {
  queryClient: QueryClient;
}

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;

export const Route = createRootRouteWithContext<MyRouterContext>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "TanStack Start Starter",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  notFoundComponent: NotFound,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="font-sans antialiased wrap-anywhere] selection:bg-[rgba(79,184,178,0.24)]">
        <TanStackQueryProvider>
          <Header />
          {children}
          <Footer />
        </TanStackQueryProvider>
        <Scripts />
      </body>
    </html>
  );
}

function NotFound() {
  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center px-4 py-20 text-center">
      <p
        className="select-none font-mono text-[8rem] font-bold leading-none tracking-tighter text-border sm:text-[12rem]"
        style={{ animation: "not-found-float 4s ease-in-out infinite" }}
      >
        404
      </p>

      <style>{`
        @keyframes not-found-float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-10px); }
        }
      `}</style>

      <h1 className="mt-6 text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        The page you're looking for doesn't exist or has been moved.
      </p>

      <Link
        to="/"
        className="mt-8 inline-flex h-8 items-center rounded-lg border border-border bg-background px-4 text-sm font-medium transition-colors hover:bg-muted"
      >
        Go home
      </Link>
    </div>
  );
}
