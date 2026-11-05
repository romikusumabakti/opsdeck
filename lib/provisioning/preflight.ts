// Facts gathered from a server by the preflight scan; stored in
// servers.preflight. Non-secret by construction.
export type ServerPreflight = {
  runtime: {
    docker: string | null;
    compose: string | null;
    podman: string | null;
  };
  registry: { url: string; ok: boolean; status: number | null } | null;
  disk: { mount: string; freeBytes: number; totalBytes: number }[];
  cloudflared: { systemd: boolean; containers: string[] };
  listeningPorts: number[];
  publishedPorts: number[];
  postgresCandidates: { container: string; image: string }[];
};
