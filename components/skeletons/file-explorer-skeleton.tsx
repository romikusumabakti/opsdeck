import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Route-level loading state for the file explorer pages. Without it the nearest
// ancestor loading.tsx takes over — and that one draws the *detail* page for the
// server or bucket, so browsing files would flash a form that is never going to
// appear. Mirrors the explorer's own in-component skeleton (toolbar, bounded
// card, sticky header, four columns) so the two hand over without a shift.
export function FileExplorerSkeleton() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <div className="flex flex-1 min-h-0 flex-col gap-4">
        <div className="shrink-0 flex flex-wrap items-center justify-between gap-2">
          <Skeleton className="h-5 w-56" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-8 w-24" />
          </div>
        </div>
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-md border bg-card">
          <Table containerClassName="flex-1 min-h-0">
            <TableHeader className="sticky top-0 z-10 [&_th]:bg-card [&_th]:border-b">
              <TableRow>
                <TableHead>
                  <Skeleton className="h-4 w-16" />
                </TableHead>
                <TableHead className="w-32">
                  <Skeleton className="ml-auto h-4 w-10" />
                </TableHead>
                <TableHead className="w-48">
                  <Skeleton className="h-4 w-16" />
                </TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from({ length: 8 }, (_, i) => (
                <TableRow key={`sk-${i}`}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Skeleton className="size-4 shrink-0 rounded-sm" />
                      <Skeleton className="h-4 w-40" />
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Skeleton className="ml-auto h-4 w-12" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="size-8 rounded-md" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </>
  );
}
