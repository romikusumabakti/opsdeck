import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

// next-themes renders an inline script that applies the saved theme before
// hydration. A client-rendered app never runs it (index.html does that job
// instead), and React warns about a script it won't execute unless the tag is
// a data block — which, here, it effectively is.
const INERT_SCRIPT = { type: "application/json" };

export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider scriptProps={INERT_SCRIPT} {...props}>
      {children}
    </NextThemesProvider>
  );
}
