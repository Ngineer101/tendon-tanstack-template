import { Link } from "@tanstack/react-router";
import BetterAuthHeader from "../integrations/better-auth/header-user.tsx";
import ThemeToggle from "./ThemeToggle";
import { authClient } from "#/lib/auth-client";

export default function Header() {
  const { data: session } = authClient.useSession();

  return (
    <header className="sticky top-0 z-50 border-b border-(--line) bg-(--header-bg)/80 px-4 backdrop-blur-lg">
      <div className="page-wrap flex h-14 items-center gap-6 max-w-6xl mx-auto">
        <nav className="flex items-center gap-0.5">
          <Link
            to="/"
            className="rounded-md px-3 py-1.5 text-sm text-(--sea-ink-soft) transition-colors hover:bg-(--chip-bg) hover:text-(--sea-ink)"
            activeProps={{ style: { color: "var(--sea-ink)", fontWeight: "500" } }}
          >
            Home
          </Link>
          {session?.user && (
            <Link
              to="/dashboard"
              className="rounded-md px-3 py-1.5 text-sm text-(--sea-ink-soft) transition-colors hover:bg-(--chip-bg) hover:text-(--sea-ink)"
              activeProps={{ style: { color: "var(--sea-ink)", fontWeight: "500" } }}
            >
              Dashboard
            </Link>
          )}
        </nav>

        <div className="ml-auto flex items-center gap-1">
          <BetterAuthHeader />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
