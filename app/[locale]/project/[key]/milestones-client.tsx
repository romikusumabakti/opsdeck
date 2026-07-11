"use client";

import { format } from "date-fns";
import { CircleCheck, CircleDot, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  createMilestone,
  deleteMilestone,
  type MilestoneWithCount,
  setMilestoneClosed,
} from "@/actions/milestones";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useRouter } from "@/i18n/navigation";

export function MilestonesClient({
  projectId,
  initialMilestones,
}: {
  projectId: string;
  initialMilestones: MilestoneWithCount[];
}) {
  const t = useTranslations("milestones");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [due, setDue] = useState("");

  function run(
    action: () => Promise<{ success: boolean; message?: string }>,
    okMsg?: string
  ) {
    startTransition(async () => {
      const result = await action();
      if (result.success) {
        if (okMsg) toast.success(okMsg);
        router.refresh();
      } else {
        toast.error(result.message ?? t("errorGeneric"));
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Create */}
      <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
        <div className="flex min-w-52 flex-1 flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {t("name")}
          </span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("namePlaceholder")}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {t("dueDate")}
          </span>
          <Input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="w-40"
          />
        </div>
        <Button
          disabled={!name.trim() || isPending}
          onClick={() => {
            run(
              () =>
                createMilestone({
                  projectId,
                  name: name.trim(),
                  dueAt: due || null,
                }),
              t("created")
            );
            setName("");
            setDue("");
          }}
        >
          <Plus className="size-4" />
          {t("add")}
        </Button>
      </div>

      {/* List */}
      {initialMilestones.length === 0 ? (
        <EmptyState title={t("empty")} description={t("emptyDescription")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colName")}</TableHead>
              <TableHead className="w-40">{t("colDue")}</TableHead>
              <TableHead className="w-24">{t("colIssues")}</TableHead>
              <TableHead className="w-28">{t("colStatus")}</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {initialMilestones.map((m) => {
              const closed = m.closedAt !== null;
              return (
                <TableRow key={m.id}>
                  <TableCell>
                    <span className="font-medium">{m.name}</span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {m.dueAt ? (
                      format(new Date(m.dueAt), "PP")
                    ) : (
                      <span className="italic">{t("noDue")}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {m.issueCount}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isPending}
                      className="h-7 gap-1.5"
                      onClick={() =>
                        run(
                          () => setMilestoneClosed(m.id, !closed),
                          closed ? t("reopenedMsg") : t("closedMsg")
                        )
                      }
                    >
                      {closed ? (
                        <CircleCheck className="size-3.5 text-success" />
                      ) : (
                        <CircleDot className="size-3.5 text-amber-500" />
                      )}
                      {closed ? t("closed") : t("open")}
                    </Button>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={isPending}
                      aria-label={t("delete")}
                      onClick={() =>
                        run(() => deleteMilestone(m.id), t("deletedMsg"))
                      }
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
