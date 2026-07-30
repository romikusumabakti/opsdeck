import { redirect } from "next/navigation";

// The project overview used to live at the singular `/project/[key]`; projects
// are now the root of their own namespace (`/[KEY]`). Old links — including
// issue hrefs already stored in the notifications table — forward from here.
export default async function LegacyProjectRedirect({
  params,
}: {
  params: Promise<{ locale: string; key: string }>;
}) {
  const { locale, key } = await params;
  redirect(`/${locale}/${key.toUpperCase()}`);
}
