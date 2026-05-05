import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";

export interface InvitationEmailProps {
  recipientName: string;
  inviterName?: string | null;
  inviteUrl: string;
  expiresInHours: number;
}

export function InvitationEmail({
  recipientName,
  inviterName,
  inviteUrl,
  expiresInHours,
}: InvitationEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Anda diundang ke Admin Panel</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={heading}>Admin Panel</Heading>
          <Text style={paragraph}>Halo {recipientName},</Text>
          <Text style={paragraph}>
            {inviterName
              ? `${inviterName} mengundang Anda`
              : "Anda diundang"}{" "}
            untuk bergabung di Admin Panel. Klik tombol di bawah untuk membuat
            kata sandi dan mengaktifkan akun Anda.
          </Text>
          <Section style={{ textAlign: "center", margin: "32px 0" }}>
            <Button style={button} href={inviteUrl}>
              Aktifkan Akun
            </Button>
          </Section>
          <Text style={muted}>
            Link ini akan kadaluarsa dalam {expiresInHours} jam. Jika tombol
            tidak berfungsi, salin URL ini ke browser Anda:
          </Text>
          <Text style={link}>{inviteUrl}</Text>
          <Hr style={hr} />
          <Text style={footer}>
            Jika Anda tidak mengharapkan email ini, abaikan saja.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default InvitationEmail;

const body = {
  backgroundColor: "#f6f6f6",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
};

const container = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  padding: "32px",
  maxWidth: "560px",
  borderRadius: "8px",
};

const heading = {
  fontSize: "24px",
  fontWeight: 700,
  color: "#111111",
  marginBottom: "24px",
};

const paragraph = {
  fontSize: "14px",
  lineHeight: "22px",
  color: "#333333",
};

const button = {
  backgroundColor: "#111111",
  color: "#ffffff",
  padding: "12px 24px",
  borderRadius: "6px",
  textDecoration: "none",
  fontSize: "14px",
  fontWeight: 600,
};

const muted = {
  fontSize: "12px",
  color: "#666666",
  marginTop: "24px",
};

const link = {
  fontSize: "12px",
  color: "#0066cc",
  wordBreak: "break-all" as const,
};

const hr = {
  borderColor: "#eaeaea",
  margin: "32px 0",
};

const footer = {
  fontSize: "12px",
  color: "#999999",
};
