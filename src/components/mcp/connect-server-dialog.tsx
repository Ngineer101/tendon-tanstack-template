import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Loader2, Plug, ShieldCheck, Sparkles } from "lucide-react";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { MCP_ERROR_CODES, type McpConnectResponse } from "#/lib/mcp/config";
import { MCP_SERVERS_QUERY_KEY, McpApiError, mcpApi } from "./api";

type Step = "form" | "authorize" | "success";

interface ConnectServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  atLimit: boolean;
  limit: number | null;
}

export function ConnectServerDialog({
  open,
  onOpenChange,
  atLimit,
  limit,
}: ConnectServerDialogProps) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("form");
  const [name, setName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [error, setError] = useState<string>();
  const [limitError, setLimitError] = useState(false);
  const [result, setResult] = useState<McpConnectResponse>();

  const connectMutation = useMutation({
    mutationFn: () => mcpApi.connect({ name: name.trim(), serverUrl: serverUrl.trim() }),
    onSuccess: async (response) => {
      setResult(response);
      await queryClient.invalidateQueries({ queryKey: MCP_SERVERS_QUERY_KEY });
      if (response.authorizationUrl) {
        setStep("authorize");
      } else {
        setStep("success");
        setTimeout(() => handleOpenChange(false), 1_400);
      }
    },
    onError: (mutationError) => {
      if (
        mutationError instanceof McpApiError &&
        mutationError.code === MCP_ERROR_CODES.limitReached
      ) {
        setLimitError(true);
        return;
      }
      setError(
        mutationError instanceof McpApiError
          ? mutationError.message
          : "Unable to connect the server",
      );
    },
  });

  function handleOpenChange(next: boolean) {
    if (!next) {
      setStep("form");
      setName("");
      setServerUrl("");
      setError(undefined);
      setLimitError(false);
      setResult(undefined);
      connectMutation.reset();
    }
    onOpenChange(next);
  }

  const showLimitContent = atLimit || limitError;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        {showLimitContent ? (
          <div key="limit" className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles className="size-4 text-primary" />
                Server limit reached
              </DialogTitle>
              <DialogDescription>
                Free accounts can connect up to {limit ?? 3} MCP servers. Upgrade to Pro to connect
                as many servers as your workflow needs.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="mt-4">
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Maybe later
              </Button>
              <Button asChild>
                <Link to="/billing" search={{ checkout: undefined }}>
                  Upgrade to Pro
                  <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            </DialogFooter>
          </div>
        ) : step === "form" ? (
          <div key="form" className="animate-in fade-in-0 duration-200">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Plug className="size-4 text-primary" />
                Connect an MCP server
              </DialogTitle>
              <DialogDescription>
                Point to a remote MCP endpoint. If it requires OAuth, you&apos;ll be sent to its
                sign-in page to authorize access.
              </DialogDescription>
            </DialogHeader>
            <form
              className="mt-4 flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                setError(undefined);
                connectMutation.mutate();
              }}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-name">Name</Label>
                <Input
                  id="mcp-name"
                  placeholder="e.g. GitHub tools"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={60}
                  required
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-url">Server URL</Label>
                <Input
                  id="mcp-url"
                  placeholder="https://mcp.example.com/mcp"
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.target.value)}
                  type="url"
                  className="font-mono text-xs"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  HTTPS only. We&apos;ll detect the server&apos;s auth requirements automatically.
                </p>
              </div>
              {error && (
                <p
                  className="animate-in fade-in-0 slide-in-from-top-1 border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive duration-200"
                  role="alert"
                >
                  {error}
                </p>
              )}
              <DialogFooter className="mt-1">
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={connectMutation.isPending}
                  data-testid="connect-submit"
                >
                  {connectMutation.isPending ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      Contacting server...
                    </>
                  ) : (
                    <>
                      <Plug className="size-3.5" />
                      Connect
                    </>
                  )}
                </Button>
              </DialogFooter>
            </form>
          </div>
        ) : step === "authorize" ? (
          <div
            key="authorize"
            className="animate-in fade-in-0 slide-in-from-right-2 flex flex-col items-center gap-3 py-2 text-center duration-300"
          >
            <span className="flex size-12 items-center justify-center border border-primary/30 bg-primary/10">
              <ShieldCheck className="size-6 text-primary" />
            </span>
            <DialogTitle>Authorization required</DialogTitle>
            <DialogDescription className="max-w-xs">
              <span className="font-medium text-foreground">{result?.server.name}</span> uses OAuth.
              You&apos;ll be redirected to its sign-in page and brought back here once you approve
              access.
            </DialogDescription>
            <Button
              className="mt-2 w-full"
              onClick={() => {
                if (result?.authorizationUrl) window.location.assign(result.authorizationUrl);
              }}
              data-testid="authorize-button"
            >
              Continue to authorization
              <ArrowRight className="size-3.5" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>
              Finish later
            </Button>
          </div>
        ) : (
          <div
            key="success"
            className="animate-in fade-in-0 zoom-in-95 flex flex-col items-center gap-3 py-6 text-center duration-300"
          >
            <CheckCircle2 className="animate-in zoom-in-50 size-10 text-emerald-500 duration-500" />
            <DialogTitle>Connected</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{result?.server.name}</span> is ready to
              use in your chat sessions.
            </DialogDescription>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
