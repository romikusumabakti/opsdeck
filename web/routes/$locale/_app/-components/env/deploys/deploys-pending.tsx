import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const CARDS = 2;
const ROWS = 5;

/** Loading state shaped like the target cards: title, focal line, rows. */
export function DeploysPending() {
  return (
    <>
      <PageHeaderSkeleton withAction />
      <div className="flex flex-col gap-4">
        {Array.from({ length: CARDS }, (_, card) => (
          <Card key={card}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-72 max-w-full" />
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {Array.from({ length: ROWS }, (_, row) => (
                <Skeleton
                  key={row}
                  data-slot="timeline-row-skeleton"
                  className="h-9 w-full"
                />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
