"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useIssueDialog } from "./home-issue-dialog";

export function NewIssueButton() {
  const t = useTranslations("homePage");
  const issueDialog = useIssueDialog();
  if (!issueDialog.canCreate) return null;
  return (
    <Button onClick={() => issueDialog.open()}>
      <Plus />
      {t("newIssue")}
    </Button>
  );
}
