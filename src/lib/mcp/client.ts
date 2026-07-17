// Small fetch + UI helpers shared by the MCP components. Kept here so the
// panel / dialog / cards stay focused on rendering.

import { useCallback, useEffect, useRef, useState } from "react";

import { apiError, type ApiErrorShape } from "./types";

export interface FetchError extends Error {
  status?: number;
  details?: Record<string, unknown>;
}

// Fetch JSON and throw an ApiError-shaped error on a non-2xx response.
export async function fetchJson<T>(input: string | URL | Request, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (reason) {
    const err: FetchError = new Error(
      reason instanceof Error ? reason.message : "Network request failed",
    );
    throw err;
  }
  return parseJson<T>(response);
}

// Parse a Response's JSON body and throw an ApiError-shaped error when the
// response is not 2xx. Handles 204 and non-JSON bodies gracefully.
export async function parseJson<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  let body: unknown = null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const err = apiError(body);
    const message = err?.error ?? "Unable to complete request";
    const e: FetchError = new Error(message);
    e.status = response.status;
    e.details = err?.details;
    throw e;
  }
  return body as T;
}

export function apiErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unable to complete request";
}

export type { ApiErrorShape };

export function useTimedFlag<T>(ttl = 5000): [T | undefined, (value: T) => void, () => void] {
  const [value, setValue] = useState<T | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clear = useCallback(() => {
    setValue(undefined);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  const set = useCallback(
    (next: T) => {
      setValue(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(clear, ttl);
    },
    [clear, ttl],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return [value, set, clear];
}
