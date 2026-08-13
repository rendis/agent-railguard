import { NodeUpdateInstaller } from "./node-update-installer.js";
import { ReleaseClient } from "./release-client.js";
import { UpdateService } from "./update-service.js";

export function createUpdateServiceFromEnvironment(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): UpdateService {
  const manifestUrl = environment.AI_HARNESS_RELEASE_MANIFEST_URL?.trim();
  const installer = new NodeUpdateInstaller({
    ...(environment.AI_HARNESS_PNPM_COMMAND === undefined
      ? {}
      : { pnpmCommand: environment.AI_HARNESS_PNPM_COMMAND }),
  });
  if (manifestUrl === undefined || manifestUrl.length === 0) {
    return new UpdateService(null, installer);
  }
  const timeoutMs = parseTimeout(environment.AI_HARNESS_RELEASE_TIMEOUT_MS);
  const client = new ReleaseClient({
    manifestUrl,
    timeoutMs,
    allowFileUrl: environment.AI_HARNESS_ALLOW_FILE_RELEASES === "1",
    allowInsecureLoopback: environment.AI_HARNESS_ALLOW_LOOPBACK_RELEASES === "1",
  });
  return new UpdateService(client, installer);
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value.length === 0) return 3_000;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new TypeError("AI_HARNESS_RELEASE_TIMEOUT_MS must be a positive integer");
  }
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout > 60_000) {
    throw new TypeError("AI_HARNESS_RELEASE_TIMEOUT_MS must not exceed 60000");
  }
  return timeout;
}
