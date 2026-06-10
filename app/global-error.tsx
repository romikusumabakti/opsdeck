"use client";

// Root error boundary. This renders OUTSIDE the locale layout (and thus outside
// the i18n provider), so copy is hardcoded English and it must supply its own
// <html>/<body>. We never surface error.message to the user — only the opaque
// digest, which is safe to show and useful for correlating with server logs.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          background: "#0a0a0a",
          color: "#fafafa",
        }}
      >
        <main
          style={{
            maxWidth: 420,
            padding: 24,
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px" }}>
            Something went wrong
          </h1>
          <p style={{ margin: "0 0 20px", color: "#a1a1a1", fontSize: 14 }}>
            An unexpected error occurred. Please try again. If the problem
            persists, contact your administrator.
          </p>
          {error.digest ? (
            <p
              style={{
                margin: "0 0 20px",
                color: "#737373",
                fontSize: 12,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              cursor: "pointer",
              border: "1px solid #2e2e2e",
              borderRadius: 6,
              background: "#fafafa",
              color: "#0a0a0a",
              padding: "8px 16px",
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
