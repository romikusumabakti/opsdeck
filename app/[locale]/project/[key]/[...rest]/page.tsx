import { redirect } from "next/navigation";

// Old issue permalinks were `/project/[key]/[number]`; issues now live under
// `/[KEY]/issues/[number]`. A numeric first segment is an issue number,
// anything else is forwarded verbatim under the project's root path.
export default async function LegacyProjectSubRedirect({
  params,
}: {
  params: Promise<{ locale: string; key: string; rest: string[] }>;
}) {
  const { locale, key, rest } = await params;
  const tail = /^\d+$/.test(rest[0])
    ? `issues/${rest.join("/")}`
    : rest.join("/");
  redirect(`/${locale}/${key.toUpperCase()}/${tail}`);
}
