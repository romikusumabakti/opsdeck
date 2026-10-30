import type { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setApiNavigator } from "@/web/api/client";
import {
  LocaleErrorContent,
  LocaleNotFoundContent,
} from "@/web/components/locale-fallbacks";
import { PendingScreen } from "@/web/components/pending-screen";
import { queryClient } from "@/web/query-client";
import { routeTree } from "@/web/routeTree.gen";
import { parseSearch, stringifySearch } from "@/web/search-params";

export function createAppRouter(client: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient: client },
    // Hovering a link preloads its route — loaders and their queries — the
    // way next/link prefetched. TanStack Query owns freshness, so the router
    // keeps no preload cache of its own.
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: PendingScreen,
    // A page's own boundaries, unless it brings its own: they render where
    // the page would, so inside the app shell. Every route that uses them
    // sits below $locale and its IntlProvider.
    defaultErrorComponent: LocaleErrorContent,
    defaultNotFoundComponent: LocaleNotFoundContent,
    scrollRestoration: true,
    // In the app shell `<main>`, not the window, scrolls.
    scrollToTopSelectors: ["#main-content"],
    parseSearch,
    stringifySearch,
  });
}

export const router = createAppRouter(queryClient);

// A 401 from the API goes to sign-in without reloading the app.
setApiNavigator((href) => {
  void router.navigate({ href });
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
