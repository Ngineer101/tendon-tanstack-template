import { authClient } from "#/lib/auth-client";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";

export default function BetterAuthHeader() {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return <div className="h-7 w-7 animate-pulse rounded-full bg-muted" />;
  }

  if (session?.user) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium text-muted-foreground">
          {session.user.image ? (
            <img src={session.user.image} alt="" className="h-full w-full object-cover" />
          ) : (
            (session.user.name?.charAt(0).toUpperCase() ?? "U")
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void authClient.signOut().then(() => navigate({ to: "/" }));
          }}
        >
          Sign out
        </Button>
      </div>
    );
  }

  return (
    <Button variant="outline" size="sm" asChild>
      <Link to="/sign-in">Sign in</Link>
    </Button>
  );
}
