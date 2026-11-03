import { z } from "zod";
import {
  composeServiceSchema,
  deployDirSchema,
  deployTagSchema,
  envVarNameSchema,
} from "@/lib/deploy/validation";
import { shq } from "@/lib/sh";

/**
 * Builds the one POSIX `sh` script a deploy runs on a Docker Compose host over
 * SSH. Pure: no SSH, no database. It is the part that decides what executes on
 * a client's server, so it validates its whole input and quotes every
 * interpolated value with `shq` — except `preStartCommand`, which is
 * maintainer-entered target config and is inserted verbatim by design.
 *
 * Invariants the tests hold it to: it never runs `compose down/stop/rm`, it
 * only (re)starts the listed services (`--no-deps`), the only `.env` line it
 * touches is the tag variable, and a stack that never turns healthy makes it
 * exit non-zero within `healthTimeoutSeconds`.
 */

export interface DeployScriptInput {
  registry: string;
  bundleImage: string;
  tag: string;
  deployDir: string;
  services: string[];
  tagVariable: string;
  preStartCommand: string | null;
  healthUrl: string | null;
  healthTimeoutSeconds: number;
}

const HEALTH_POLL_SECONDS = 5;

// Registry host[:port] and a repository path, as Docker accepts them. Not
// shared schemas: only this builder composes an image reference.
const registrySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})(?::[0-9]{1,5})?$/,
    "Registry must be host[:port]"
  );
const imageNameSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*$/,
    "Bundle image must be a lowercase repository path"
  )
  .max(255);

const deployScriptInputSchema = z.object({
  registry: registrySchema,
  bundleImage: imageNameSchema,
  tag: deployTagSchema,
  deployDir: deployDirSchema,
  services: z.array(composeServiceSchema).min(1),
  tagVariable: envVarNameSchema,
  preStartCommand: z.string().nullable(),
  healthUrl: z.url({ protocol: /^https?$/ }).nullable(),
  healthTimeoutSeconds: z.number().int().min(1).max(3600),
});

/** Throws a ZodError when any field of the input is invalid. */
export function buildDeployScript(input: DeployScriptInput): string {
  const v = deployScriptInputSchema.parse(input);
  const image = shq(`${v.registry}/${v.bundleImage}:${v.tag}`);
  const services = v.services.map(shq).join(" ");
  const envLine = `${v.tagVariable}=${v.tag}`;
  // Tag and variable name are regex-restricted, so neither can carry the `|`
  // delimiter, `&`, `\` or a newline into the sed expression.
  const sedExpr = `s|^${v.tagVariable}=.*|${envLine}|`;
  const preStart = v.preStartCommand?.trim() ? v.preStartCommand : null;

  const lines = [
    "set -eu",
    `cd ${shq(v.deployDir)}`,

    // 1. Deploy bundle: compose.yaml and friends, extracted into the deploy dir.
    `docker pull ${image}`,
    `cid=$(docker create ${image} noop)`,
    `docker cp "$cid":/bundle/. .`,
    `docker rm "$cid" >/dev/null`,

    // 2. The tag variable — the only .env line the Panel ever changes.
    `if [ -f .env ] && grep -q ${shq(`^${v.tagVariable}=`)} .env; then`,
    `  sed -i ${shq(sedExpr)} .env`,
    "else",
    // Keep the previous last line intact when .env lacks a trailing newline.
    `  if [ -s .env ] && [ -n "$(tail -c 1 .env)" ]; then echo >> .env; fi`,
    `  printf '%s\\n' ${shq(envLine)} >> .env`,
    "fi",

    // 3. Images, then the optional pre-start hook, then only the listed services.
    `docker compose pull ${services}`,
    ...(preStart === null ? [] : [preStart]),
    `docker compose up -d --no-deps ${services}`,

    // 4. Health: every listed service running and healthy (or without a
    //    healthcheck), plus the health URL if one is set.
    `deadline=$(( $(date +%s) + ${v.healthTimeoutSeconds} ))`,
    "while :; do",
    "  ok=1",
    `  status=$(docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' ${services}) || ok=0`,
    `  for svc in ${services}; do`,
    `    printf '%s\\n' "$status" | awk -v s="$svc" '$1 == s { n++; if (!($2 == "running" && ($3 == "" || $3 == "healthy"))) bad = 1 } END { exit !(n > 0 && !bad) }' || ok=0`,
    "  done",
    ...(v.healthUrl === null
      ? []
      : [
          `  if [ "$ok" = 1 ]; then curl -fsS -o /dev/null --max-time 5 ${shq(v.healthUrl)} || ok=0; fi`,
        ]),
    `  if [ "$ok" = 1 ]; then echo 'HEALTHY'; exit 0; fi`,
    "  now=$(date +%s)",
    `  if [ "$now" -ge "$deadline" ]; then echo 'HEALTH TIMEOUT'; exit 1; fi`,
    "  left=$(( deadline - now ))",
    `  sleep $(( left < ${HEALTH_POLL_SECONDS} ? left : ${HEALTH_POLL_SECONDS} ))`,
    "done",
  ];
  return `${lines.join("\n")}\n`;
}
