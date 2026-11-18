/** Outbound HTTP for integrations; swappable in tests. */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> }>;

let impl: FetchLike = (url, init) => fetch(url, init as RequestInit) as any;
export const http: FetchLike = (url, init) => impl(url, init);
export function setFetch(f: FetchLike) { impl = f; }

export class IntegrationError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}
