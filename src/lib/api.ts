import { env } from "cloudflare:workers";

import { ApiError } from "#/lib/api-error";
import { getAuth } from "#/lib/auth";

interface ApiHandlerOptions {
  sameOrigin?: boolean;
  fallbackError?: {
    status: number;
    message: string;
  };
}

interface ApiHandlerContext<TEnv extends Cloudflare.Env> {
  env: TEnv;
  origin: string;
  request: Request;
  params: Record<string, string>;
}

interface AuthenticatedApiHandlerContext<
  TEnv extends Cloudflare.Env,
> extends ApiHandlerContext<TEnv> {
  user: {
    id: string;
  };
}

type RouteHandler = (context: {
  request: Request;
  params: Record<string, string>;
}) => Promise<Response>;

function getOrigin(request: Request, requireSameOrigin: boolean) {
  const requestOrigin = new URL(request.url).origin;
  if (!requireSameOrigin) return requestOrigin;

  const origin = request.headers.get("origin");
  if (!origin || origin !== requestOrigin) {
    throw new ApiError(403, "Invalid origin");
  }
  return origin;
}

export function handleApiError(error: unknown, fallback?: ApiHandlerOptions["fallbackError"]) {
  if (error instanceof Response) return error;

  if (error instanceof ApiError) {
    return Response.json({ error: error.message, ...error.details }, { status: error.status });
  }

  console.error(error);
  return Response.json(
    { error: fallback?.message ?? "Unable to complete request" },
    { status: fallback?.status ?? 500 },
  );
}

export function publicApiHandler<TEnv extends Cloudflare.Env>(
  handler: (context: ApiHandlerContext<TEnv>) => Response | Promise<Response>,
  options: ApiHandlerOptions = {},
): RouteHandler {
  return async ({ request, params }) => {
    try {
      return await handler({
        env: env as TEnv,
        origin: getOrigin(request, options.sameOrigin ?? false),
        request,
        params: params ?? {},
      });
    } catch (error) {
      return handleApiError(error, options.fallbackError);
    }
  };
}

export function authenticatedApiHandler<TEnv extends Cloudflare.Env>(
  handler: (context: AuthenticatedApiHandlerContext<TEnv>) => Response | Promise<Response>,
  options: ApiHandlerOptions = {},
): RouteHandler {
  return publicApiHandler<TEnv>(async (context) => {
    const session = await getAuth(context.env).api.getSession({ headers: context.request.headers });
    if (!session) {
      throw new ApiError(401, "Unauthorized");
    }

    return handler({ ...context, user: session.user });
  }, options);
}
