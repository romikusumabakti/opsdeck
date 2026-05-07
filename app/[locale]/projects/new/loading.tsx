import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function FieldSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

function SectionSkeleton({ fields = 4 }: { fields?: number }) {
  return (
    <section className="flex flex-col gap-4">
      <Skeleton className="h-4 w-32" />
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: fields }, (_, i) => (
          <FieldSkeleton key={i} />
        ))}
      </div>
    </section>
  );
}

export default function Loading() {
  return (
    <div className="max-w-4xl py-8 mx-auto w-full px-4">
      <div className="flex flex-col gap-2 mb-6">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent className="flex flex-col gap-8">
          <SectionSkeleton fields={1} />
          <SectionSkeleton fields={6} />
          <SectionSkeleton fields={3} />
          <SectionSkeleton fields={3} />
          <div className="flex justify-end gap-2">
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-9 w-32" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
