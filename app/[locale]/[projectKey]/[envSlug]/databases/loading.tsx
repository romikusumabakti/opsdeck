import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { DatabasesTabsSkeleton } from "./databases-tabs-skeleton";

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <Card className="max-w-3xl w-full flex min-h-0 flex-col overflow-hidden">
        <CardContent className="flex flex-1 min-h-0 flex-col">
          <DatabasesTabsSkeleton />
        </CardContent>
      </Card>
    </>
  );
}
