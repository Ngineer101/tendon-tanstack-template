export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiErrorFallback {
  status: number;
  message: string;
}

export function handleApiError(error: unknown, fallback?: ApiErrorFallback) {
  if (error instanceof Response) return error;

  if (error instanceof ApiError) {
    return Response.json({ error: error.message, ...error.details }, { status: error.status });
  }

  console.error(
    JSON.stringify({
      message: "API request failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }),
  );
  return Response.json(
    { error: fallback?.message ?? "Unable to complete request" },
    { status: fallback?.status ?? 500 },
  );
}

export async function readJsonBody<T>(request: Request, maxBytes = 16 * 1024): Promise<T> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new ApiError(415, "Content-Type must be application/json");
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ApiError(413, "Request body is too large");
  }
  if (!request.body) throw new ApiError(400, "A JSON request body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "Request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(joined)) as T;
  } catch {
    throw new ApiError(400, "Request body must contain valid JSON");
  }
}
