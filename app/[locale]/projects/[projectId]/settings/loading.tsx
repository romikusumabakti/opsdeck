import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <div className="flex flex-col gap-6 max-w-2xl w-full">
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent className="flex flex-col gap-8">
            <FormSection fields={1} />
            <FormSection fields={6} />
            <FormSection fields={4} />
            <FormSection fields={3} />
            <div className="flex justify-end gap-2">
              <Skeleton className="h-9 w-24" />
              <Skeleton className="h-9 w-28" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-destructive/50">
          <CardHeader>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-9 w-36" />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function FormSection({ fields }: { fields: number }) {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-4 w-24" />
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: fields }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
