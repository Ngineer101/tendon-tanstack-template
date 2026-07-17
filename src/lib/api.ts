import { env } from "cloudflare:workers";

import {
  getValidatedRequestOrigin,
  handleApiError,
  parseJsonBody,
  requireAuthenticatedSession,
} from "#/lib/api-guards";
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
  params: Record<string, string>;
  request: Request;
}

interface AuthenticatedApiHandlerContext<
  TEnv extends Cloudflare.Env,
> extends ApiHandlerContext<TEnv> {
  user: {
    id: string;
  };
}

type RouteHandler = (context: {
  params?: Record<string, string>;
  request: Request;
}) => Promise<Response>;

export { handleApiError, parseJsonBody };

export function publicApiHandler<TEnv extends Cloudflare.Env>(
  handler: (context: ApiHandlerContext<TEnv>) => Response | Promise<Response>,
  options: ApiHandlerOptions = {},
): RouteHandler {
  return async ({ params, request }) => {
    try {
      return await handler({
        env: env as TEnv,
        origin: getValidatedRequestOrigin(
          request.url,
          request.headers.get("origin"),
          options.sameOrigin ?? false,
        ),
        params: params ?? {},
        request,
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
    const session = requireAuthenticatedSession(
      await getAuth(context.env).api.getSession({ headers: context.request.headers }),
    );

    return handler({ ...context, user: session.user });
  }, options);
}
