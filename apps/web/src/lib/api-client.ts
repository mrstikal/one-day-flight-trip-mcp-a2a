import { errorEnvelopeSchema } from "@odft/contracts";

/** Typed API error carrying the server's safe error envelope. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly currentRevision: number | undefined;
  readonly operationId: string | undefined;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    retryable: boolean;
    currentRevision?: number;
    operationId?: string;
  }) {
    super(input.message);
    this.name = "ApiError";
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable;
    this.currentRevision = input.currentRevision;
    this.operationId = input.operationId;
  }
}

export async function parseApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = errorEnvelopeSchema.safeParse(body);
  if (parsed.success) {
    return new ApiError({
      code: parsed.data.code,
      message: parsed.data.message,
      status: response.status,
      retryable: parsed.data.retryable,
      ...(parsed.data.currentRevision !== undefined
        ? { currentRevision: parsed.data.currentRevision }
        : {}),
      ...(parsed.data.operationId ? { operationId: parsed.data.operationId } : {}),
    });
  }
  return new ApiError({
    code: "INTERNAL_ERROR",
    message: `request failed with status ${response.status}`,
    status: response.status,
    retryable: response.status >= 500,
  });
}

/** Same-origin JSON fetch that surfaces the server's safe error envelope. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw await parseApiError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "GET" });
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: extraHeaders,
  });
}
