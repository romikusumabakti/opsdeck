import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { greetingKey, hourIn } from "@/lib/home/layout";
import { callName } from "@/lib/user-display";
import { useBootstrap, useMe } from "@/web/api/session";

/**
 * The Home header: a greeting by the user's preferred name in their time
 * zone. No icon (the robot means the Assistant) and no subtitle.
 */
export function HomeHeader({ action }: { action?: React.ReactNode }) {
  const t = useTranslations("homePage");
  const me = useMe();
  const { appTimeZone } = useBootstrap();
  const key = greetingKey(hourIn(me?.timeZone ?? appTimeZone, new Date()));
  const name = me
    ? callName({
        name: me.user.name,
        preferredName: me.user.preferredName ?? null,
      })
    : "";
  return <PageHeader title={t(`greeting.${key}`, { name })} action={action} />;
}
