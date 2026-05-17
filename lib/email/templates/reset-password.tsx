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
import { APP_NAME } from "@/lib/branding";

export interface ResetPasswordEmailProps {
  recipientName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export function ResetPasswordEmail({
  recipientName,
  resetUrl,
  expiresInMinutes,
}: ResetPasswordEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Reset kata sandi {APP_NAME}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={heading}>{APP_NAME}</Heading>
          <Text style={paragraph}>Halo {recipientName},</Text>
          <Text style={paragraph}>
            Kami menerima permintaan untuk mereset kata sandi akun Anda. Klik
            tombol di bawah untuk membuat kata sandi baru.
          </Text>
          <Section style={{ textAlign: "center", margin: "32px 0" }}>
            <Button style={button} href={resetUrl}>
              Reset kata sandi
            </Button>
          </Section>
          <Text style={muted}>
            Link ini akan kadaluarsa dalam {expiresInMinutes} menit. Jika tombol
            tidak berfungsi, salin URL ini ke browser Anda:
          </Text>
          <Text style={link}>{resetUrl}</Text>
          <Hr style={hr} />
          <Text style={footer}>
            Jika Anda tidak meminta reset kata sandi, abaikan email ini — kata
            sandi Anda tidak akan berubah.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default ResetPasswordEmail;

const body = {
  backgroundColor: "#f6f6f6",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
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
