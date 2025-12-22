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
