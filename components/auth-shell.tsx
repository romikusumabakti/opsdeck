import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { PublicFrame } from "@/components/public-frame";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";

/**
 * Shared frame for the unauthenticated pages (sign-in, setup, password reset,
 * invitation). Keeping it in one place means the brand lockup, card width and
 * vertical rhythm stay identical across them.
 *
 * The card is not centred on the exact vertical midpoint: the two flexible
 * spacers grow at a 4:5 ratio, which parks it slightly above centre where the
 * eye expects it. On short viewports both spacers collapse and the content
 * simply flows from the top.
 *
 * It sits in PublicFrame, which brings the motif corners and the footer row
 * with the copyright and the locale/theme controls.
 */
export function AuthShell({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <PublicFrame>
      <div className="flex-1 flex flex-col px-4 pt-6">
        <div className="grow-[4]" />
        <main className="w-full max-w-md mx-auto">
          <BrandMark className="mb-6 justify-center" />
          <Card>
            <CardHeader>
              {/* Rendered as the page's `h1`: `CardTitle` is a plain `div`,
                  which would leave these pages with no top-level heading. */}
              <h1
                data-slot="card-title"
                className="text-xl leading-none font-semibold"
              >
                {title}
              </h1>
              {description ? (
                <CardDescription>{description}</CardDescription>
              ) : null}
            </CardHeader>
            {children ? <CardContent>{children}</CardContent> : null}
          </Card>
        </main>
        <div className="grow-[5]" />
      </div>
    </PublicFrame>
  );
}
