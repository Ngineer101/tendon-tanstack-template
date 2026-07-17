import { useState, useEffect, useCallback } from "react";
import { McpServerCard, AddMcpServerDialog } from "./McpServerCard";
import type { McpServer } from "./McpServerCard";
import { Skeleton } from "#/components/ui/skeleton";

async function apiFetch(path: string, options?: RequestInit) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error((data.error as string) ?? `Request failed with status ${response.status}`);
  }
  return data;
}

export function McpServerSection() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [testing, setTesting] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [summary, setSummary] = useState<{ plan: string }>();

  const loadServers = useCallback(async () => {
    try {
      const data = (await apiFetch("/api/mcp/servers")) as unknown as McpServer[];
      setServers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load servers");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSummary = useCallback(async () => {
    try {
      const response = await fetch("/api/billing/summary");
      if (response.ok) {
        setSummary((await response.json()) as { plan: string });
      }
    } catch {
      // non-critical
    }
  }, []);

  useEffect(() => {
    void loadServers();
    void loadSummary();
  }, [loadServers, loadSummary]);

  const isPro = summary?.plan === "pro_monthly";
  const atLimit = !isPro && servers.length >= 3;

  async function handleAdd(label: string, url: string) {
    setError(undefined);
    setAdding(true);
    try {
      await apiFetch("/api/mcp/servers", {
        method: "POST",
        body: JSON.stringify({ label: label.trim(), url: url.trim() }),
      });
      await loadServers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect server");
    } finally {
      setAdding(false);
    }
  }

  async function handleTest(id: string) {
    setError(undefined);
    setTesting(id);
    try {
      const result = (await apiFetch(`/api/mcp/servers/${id}/test`, {
        method: "POST",
      })) as { ok: boolean; error?: string };
      if (!result.ok) {
        setError(result.error ?? "Connection test failed");
      }
      await loadServers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test failed");
    } finally {
      setTesting(null);
    }
  }

  async function handleDelete(id: string) {
    setError(undefined);
    try {
      await apiFetch(`/api/mcp/servers/${id}`, { method: "DELETE" });
      setServers((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect server");
    }
  }

  async function handleEdit(id: string, label: string, url: string) {
    setError(undefined);
    try {
      const updated = (await apiFetch(`/api/mcp/servers/${id}`, {
        method: "PUT",
        body: JSON.stringify({ label: label.trim(), url: url.trim() }),
      })) as unknown as McpServer;
      setServers((prev) => prev.map((s) => (s.id === id ? updated : s)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update server");
    }
  }

  async function handleOAuth(id: string) {
    setError(undefined);
    setConnecting(id);
    try {
      const result = (await apiFetch(`/api/mcp/servers/${id}/oauth/authorize`, {
        method: "POST",
      })) as { authorizationUrl: string };
      window.location.assign(result.authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "OAuth authorization failed");
      setConnecting(null);
    }
  }

  async function handleReconnect(id: string) {
    setError(undefined);
    setConnecting(id);
    try {
      await apiFetch(`/api/mcp/servers/${id}/test`, { method: "POST" });
      await loadServers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reconnect failed");
    } finally {
      setConnecting(null);
    }
  }

  return (
    <section>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">MCP servers</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">Connected servers</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Connect MCP servers to enhance your chat sessions with external tools and data sources.
          </p>
        </div>
        <AddMcpServerDialog
          onAdd={handleAdd}
          disabled={adding}
          limitReached={atLimit}
          limitMessage="Free users can connect up to 3 MCP servers. Upgrade to Pro for unlimited servers."
        />
      </div>

      {error && (
        <p className="mt-4 border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive animate-in fade-in-0 slide-in-from-top-1">
          {error}
        </p>
      )}

      <div className="mt-6">
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[164px]" />
            ))}
          </div>
        ) : servers.length === 0 ? (
          <div className="border border-dashed py-16 text-center animate-in fade-in-0 zoom-in-95">
            <p className="text-sm text-muted-foreground">No MCP servers connected yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Connect a server to get started with external tool integration.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {servers.map((server, index) => (
              <div
                key={server.id}
                className="animate-in fade-in-0 slide-in-from-bottom-2"
                style={{ animationDelay: `${index * 50}ms`, animationFillMode: "both" }}
              >
                <McpServerCard
                  server={server}
                  onTest={handleTest}
                  onDelete={handleDelete}
                  onEdit={handleEdit}
                  onOAuth={handleOAuth}
                  onReconnect={handleReconnect}
                  testing={testing}
                  connecting={connecting}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {!isPro && (
        <p className="mt-4 text-center text-xs text-muted-foreground">
          {servers.length}/3 servers used.{" "}
          <a
            href="/billing"
            className="underline underline-offset-2 hover:text-primary transition-colors"
          >
            Upgrade to Pro
          </a>{" "}
          for unlimited servers.
        </p>
      )}
    </section>
  );
}
