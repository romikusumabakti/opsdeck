import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { DatabasesTabsSkeleton } from "./databases-tabs-skeleton";

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <Card className="max-w-3xl w-full">
        <CardContent>
          <DatabasesTabsSkeleton />
        </CardContent>
      </Card>
    </>
  );
}
