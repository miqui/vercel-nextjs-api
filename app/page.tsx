const endpoints = [
  ["POST", "/api/keys", "Create an API key (5 per hour per IP)"],
  ["POST", "/api/links", "Shorten a URL: { url, code? } (30 per minute per key)"],
  ["GET", "/api/links", "List your links with click counts"],
  ["GET", "/api/links/:code", "Get one link and its click count"],
  ["DELETE", "/api/links/:code", "Delete a link"],
  ["GET", "/:code", "Redirect to the original URL"],
];

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 16px", lineHeight: 1.6 }}>
      <h1>Link Shortener API</h1>
      <p>
        Authenticate with <code>Authorization: Bearer &lt;key&gt;</code>. Responses include{" "}
        <code>X-RateLimit-*</code> headers; over the limit you get <code>429</code> with{" "}
        <code>Retry-After</code>.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {endpoints.map(([method, path, description]) => (
            <tr key={method + path} style={{ borderTop: "1px solid #8884" }}>
              <td style={{ padding: "8px 8px 8px 0" }}>
                <code>{method}</code>
              </td>
              <td style={{ padding: 8 }}>
                <code>{path}</code>
              </td>
              <td style={{ padding: 8 }}>{description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
