// Built by tests/build-server.test.ts with the server's build options and run
// under NODE_ENV=production, like dist/server in the image.
import { render } from "react-email";
import { InvitationEmail } from "@/lib/email/templates/invitation";

const html = await render(
  InvitationEmail({
    appName: "Menara",
    recipientName: "Rina",
    inviteUrl: "https://example.com/invite",
    expiresInHours: 24,
  })
);
console.log(html.includes("https://example.com/invite") ? "rendered" : html);
