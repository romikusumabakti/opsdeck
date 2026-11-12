import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Theme = "dark" | "light" | "system";
type ResolvedTheme = "dark" | "light";

type ThemeContextValue = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
};

const DARK_QUERY = "(prefers-color-scheme: dark)";

// Without a provider (isolated component tests) the hook reports the defaults.
const ThemeProviderContext = createContext<ThemeContextValue>({
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => {},
});

function isTheme(value: string | null): value is Theme {
  return value === "dark" || value === "light" || value === "system";
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

// index.html applies the saved theme before the app loads, so a dark page
// doesn't open white; this provider takes over once it mounts.
export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "theme",
}: {
  children: ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(storageKey);
    return isTheme(stored) ? stored : defaultTheme;
  });
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    theme === "system" ? systemTheme() : theme
  );

  useEffect(() => {
    const apply = () => {
      const resolved = theme === "system" ? systemTheme() : theme;
      const root = document.documentElement;
      root.classList.toggle("dark", resolved === "dark");
      root.style.colorScheme = resolved;
      setResolvedTheme(resolved);
    };
    apply();
    if (theme !== "system") return;
    const media = window.matchMedia(DARK_QUERY);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  const setTheme = useCallback(
    (next: Theme) => {
      localStorage.setItem(storageKey, next);
      setThemeState(next);
    },
    [storageKey]
  );

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme]
  );

  return <ThemeProviderContext value={value}>{children}</ThemeProviderContext>;
}

export function useTheme(): ThemeContextValue {
  return use(ThemeProviderContext);
}
