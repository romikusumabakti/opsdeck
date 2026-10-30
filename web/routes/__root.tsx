import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { resolveRedirect } from "@/lib/redirects";
import { RootError, RootNotFound } from "@/web/components/fallback-screens";
import { PendingScreen } from "@/web/components/pending-screen";

export type RouterContext = { queryClient: QueryClient };

export const Route = createRootRouteWithContext<RouterContext>()({
  // The server answers these with a real HTTP redirect (server/static.ts);
  // this catches the same URLs reached by client-side navigation and under
  // the Vite dev server.
  beforeLoad: ({ location }) => {
    const target = resolveRedirect(location.pathname);
    if (target) {
      throw redirect({ href: target.to + location.searchStr, replace: true });
    }
  },
  component: RootComponent,
  errorComponent: RootError,
  notFoundComponent: RootNotFound,
  pendingComponent: PendingScreen,
});

function RootComponent() {
  return (
    <>
      <HeadContent />
      <Outlet />
    </>
  );
}
