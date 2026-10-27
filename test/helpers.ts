import { NextRequest } from "next/server";

export const BASE_URL = "http://localhost:3000";

type RequestOptions = {
  body?: unknown;
  rawBody?: string;
  key?: string;
  ip?: string;
  headers?: Record<string, string>;
};

export function request(method: string, path: string, options: RequestOptions = {}): NextRequest {
  const headers = new Headers(options.headers);
  if (options.key) headers.set("authorization", `Bearer ${options.key}`);
  if (options.ip) headers.set("x-forwarded-for", options.ip);
  let body: string | undefined = options.rawBody;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set("content-type", "application/json");
  }
  return new NextRequest(new URL(path, BASE_URL), { method, headers, body });
}

export function routeContext<T extends Record<string, string>>(params: T) {
  return { params: Promise.resolve(params) };
}
