import type { CatalogComponent } from "../domain/catalog/model.js";
import {
  compareUtf8,
  relativePosixPath,
  type ComponentRef,
  type Diagnostic,
  type LanguageId,
} from "../domain/shared/types.js";
import { diagnostic, errorMessage, type LoadedComponent } from "./loaders/shared.js";

export function validateCatalog(
  loaded: readonly LoadedComponent[],
  supportedLanguages: ReadonlySet<LanguageId>,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const byRef = new Map<ComponentRef, LoadedComponent[]>();
  for (const entry of loaded) {
    const values = byRef.get(entry.component.ref) ?? [];
    values.push(entry);
    byRef.set(entry.component.ref, values);
  }
  for (const [ref, entries] of byRef) {
    if (entries.length > 1) {
      diagnostics.push(
        diagnostic({
          code: "catalog.identity.duplicate",
          phase: "catalog",
          message: "Two source directories normalize to the same component identity.",
          path: entries[0]!.sourceDirectory,
          subjects: [ref],
          evidence: entries.map((entry) => entry.sourceDirectory),
        }),
      );
    }
  }

  const uniqueComponents = new Map(
    [...byRef.entries()]
      .filter(([, entries]) => entries.length === 1)
      .map(([ref, entries]) => [ref, entries[0] as LoadedComponent]),
  );
  const sectionOwners = new Map<string, LoadedComponent>();
  const groupOwners = new Map<string, LoadedComponent>();
  for (const entry of loaded) {
    if (entry.component.kind !== "instruction-fragment") continue;
    const canonicalSection = `${entry.component.content.group}.mapping`;
    if (entry.component.section !== canonicalSection) {
      diagnostics.push(
        diagnostic({
          code: "catalog.instruction-fragment.section-noncanonical",
          phase: "catalog",
          message: "A grouped instruction mapping must use its canonical managed section ID.",
          path: relativePosixPath("railguard.yaml"),
          pointer: `${entry.authoringPointer}/section`,
          subjects: [entry.component.ref],
          evidence: [entry.component.section, canonicalSection],
        }),
      );
    }
    const previousGroupOwner = groupOwners.get(entry.component.content.group);
    if (previousGroupOwner !== undefined) {
      diagnostics.push(
        diagnostic({
          code: "catalog.instruction-fragment.group-duplicate",
          phase: "catalog",
          message: "Only one managed instruction mapping may own a component group.",
          path: relativePosixPath("railguard.yaml"),
          pointer: `${entry.authoringPointer}/content/group`,
          subjects: [previousGroupOwner.component.ref, entry.component.ref],
          evidence: [entry.component.content.group],
        }),
      );
    } else {
      groupOwners.set(entry.component.content.group, entry);
    }
    const previousOwner = sectionOwners.get(entry.component.section);
    if (previousOwner !== undefined) {
      diagnostics.push(
        diagnostic({
          code: "catalog.instruction-fragment.section-duplicate",
          phase: "catalog",
          message: "Two instruction fragments cannot own the same managed section.",
          path: relativePosixPath("railguard.yaml"),
          pointer: `${entry.authoringPointer}/section`,
          subjects: [previousOwner.component.ref, entry.component.ref],
          evidence: [entry.component.section],
        }),
      );
    } else {
      sectionOwners.set(entry.component.section, entry);
    }
  }
  for (const entry of loaded) {
    const component = entry.component;
    for (const language of component.applies?.languages ?? []) {
      if (!supportedLanguages.has(language)) {
        diagnostics.push(
          diagnostic({
            code: "catalog.language.unknown",
            phase: "catalog",
            message: "The catalog declares a language with no registered stack adapter.",
            path: relativePosixPath("railguard.yaml"),
            pointer: `${entry.authoringPointer}/applies/languages`,
            subjects: [component.ref],
            evidence: [language],
          }),
        );
      }
    }

    if (component.kind === "verification-profile") {
      for (const input of component.inputs) {
        let pattern: RegExp;
        try {
          pattern = new RegExp(input.itemPattern, "u");
        } catch (error) {
          diagnostics.push(
            diagnostic({
              code: "catalog.input.pattern-invalid",
              phase: "catalog",
              message: "A verification input declares an invalid item pattern.",
              path: relativePosixPath("railguard.yaml"),
              pointer: `${entry.authoringPointer}/inputs/${input.id}/item_pattern`,
              subjects: [component.ref],
              evidence: [errorMessage(error)],
            }),
          );
          continue;
        }
        const rejectedDefaults = input.default.filter((value) => !pattern.test(value));
        if (rejectedDefaults.length > 0) {
          diagnostics.push(
            diagnostic({
              code: "catalog.input.default-invalid",
              phase: "catalog",
              message: "A verification input default is rejected by its item pattern.",
              path: relativePosixPath("railguard.yaml"),
              pointer: `${entry.authoringPointer}/inputs/${input.id}/default`,
              subjects: [component.ref],
              evidence: rejectedDefaults,
            }),
          );
        }
      }
      const checkIds = component.checks.map((check) => check.id);
      const duplicateChecks = checkIds.filter((id, index) => checkIds.indexOf(id) !== index);
      if (duplicateChecks.length > 0) {
        diagnostics.push(
          diagnostic({
            code: "catalog.verification-profile.check-duplicate",
            phase: "catalog",
            message: "Every check of a verification profile needs a unique id.",
            path: relativePosixPath("railguard.yaml"),
            pointer: `${entry.authoringPointer}/checks`,
            subjects: [component.ref],
            evidence: [...new Set(duplicateChecks)].sort(compareUtf8),
          }),
        );
      }
    }

    const targets = new Set<ComponentRef>();
    for (const relation of component.relations) {
      if (relation.target === component.ref || targets.has(relation.target)) {
        diagnostics.push(
          diagnostic({
            code: "catalog.relation.invalid",
            phase: "catalog",
            message: "A relation cannot be a self-reference or duplicate a target.",
            path: relativePosixPath("railguard.yaml"),
            pointer: `${entry.authoringPointer}/relations`,
            subjects: [component.ref],
            evidence: [relation.target],
          }),
        );
      }
      targets.add(relation.target);
      if (!uniqueComponents.has(relation.target)) {
        diagnostics.push(
          diagnostic({
            code: "catalog.relation.target-missing",
            phase: "catalog",
            message: "A relation target does not exist in the same catalog snapshot.",
            path: relativePosixPath("railguard.yaml"),
            pointer: `${entry.authoringPointer}/relations`,
            subjects: [component.ref],
            evidence: [relation.target],
          }),
        );
      }
    }

    if (component.kind === "git-gate") {
      const requiredProfiles = component.relations
        .filter((relation) => relation.kind === "requires")
        .map((relation) => uniqueComponents.get(relation.target)?.component)
        .filter(
          (target): target is Extract<CatalogComponent, { readonly kind: "verification-profile" }> =>
            target?.kind === "verification-profile",
        );
      if (requiredProfiles.length !== 1) {
        diagnostics.push(
          diagnostic({
            code: "catalog.git-gate.profile-invalid",
            phase: "catalog",
            message: "A Git gate must require exactly one verification profile.",
            path: relativePosixPath("railguard.yaml"),
            pointer: `${entry.authoringPointer}/relations`,
            subjects: [component.ref],
            evidence: component.relations
              .filter((relation) => relation.kind === "requires")
              .map((relation) => relation.target),
          }),
        );
      }
    }
  }

  const cycle = findHardCycle([...uniqueComponents.values()].map((entry) => entry.component));
  if (cycle !== null) {
    diagnostics.push(
      diagnostic({
        code: "catalog.graph.cycle",
        phase: "catalog",
        message: "The hard dependency graph contains a cycle.",
        path: null,
        subjects: cycle,
        evidence: cycle,
      }),
    );
  }
  return diagnostics;
}

