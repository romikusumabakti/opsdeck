import { inngest } from "@/inngest/client";

async function syncJenkinsData(email: string) {
  await inngest.send({
    name: "jenkins/sync.data",
    data: {
      email: "testUser@example.com",
    },
  });
}
