import { ApiError } from "#/lib/api-error";
import type { z } from "zod";

export interface ApiErrorFallback {
  status: number;
  message: string;
}

export function handleApiError(error: unknown, fallback?: ApiErrorFallback) {
  if (error instanceof Response) return error;

  if (error instanceof ApiError) {
    return Response.json({ error: error.message, ...error.details }, { status: error.status });
  }

  const errorId = crypto.randomUUID();
  console.error(
    JSON.stringify({
      event: "api_request_failed",
      errorId,
      errorType: error instanceof Error ? error.name : "UnknownError",
    }),
  );
  return Response.json(
    { error: fallback?.message ?? "Unable to complete request", errorId },
    { status: fallback?.status ?? 500 },
  );
}

export function getValidatedRequestOrigin(
  requestUrl: string,
  originHeader: string | null,
  requireSameOrigin: boolean,
) {
  const requestOrigin = new URL(requestUrl).origin;
  if (!requireSameOrigin) return requestOrigin;
  if (!originHeader || originHeader !== requestOrigin) {
    throw new ApiError(403, "Invalid origin");
  }
  return originHeader;
}

export function requireAuthenticatedSession<TSession extends { user: { id: string } }>(
  session: TSession | null,
): TSession {
  if (!session) throw new ApiError(401, "Unauthorized");
  return session;
}

export async function parseJsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new ApiError(415, "Request body must be JSON.");
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > 8_192) {
    throw new ApiError(413, "Request body is too large.");
  }

  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Request body is required.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 8_192) {
      await reader.cancel();
      throw new ApiError(413, "Request body is too large.");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new ApiError(400, "Request body contains invalid JSON.");
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, result.error.issues[0]?.message ?? "Request body is invalid.");
  }
  return result.data;
}