function findHardCycle(components: readonly CatalogComponent[]): readonly ComponentRef[] | null {
  const graph = new Map<ComponentRef, readonly ComponentRef[]>(
    components.map((component) => [
      component.ref,
      Object.freeze(
        component.relations
          .filter((relation) => relation.kind === "requires" || relation.kind === "includes")
          .map((relation) => relation.target)
          .sort(compareUtf8),
      ),
    ]),
  );
  const visited = new Set<ComponentRef>();
  const active = new Set<ComponentRef>();
  const stack: ComponentRef[] = [];

  const visitNode = (node: ComponentRef): readonly ComponentRef[] | null => {
    if (active.has(node)) {
      const start = stack.indexOf(node);
      return Object.freeze([...stack.slice(start), node]);
    }
    if (visited.has(node)) {
      return null;
    }
    active.add(node);
    stack.push(node);
    for (const target of graph.get(node) ?? []) {
      if (!graph.has(target)) {
        continue;
      }
      const cycle = visitNode(target);
      if (cycle !== null) {
        return cycle;
      }
    }
    stack.pop();
    active.delete(node);
    visited.add(node);
    return null;
  };

  for (const node of [...graph.keys()].sort(compareUtf8)) {
    const cycle = visitNode(node);
    if (cycle !== null) {
      return cycle;
    }
  }
  return null;
}
