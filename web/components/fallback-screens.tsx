import {
  type ErrorComponentProps,
  Link,
  useRouter,
} from "@tanstack/react-router";

// Error and 404 screens that work without the locale's messages: the root
// route's boundaries, and the $locale route's when its own loader failed.

const SYSTEM_FONT =
  "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

// The last-resort error screen (the port of app/global-error.tsx). It renders
// outside the locale route and its messages, so the copy is hardcoded English
// and the styling inline. error.message is never shown: it can carry
// internals, and the server logs the real cause.
export function RootError({ reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: SYSTEM_FONT,
        background: "#0a0a0a",
        color: "#fafafa",
      }}
    >
      <div style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px" }}>
          Something went wrong
        </h1>
        <p style={{ margin: "0 0 20px", color: "#a1a1a1", fontSize: 14 }}>
          An unexpected error occurred. Please try again. If the problem
          persists, contact your administrator.
        </p>
        <button
          type="button"
          onClick={() => {
            // reset() clears the boundary; invalidate() re-runs the loaders
            // that threw, so "try again" really retries.
            reset();
            void router.invalidate();
          }}
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
      </div>
    </main>
  );
}

// The 404 for URLs outside any locale (the port of app/not-found.tsx): an
// unknown locale segment, mostly. Hardcoded English for the same reason.
export function RootNotFound() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        textAlign: "center",
        padding: 24,
        fontFamily: SYSTEM_FONT,
      }}
    >
      <p style={{ fontSize: 14, fontWeight: 600, letterSpacing: 1, margin: 0 }}>
        404
      </p>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
        Page not found
      </h1>
      <p style={{ fontSize: 14, color: "#71717a", margin: "0 0 8px" }}>
        The page you are looking for does not exist or has been moved.
      </p>
      <Link
        to="/"
        style={{ fontSize: 14, fontWeight: 500, textDecoration: "underline" }}
      >
        Go back home
      </Link>
    </main>
  );
}
