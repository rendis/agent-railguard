import packageJson from "../../package.json" with { type: "json" };

/** Version of this engine; every release tag must match it. */
export const engineVersion: string = packageJson.version;

/** GitHub `owner/repo` whose releases publish the engine binaries. */
export const releaseRepository: string = packageJson.repository.replace(/^github:/, "");
