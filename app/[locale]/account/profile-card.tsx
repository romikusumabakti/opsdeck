import { Mail, UserRound } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type UserSummary = {
  id: string;
  name: string;
  email: string;
  emailVerified?: boolean | null;
  image?: string | null;
};

function getInitials(value: string) {
  return value
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export async function ProfileCard({ user }: { user: UserSummary }) {
  const t = await getTranslations("account.profile");
  const tCommon = await getTranslations("common");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription className="mt-1">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-start gap-4">
          <span className="size-16 rounded-full bg-muted flex items-center justify-center text-xl font-semibold shrink-0">
            {getInitials(user.name || user.email)}
          </span>
          <div className="flex flex-col gap-1.5 min-w-0 flex-1 pt-1">
            <div className="flex items-center gap-2 min-w-0">
              <UserRound className="size-4 text-muted-foreground shrink-0" />
              <span className="font-medium truncate">{user.name}</span>
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <Mail className="size-4 text-muted-foreground shrink-0" />
              <span className="text-sm text-muted-foreground truncate">
                {user.email}
              </span>
              {user.emailVerified && (
                <Badge variant="secondary" className="text-xs">
                  {tCommon("verified")}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t("nameManagedByAdmin")}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
