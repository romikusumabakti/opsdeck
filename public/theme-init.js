// The saved theme (the storage key and values of ThemeProvider), applied
// before the app loads so a dark page doesn't open white. ThemeProvider
// takes over once it mounts.
try {
  const theme = localStorage.getItem("theme");
  const dark =
    theme === "dark" ||
    (theme !== "light" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.classList.add("dark");
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
} catch (_) {}
