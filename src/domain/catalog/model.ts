import type {
  CapabilityId,
  ComponentRef,
  Diagnostic,
  LanguageId,
  ReadonlyBytes,
  RelativePosixPath,
  SemVer,
  Sha256Digest,
} from "../shared/types.js";

export type CatalogRelationKind =
  | "includes"
  | "requires"
  | "recommends"
  | "composes"
  | "conflicts";

export interface CatalogRelation {
  readonly kind: CatalogRelationKind;
  readonly target: ComponentRef;
  readonly reason: string;
}

export interface CatalogFile {
  readonly path: RelativePosixPath;
  readonly mode: "100644" | "100755";
  readonly digest: Sha256Digest;
  readonly bytes: ReadonlyBytes;
}

export interface CatalogPayload {
  readonly entry: RelativePosixPath;
  readonly files: readonly CatalogFile[];
}

interface CatalogComponentBase {
  readonly ref: ComponentRef;
  readonly version: SemVer;
  readonly description: string;
  readonly details: string;
  readonly capabilities: readonly CapabilityId[];
  readonly applies: { readonly languages: readonly LanguageId[] } | null;
  readonly relations: readonly CatalogRelation[];
  readonly integrity: {
    readonly definition: Sha256Digest;
    readonly payload: Sha256Digest;
    readonly component: Sha256Digest;
  };
}

export interface CatalogSkillComponent extends CatalogComponentBase {
  readonly kind: "skill";
  readonly trust: "passive";
  readonly payload: CatalogPayload;
}

export interface CatalogVerificationProfileComponent extends CatalogComponentBase {
  readonly kind: "verification-profile";
  readonly trust: "project-write";
  readonly payload: null;
  readonly executables: readonly string[];
  readonly inputs: readonly CatalogInputDefinition[];
  readonly checks: readonly CatalogCheck[];
}

/** One deterministic check a verification profile contributes to `railguard check|verify`. */
export interface CatalogCheck {
  readonly id: string;
  readonly kind: string;
  readonly stage: "check" | "verify";
  readonly params: Readonly<Record<string, string | number | boolean>>;
}

export interface CatalogInputDefinition {
  readonly id: string;
  readonly type: "string-list";
  readonly default: readonly string[];
  readonly itemPattern: string;
}

export interface CatalogGitGateComponent extends CatalogComponentBase {
  readonly kind: "git-gate";
  readonly trust: "local-git-execution";
  readonly payload: null;
  readonly event: "pre-commit" | "pre-push";
  readonly operation: "check" | "verify";
}

/** A coding-agent lifecycle hook that runs a verification operation on the change. */
export interface CatalogAgentHookComponent extends CatalogComponentBase {
  readonly kind: "agent-hook";
  readonly trust: "local-agent-execution";
  readonly payload: null;
  readonly event: "stop";
  readonly operation: "check" | "verify";
}

export interface CatalogMcpIntegrationComponent extends CatalogComponentBase {
  readonly kind: "mcp-integration";
  readonly trust: "third-party-network";
  readonly payload: null;
  readonly connection:
    | {
        readonly type: "stdio";
        readonly command: string;
        readonly args: readonly string[];
      }
    | {
        readonly type: "remote-http";
        readonly url: string;
      };
  readonly tools: readonly string[];
  readonly network: "runtime-required";
  readonly auth:
    | { readonly type: "none" }
    | { readonly type: "oauth"; readonly activation: "harness-native" };
}

export type CatalogInstructionGroup = "skills" | "mcps" | "agents" | "automation" | "quality";

export interface CatalogInstructionContent {
  readonly kind: "catalog-index";
  readonly group: CatalogInstructionGroup;
}

export interface CatalogInstructionFragmentComponent extends CatalogComponentBase {
  readonly kind: "instruction-fragment";
  readonly trust: "project-write";
  readonly payload: null;
  readonly section: string;
  readonly content: CatalogInstructionContent;
}

export interface CatalogPackComponent extends CatalogComponentBase {
  readonly kind: "pack";
  readonly trust: "passive";
  readonly payload: null;
}

export interface CatalogAgentComponent extends CatalogComponentBase {
  readonly kind: "agent";
  readonly trust: "agent-instruction";
  readonly payload: null;
  readonly prompt: string;
}

export type CatalogComponent =
  | CatalogSkillComponent
  | CatalogMcpIntegrationComponent
  | CatalogVerificationProfileComponent
  | CatalogGitGateComponent
  | CatalogAgentHookComponent
  | CatalogInstructionFragmentComponent
  | CatalogPackComponent
  | CatalogAgentComponent;

export interface CatalogSnapshot {
  readonly revision: SemVer;
  readonly digest: Sha256Digest;
  readonly components: readonly CatalogComponent[];
}

export type CatalogLoadResult =
  | {
      readonly kind: "ready";
      readonly catalog: CatalogSnapshot;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly kind: "invalid";
      readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
    };

export interface Catalog {
  load(): Promise<CatalogLoadResult>;
}
