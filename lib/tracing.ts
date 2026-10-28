import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

const tracer = trace.getTracer("link-shortener-api");

/**
 * Runs `fn` inside an active span, so spans it starts become children. Exceptions are
 * recorded on the span and rethrown. Without a registered tracer provider this is a no-op.
 */
export function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
