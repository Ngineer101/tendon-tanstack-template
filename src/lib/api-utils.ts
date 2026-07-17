import { ApiError } from "#/lib/api-error";

export async function readJsonBody(request: Request, maximumBytes = 16 * 1024) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ApiError(413, "Request body is too large");
  }
  if (!request.body) throw new ApiError(400, "A JSON request body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new ApiError(413, "Request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON");
  }
}

export function handleApiError(error: unknown, fallback?: { status: number; message: string }) {
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
