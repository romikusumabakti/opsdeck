import Link from "next/link";

// Root 404. Rendered outside the locale layout / i18n context, so copy is
// hardcoded English and styling is inline to stay dependency-light.
export default function NotFound() {
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
        fontFamily:
          "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
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
        href="/"
        style={{
          fontSize: 14,
          fontWeight: 500,
          textDecoration: "underline",
        }}
      >
        Go back home
      </Link>
    </main>
  );
}
