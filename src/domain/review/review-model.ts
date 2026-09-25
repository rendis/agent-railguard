import type {
  CatalogComponent,
  CatalogSnapshot,
} from "../catalog/model.js";
import type { ReadyResolution, ResolvedComponent } from "../resolution/model.js";
import {
  compareUtf8,
  type ComponentRef,
  type Sha256Digest,
} from "../shared/types.js";
import type { DurableProjectPlan, TransactionOperation } from "../transaction/model.js";

export interface ReviewComponent {
  readonly ref: ComponentRef;
  readonly version: string;
  readonly applicability: ResolvedComponent["applicability"]["kind"];
  readonly trust: CatalogComponent["trust"];
  readonly causes: readonly {
    readonly kind: "includes" | "requires";
    readonly from: ComponentRef;
    readonly reason: string;
  }[];
}

export interface ReviewChange {
  readonly action: "create" | "replace" | "remove";
  readonly kind: "directory" | "file" | "symlink" | "managed-section" | "json-member" | "git-config";
  readonly path: string;
  /** Managed section id, or the dotted key of a JSON member. */
  readonly section: string | null;
  readonly owner: string;
}

export interface ReviewModel {
  readonly planId: Sha256Digest;
  readonly mode: "reconcile" | "repair" | "remove";
  readonly direct: readonly ReviewComponent[];
  readonly required: readonly ReviewComponent[];
  readonly changes: readonly ReviewChange[];
  readonly gitConfig: readonly {
    readonly key: "core.hooksPath";
    readonly action: "set" | "unset";
    readonly value: string | null;
  }[];
  readonly hooks: readonly {
    readonly component: ComponentRef;
    readonly event: "pre-commit" | "pre-push";
    readonly command: string;
  }[];
  readonly runtimes: readonly {
    readonly component: ComponentRef;
    readonly connection:
      | { readonly type: "stdio"; readonly command: readonly string[] }
      | { readonly type: "remote-http"; readonly url: string };
    readonly timing: "harness-runtime";
    readonly network: "runtime-required";
    readonly auth: "none" | "oauth";
  }[];
  readonly prerequisites: readonly string[];
  readonly applyExecutes: readonly string[];
}

export function buildReviewModel(input: {
  readonly catalog: CatalogSnapshot;
  readonly resolution: ReadyResolution;
  readonly plan: Extract<DurableProjectPlan, { readonly kind: "ready" }>;
}): ReviewModel {
  const catalogByRef = new Map(input.catalog.components.map((component) => [component.ref, component]));
  const components = input.resolution.components.map((resolved) =>
    reviewComponent(resolved, requireComponent(catalogByRef, resolved.ref)),
  );
  const resolvedCatalog = input.resolution.components.map((resolved) =>
    requireComponent(catalogByRef, resolved.ref),
  );
  const gitOperations = input.plan.operations.filter(
    (operation): operation is Extract<TransactionOperation, { readonly kind: "configure-git" }> =>
      operation.kind === "configure-git",
  );

  return Object.freeze({
    planId: input.plan.id,
    mode: input.plan.mode,
    direct: Object.freeze(
      components.filter((_, index) => input.resolution.components[index]?.direct === true),
    ),
    required: Object.freeze(
      components.filter((_, index) => input.resolution.components[index]?.direct === false),
    ),
    changes: Object.freeze(
      input.plan.operations.map(reviewChange).sort((left, right) =>
        compareUtf8(`${left.path}\0${left.owner}`, `${right.path}\0${right.owner}`),
      ),
    ),
    gitConfig: Object.freeze(
      gitOperations.map((operation) =>
        Object.freeze({
          key: operation.key,
          action: operation.value === null ? ("unset" as const) : ("set" as const),
          value: operation.value,
        }),
      ),
    ),
    hooks: Object.freeze(
      resolvedCatalog
        .filter((component) => component.kind === "git-gate")
        .map((component) =>
          Object.freeze({
            component: component.ref,
            event: component.event,
            command: `railguard ${component.operation} --changed`,
          }),
        )
        .sort((left, right) => compareUtf8(left.event, right.event)),
    ),
    runtimes: Object.freeze(
      resolvedCatalog
        .filter((component) => component.kind === "mcp-integration")
        .map((component) =>
          Object.freeze({
            component: component.ref,
            connection: component.connection.type === "stdio"
              ? Object.freeze({
                  type: "stdio" as const,
                  command: Object.freeze([
                    component.connection.command,
                    ...component.connection.args,
                  ]),
                })
              : Object.freeze({
                  type: "remote-http" as const,
                  url: component.connection.url,
                }),
            timing: "harness-runtime" as const,
            network: component.network,
            auth: component.auth.type,
          }),
        )
        .sort((left, right) => compareUtf8(left.component, right.component)),
    ),
    prerequisites: Object.freeze(
      [...new Set(
        resolvedCatalog.flatMap((component) =>
          component.kind === "verification-profile" ? component.executables : [],
        ),
      )].sort(compareUtf8),
    ),
    applyExecutes: Object.freeze(
      gitOperations.map((operation) =>
        operation.value === null
          ? `git config --local --unset-all ${operation.key}`
          : `git config --local ${operation.key} ${operation.value}`,
      ),
    ),
  });
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function reviewComponent(
  resolved: ResolvedComponent,
  component: CatalogComponent,
): ReviewComponent {
  return Object.freeze({
    ref: resolved.ref,
    version: resolved.version,
    applicability: resolved.applicability.kind,
    trust: component.trust,
    causes: Object.freeze(
      resolved.includedBy.map((cause) =>
        Object.freeze({ kind: cause.kind, from: cause.from, reason: cause.reason }),
      ),
    ),
  });
}

function reviewChange(operation: TransactionOperation): ReviewChange {
  if (operation.kind === "create-directory") {
    return Object.freeze({
      action: "create",
      kind: "directory",
      path: operation.path,
      section: null,
      owner: operation.unitId,
    });
  }
  if (operation.kind === "remove-directory") {
    return Object.freeze({
      action: "remove",
      kind: "directory",
      path: operation.path,
      section: null,
      owner: operation.unitId,
    });
  }
  if (operation.kind === "configure-git") {
    return Object.freeze({
      action: operation.value === null ? "remove" : "replace",
      kind: "git-config",
      path: operation.path,
      section: null,
      owner: operation.unitId,
    });
  }
  if (operation.kind === "write-symlink" || operation.kind === "remove-symlink") {
    return Object.freeze({
      action: operation.kind === "remove-symlink"
        ? "remove"
        : operation.before.kind === "absent" ? "create" : "replace",
      kind: "symlink",
      path: operation.path,
      section: null,
      owner: operation.unitId,
    });
  }
  return Object.freeze({
    action:
      operation.kind === "remove-file"
        ? "remove"
        : operation.before.kind === "absent"
          ? "create"
          : "replace",
    kind: operation.target.kind,
    path: operation.path,
    section: operation.target.kind === "managed-section"
      ? operation.target.sectionId
      : operation.target.kind === "json-member"
        ? operation.target.pointer.join(".")
        : null,
    owner: operation.unitId,
  });
}

function requireComponent(
  byRef: ReadonlyMap<ComponentRef, CatalogComponent>,
  ref: ComponentRef,
): CatalogComponent {
  const component = byRef.get(ref);
  if (component === undefined) throw new TypeError(`Resolution/catalog mismatch: ${ref}`);
  return component;
}
