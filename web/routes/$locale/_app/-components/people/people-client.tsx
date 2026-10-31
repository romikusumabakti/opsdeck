import { UsersRound } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { LocalTime } from "@/components/user/local-time";
import { UserAvatar } from "@/components/user/user-avatar";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { ORG_ROLES } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import type { PersonSummary } from "@/web/api/users";

const ALL = "__all";

export function PeopleClient({
  people,
  projects,
  showDeactivated,
}: {
  people: PersonSummary[];
  showDeactivated: boolean;
  projects: { id: string; name: string }[];
}) {
  const t = useTranslations("people");
  const tRole = useTranslations("users.role");
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState("");
  const [role, setRole] = useState(ALL);
  const [project, setProject] = useState(ALL);

  // Deactivated accounts are hidden by default; the switch only exists when
  // there are any (admins only receive them). State lives in ?deactivated=1.
  const hasDeactivated = people.some((p) => p.deactivated);
  function changeShowDeactivated(next: boolean) {
    router.replace(next ? `${pathname}?deactivated=1` : pathname);
  }

  const shown = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    return (
      people
        .filter(
          (p) =>
            (!needle ||
              [p.name, p.title ?? "", p.email].some((s) =>
                s.toLocaleLowerCase().includes(needle)
              )) &&
            (showDeactivated || !p.deactivated) &&
            (role === ALL || p.role === role) &&
            (project === ALL || p.projectIds.includes(project))
        )
        // Deactivated people (admins only see them) go last; the sort is
        // stable, so each group keeps the server's name order.
        .sort((a, b) => Number(a.deactivated) - Number(b.deactivated))
    );
  }, [people, q, role, project, showDeactivated]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Input
          className="max-w-xs"
          placeholder={t("search")}
          aria-label={t("search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Select value={role} onValueChange={(v) => setRole(v ?? ALL)}>
          <SelectTrigger className="w-40" aria-label={t("filterRole")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allRoles")}</SelectItem>
            {ORG_ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {tRole(r)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={project} onValueChange={(v) => setProject(v ?? ALL)}>
          <SelectTrigger className="w-48" aria-label={t("filterProject")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allProjects")}</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasDeactivated && (
          <Label className="ms-auto flex cursor-pointer items-center gap-2 text-sm font-normal">
            <Switch
              checked={showDeactivated}
              onCheckedChange={changeShowDeactivated}
            />
            {t("showDeactivated")}
          </Label>
        )}
      </div>
      {shown.length === 0 ? (
        <EmptyState icon={UsersRound} title={t("empty")} />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((p) => (
            <li key={p.id}>
              {/* The name link stretches over the whole card (after:inset-0),
                  so the card is one click target with no nested interactives. */}
              <Card
                className={cn(
                  "relative h-full transition-colors hover:bg-muted/40",
                  p.deactivated && "opacity-60"
                )}
              >
                <CardContent className="flex items-start gap-3">
                  <UserAvatar user={p} size="lg" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <Link
                      href={`/people/${p.id}`}
                      className="truncate font-medium after:absolute after:inset-0"
                    >
                      {p.name}
                    </Link>
                    {p.title && (
                      <span className="truncate text-sm text-muted-foreground">
                        {p.title}
                      </span>
                    )}
                    {p.status && (
                      <span className="truncate text-sm">
                        {p.status.emoji} {p.status.text}
                      </span>
                    )}
                    {/* A deactivated account has no hours worth showing. */}
                    {p.deactivated ? (
                      <Badge variant="secondary" className="w-fit">
                        {t("deactivated")}
                      </Badge>
                    ) : (
                      <div className="text-xs">
                        <LocalTime
                          timeZone={p.timeZone}
                          workingHours={p.workingHours}
                          compact
                        />
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
