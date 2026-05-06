import { NodeSSH } from "node-ssh";

const ssh = new NodeSSH();

export async function executeRemoteCommand(
  {
    host,
    username,
    password,
  }: { host: string; username: string; password: string },
  command: string
) {
  try {
    await ssh.connect({
      host,
      username,
      password,
      // privateKeyPath:
      //   process.env.SSH_PRIVATE_KEY_PATH ?? "C:/Users/Lenovo/.ssh/id_ed25519",
    });

    const result = await ssh.execCommand(command);

    if (result.code !== 0) {
      throw new Error(`SSH Command Failed: ${result.stderr}`);
    }

    return result.stdout;
  } catch (error) {
    console.error("SSH Error:", error);
    throw error;
  } finally {
    ssh.dispose();
  }
}

/**
 * Attempt to connect to an SSH server and return whether the credentials work.
 * Uses a fresh NodeSSH instance so it doesn't conflict with the singleton used
 * for `executeRemoteCommand`. Times out after 5s instead of hanging.
 */
export async function testSshConnection({
  host,
  username,
  password,
}: {
  host: string;
  username: string;
  password: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const client = new NodeSSH();
  try {
    await client.connect({
      host,
      username,
      password,
      readyTimeout: 5000,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: (error as Error).message ?? String(error) };
  } finally {
    client.dispose();
  }
}
