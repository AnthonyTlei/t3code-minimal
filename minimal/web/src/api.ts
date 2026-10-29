const TOKEN_KEY = "t3-minimal-session-token";

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

export function initialToken() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("token");
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  return token || sessionStorage.getItem(TOKEN_KEY) || "";
}

export function saveToken(token: string) {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export async function request<T>(token: string, path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method, signal, credentials: "omit", redirect: "error",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let value: unknown;
  try { value = await response.json(); } catch { throw new ApiError("The local server returned an unreadable response.", response.status); }
  if (!response.ok) {
    const error = (value as { error?: { message?: string; code?: string } }).error;
    throw new ApiError(error?.message || "The local request failed.", response.status, error?.code);
  }
  return value as T;
}

export async function events(token: string, signal: AbortSignal, onEvent: (event: unknown) => void) {
  const response = await fetch("/api/events", { headers: { Authorization: `Bearer ${token}` }, signal, credentials: "omit", redirect: "error" });
  if (!response.ok || !response.body) throw new ApiError("The local event connection is unavailable.", response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      let end: number;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const frame = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data) onEvent(JSON.parse(data));
      }
      if (buffered.length > 40 * 1024 * 1024) throw new Error("The event response exceeded the local safety limit.");
    }
  } finally { reader.releaseLock(); }
  if (!signal.aborted) throw new Error("The local event connection ended.");
}
