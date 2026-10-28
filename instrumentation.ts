import { registerOTel } from "@vercel/otel";

export function register() {
  // On Vercel, spans show up in the project's built-in trace view. @vercel/otel also traces
  // outgoing fetch calls, which is how Upstash's REST requests appear under our spans.
  registerOTel({ serviceName: "link-shortener-api" });
}
