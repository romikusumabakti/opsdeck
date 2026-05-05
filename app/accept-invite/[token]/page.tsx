import { getInvitationByToken } from "@/actions/users";
import { AcceptInviteForm } from "./accept-invite-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Aperture } from "lucide-react";

export default async function AcceptInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const inv = await getInvitationByToken(token);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2 mb-2">
            <Aperture />
            <span className="font-bold">Admin Panel</span>
          </div>
          {inv ? (
            <>
              <CardTitle>Aktivasi Akun</CardTitle>
              <CardDescription>
                Buat password untuk akun <strong>{inv.email}</strong>
              </CardDescription>
            </>
          ) : (
            <>
              <CardTitle>Undangan Tidak Valid</CardTitle>
              <CardDescription>
                Link undangan ini tidak valid atau sudah kadaluarsa.
              </CardDescription>
            </>
          )}
        </CardHeader>
        {inv && (
          <CardContent>
            <AcceptInviteForm
              token={token}
              email={inv.email}
              name={inv.name}
            />
          </CardContent>
        )}
      </Card>
    </div>
  );
}
