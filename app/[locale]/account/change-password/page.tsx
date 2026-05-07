import { redirect } from "@/i18n/navigation";

export default async function ChangePasswordPage() {
  await redirect("/account?tab=security");
}
