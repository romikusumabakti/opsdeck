import { getServerSession } from "@/lib/auth-session";
import { redirect } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChangePasswordForm } from "./change-password-form";

export default async function ChangePasswordPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in?redirect=/account/change-password");

  return (
    <div className="max-w-xl py-8">
      <Card>
        <CardHeader>
          <CardTitle>Ubah Password</CardTitle>
          <CardDescription>
            Masukkan password lama dan password baru Anda.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>
    </div>
  );
}
