import { execFileSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { basename } from "node:path";

/** What the machine knows about the reporter's project and identity, to find it in a draft. */
export interface DraftContext {
  /** Names of the repository, its owners, hosts, branch, the person and the account. */
  readonly terms: readonly string[];
  /** Whether a hexadecimal string names a commit of the repository. */
  readonly isCommit: (candidate: string) => boolean;
}

export type DraftFindingKind =
  | "project-or-person" | "email" | "absolute-path" | "internal-url" | "ip-address" | "secret" | "commit";

export interface DraftFinding {
  readonly line: number;
  readonly column: number;
  readonly kind: DraftFindingKind;
  /** The matched text, masked when it is a secret. */
  readonly excerpt: string;
}

const generic = new Set([
  "main", "master", "develop", "development", "trunk", "head", "origin", "upstream", "github", "gitlab",
  "bitbucket", "com", "org", "net", "www", "git", "ssh", "gmail", "googlemail", "outlook", "hotmail",
  "yahoo", "icloud", "proton", "protonmail", "live", "users", "user", "root", "admin", "runner",
  "dev", "qa", "uat", "test", "staging", "prod", "production", "release",
]);

const secretPatterns: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?(?!<)[^\s"'<>]{6,}/giu,
];

const patterns: readonly { readonly kind: DraftFindingKind; readonly pattern: RegExp }[] = [
  { kind: "email", pattern: /\b(?!git@)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/gu },
  { kind: "absolute-path", pattern: /(?<=^|[\s`'"(\[=])(?:\/[\w.@~+-]+){2,}\/?|\b[A-Za-z]:\\[\w .\\-]+/gu },
  { kind: "ip-address", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu },
];

/** Hosts that only resolve inside a private network. */
const internalHost = /^(?:[^.]+|.+\.(?:local|localhost|internal|intranet|corp|lan|home|private))$/iu;

/**
 * Finds what the reporting guide forbids and a machine can recognize: the repository's and the
 * person's names, emails, absolute paths, internal URLs, IP addresses, secrets and commits. It
 * cannot recognize every company or project name, so a person still reviews the draft.
 */
export function draftFindings(text: string, context: DraftContext, releaseRepository: string): readonly DraftFinding[] {
  const findings: DraftFinding[] = [];
  const add = (kind: DraftFindingKind, index: number, match: string) => {
    const before = text.slice(0, index);
    const line = before.split("\n").length;
    findings.push({ kind, line, column: index - before.lastIndexOf("\n"), excerpt: kind === "secret" ? mask(match) : match });
  };
  // The Railguard repository is public knowledge of every report, not the reporter's project.
  const railguard = new Set(releaseRepository.toLowerCase().split("/"));
  const terms = [...new Set(context.terms.map((term) => term.trim().toLowerCase()))]
    .filter((term) => term.length >= 3 && !generic.has(term) && !railguard.has(term));
  for (const term of terms) {
    for (const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, "giu"))) {
      add("project-or-person", match.index, match[0]);
    }
  }
  for (const pattern of secretPatterns) for (const match of text.matchAll(pattern)) add("secret", match.index, match[0]);
  for (const { kind, pattern } of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (kind === "ip-address" && !publicIpv4Leak(match[0])) continue;
      // A path that ends a sentence keeps its punctuation out of the excerpt.
      add(kind, match.index, kind === "absolute-path" ? match[0].replace(/[.,;:]+$/u, "") : match[0]);
    }
  }
  for (const match of text.matchAll(/\bhttps?:\/\/([^\s/:?#)>\]]+)[^\s)>\]]*/giu)) {
    if (internalHost.test(match[1] ?? "")) add("internal-url", match.index, match[0]);
  }
  for (const match of text.matchAll(/\b[0-9a-f]{7,40}\b/gu)) {
    if (context.isCommit(match[0])) add("commit", match.index, match[0]);
  }
  return findings.sort((left, right) => left.line - right.line || left.column - right.column);
}

/** Loopback and unspecified addresses name nothing; every other valid IPv4 address may. */
function publicIpv4Leak(address: string): boolean {
  const octets = address.split(".").map(Number);
  return octets.every((octet) => octet <= 255) && address !== "127.0.0.1" && address !== "0.0.0.0";
}

function mask(secret: string): string {
  return `${secret.slice(0, 4)}…(${secret.length} caracteres)`;
}

function escape(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Collects the draft context from Git and the operating system; what is unavailable is skipped. */
export function draftContext(root: string): DraftContext {
  const git = (...args: string[]): string | null => {
    try {
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const terms: string[] = [];
  const name = git("config", "user.name");
  if (name) terms.push(name, ...name.split(/\s+/u));
  const email = git("config", "user.email");
  if (email) terms.push(email, ...(email.split("@")[1]?.split(".").slice(0, -1) ?? []));
  for (const url of new Set((git("remote", "-v") ?? "").split("\n").map((line) => line.split(/\s+/u)[1] ?? ""))) {
    const remote = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:](.+?)(?:\.git)?\/?$/iu.exec(url);
    if (remote === null) continue;
    const segments = (remote[2] ?? "").split("/").filter(Boolean);
    const owners = segments.slice(0, -1);
    terms.push(...(remote[1] ?? "").split(".").slice(0, -1), segments.join("/"), ...segments);
    // Organization names often join the company with a team or region.
    terms.push(...owners.flatMap((owner) => owner.split(/[-_.]/u).filter((part) => part.length >= 5)));
  }
  const top = git("rev-parse", "--show-toplevel");
  if (top) terms.push(basename(top));
  const branch = git("branch", "--show-current");
  if (branch) terms.push(branch);
  try {
    terms.push(userInfo().username);
  } catch {
    // Some containers run with a user id that has no account name.
  }
  terms.push(basename(homedir()));
  return {
    terms,
    isCommit: (candidate) => top !== null && git("rev-parse", "--verify", "--quiet", `${candidate}^{commit}`) !== null,
  };
}

const findingLabels: Readonly<Record<DraftFindingKind, string>> = {
  "project-or-person": "nombre del repositorio, su organización o la persona",
  email: "correo",
  "absolute-path": "ruta absoluta",
  "internal-url": "URL interna",
  "ip-address": "dirección IP",
  secret: "posible secreto",
  commit: "commit del repositorio",
};

export function renderDraftFindings(draft: string, findings: readonly DraftFinding[]): string {
  if (findings.length === 0) {
    return "Sin hallazgos. Relea el borrador de todas formas: el check no reconoce nombres de empresa,\n" +
      "proyecto o personas que no estén en Git.\n";
  }
  return [
    ...findings.map((finding) => `${draft}:${finding.line}:${finding.column} ${findingLabels[finding.kind]}: ${finding.excerpt}`),
    "",
    `${findings.length} hallazgo(s). Reemplácelos por marcadores como <repo> o <modulo>, o quítelos, y vuelva a revisar.`,
    "",
  ].join("\n");
}
