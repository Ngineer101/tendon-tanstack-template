import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/dashboard")({
  component: RouteComponent,
});

function RouteComponent() {
  return <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 p-4">Dashboard</div>;
}
