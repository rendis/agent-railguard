import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  changedFilesInUnit,
  isLineChanged,
  type ChangedLines,
  type CheckOutcome,
  type CheckProvider,
  type CheckRequest,
  type FullCheck,
  type FullCheckRequest,
  type ProcessResult,
  type ProcessRunner,
} from "../../../domain/verification/checks.js";
import { changedLineCoverage, lineRanges, parseCoverProfile } from "./go-coverage.js";
import { goFullCheck } from "./go-full-checks.js";

const minute = 60_000;
const golangciConfigs = [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"];

/**
 * Go implementations of the verification check kinds declared by the catalog: `run` judges only
 * what a change touched; `full` is the shell that judges a whole module in the verify script.
 */
export class GoCheckProvider implements CheckProvider {
  public readonly kinds = [
    "go-format",
    "go-vet",
    "go-test",
    "go-mod-verify",
    "golangci-lint",
    "go-coverage",
    "govulncheck",
    "go-fuzz",
    "go-mutation",
    "go-e2e",
    "go-imports",
  ] as const;

  public constructor(private readonly process: ProcessRunner) {}

  public full(kind: string, request: FullCheckRequest): FullCheck {
    return goFullCheck(kind, request);
  }

  public async run(kind: string, request: CheckRequest): Promise<CheckOutcome> {
    const unit = new GoUnit(request, this.process);
    switch (kind) {
      case "go-format":
        return await unit.format();
      case "go-vet":
        return await unit.vet();
      case "go-test":
        return await unit.test(request.params.race === true);
      case "go-mod-verify":
        return await unit.modVerify();
      case "golangci-lint":
        return await unit.lint();
      case "go-coverage":
        return await unit.coverage();
      case "govulncheck":
        return await unit.vulnerabilities();
      case "go-fuzz":
        return await unit.fuzz();
      case "go-mutation":
        return await unit.mutation();
      case "go-e2e":
        return await unit.e2e();
      case "go-imports":
        return await unit.imports();
      default:
        return unavailable(`Unknown Go check kind ${kind}`);
    }
  }
}

class GoUnit {
  readonly #request: CheckRequest;
  readonly #process: ProcessRunner;
  readonly #dir: string;
  readonly #changed: ReadonlyMap<string, ChangedLines>;

  public constructor(request: CheckRequest, process: ProcessRunner) {
    this.#request = request;
    this.#process = process;
    this.#dir = request.unitRoot === "." ? request.repositoryRoot : join(request.repositoryRoot, request.unitRoot);
    this.#changed = changedFilesInUnit(request.changes, request.unitRoot);
  }

  public async format(): Promise<CheckOutcome> {
    const files = this.#changedGoFiles();
    if (files.length === 0) return skipped("No Go file changed");
    const unformatted: string[] = [];
    for (const batch of chunks(files, 200)) {
      const result = await this.#run("gofmt", ["-l", ...batch], 5 * minute);
      if (result.exitCode !== 0) return failed("gofmt could not read the sources", output(result));
      unformatted.push(...lines(result.stdout).filter((file) => !ignoredByGo(file)));
    }
    return unformatted.length === 0
      ? passed(`${files.length} Go file(s) formatted`)
      : failed(`${unformatted.length} Go file(s) need gofmt`, unformatted.map((file) => `gofmt -w ${file}`));
  }

  public async vet(): Promise<CheckOutcome> {
    const packages = await this.#packages();
    if (packages.length === 0) return skipped("No Go package changed");
    const result = await this.#run("go", ["vet", ...packages], 10 * minute);
    return result.exitCode === 0
      ? passed(`go vet passed for ${describePackages(packages)}`)
      : failed(`go vet reported problems in ${describePackages(packages)}`, output(result));
  }

  public async test(race: boolean): Promise<CheckOutcome> {
    const packages = await this.#packages();
    if (packages.length === 0) return skipped("No Go package changed");
    const flags = race ? ["-race", "-shuffle=on"] : [];
    const result = await this.#run("go", ["test", "-count=1", ...flags, ...packages], 30 * minute);
    const label = race ? "Race-enabled tests" : "Tests";
    return result.exitCode === 0
      ? passed(`${label} passed for ${describePackages(packages)}`)
      : failed(`${label} failed for ${describePackages(packages)}`, output(result));
  }

  public async modVerify(): Promise<CheckOutcome> {
    if (!this.#dependenciesChanged()) return skipped("go.mod and go.sum unchanged");
    const result = await this.#run("go", ["mod", "verify"], 10 * minute);
    return result.exitCode === 0 ? passed("Module checksums verified") : failed("go mod verify failed", output(result));
  }

  public async lint(): Promise<CheckOutcome> {
    if (this.#changedGoFiles().length === 0) return skipped("No Go file changed");
    const config = golangciConfigs.find((name) => existsSync(join(this.#dir, name)));
    if (config === undefined) {
      return unavailable(
        "No golangci-lint configuration in the module root",
        ["Create .golangci.yml (the configure-go-quality skill provides the default)."],
      );
    }
    const tool = await this.#tool("golangci-lint");
    if (tool.status !== "ready") return tool.outcome;
    const base = this.#request.changes.base;
    const newOnly = base === null ? [] : [`--new-from-rev=${base}`];
    const result = await this.#run("go", [...tool.prefix, "golangci-lint", "run", "--config", config, ...newOnly, "./..."], 15 * minute);
    if (result.exitCode === 0) {
      return passed(newOnly.length === 0 ? "golangci-lint found no issue" : "golangci-lint found no new issue");
    }
    return failed(
      newOnly.length === 0 ? "golangci-lint reported issues" : "golangci-lint reported issues introduced by this change",
      output(result),
    );
  }

  public async coverage(): Promise<CheckOutcome> {
    const changedSources = new Map([...this.#changed].filter(([file]) => isProductionGoFile(file)));
    if (changedSources.size === 0) return skipped("No production Go file changed");
    const modulePath = await this.#modulePath();
    if (modulePath === null) return unavailable("go.mod has no module directive");
    const scratch = await mkdtemp(join(tmpdir(), "railguard-coverage-"));
    try {
      const profilePath = join(scratch, "coverage.out");
      const coverPackages = [...new Set([
        ...this.#input("core_cover_packages", ["./internal/core/..."]),
        ...this.#input("overall_cover_packages", ["./cmd/...", "./internal/..."]),
      ])];
      const testPackages = this.#input("test_packages", ["./..."]);
      const result = await this.#run("go", [
        "test", "-count=1", "-covermode=set", `-coverpkg=${coverPackages.join(",")}`,
        `-coverprofile=${profilePath}`, ...testPackages,
      ], 30 * minute);
      let profile: string;
      try {
        profile = await readFile(profilePath, "utf8");
      } catch {
        return failed("Tests did not produce a coverage profile", output(result));
      }
      const blocks = parseCoverProfile(profile, modulePath);
      const corePatterns = this.#input("core_packages", []);
      const isCore = (file: string) => corePatterns.some((pattern) => matchesPackagePattern(posix.dirname(file), pattern));
      const coreMin = numberParam(this.#request.params.core_min, 100);
      const warnings = result.exitCode === 0 ? [] : ["Some tests failed; coverage only counts the tests that ran."];
      // A changed file without blocks has no statements, unless its package never ran: a build or
      // test failure leaves the package out of the profile, which must not read as covered.
      const measured = new Set(blocks.map((block) => posix.dirname(block.file)));
      const inCoverPackages = (file: string) =>
        coverPackages.some((pattern) => matchesPackagePattern(posix.dirname(file), pattern));
      const changedFiles = [...changedSources.keys()].sort();
      const unitPath = (file: string) => posix.join(this.#request.unitRoot, file);
      const unmeasured = result.exitCode === 0
        ? []
        : changedFiles.filter((file) => inCoverPackages(file) && !measured.has(posix.dirname(file)));
      if (unmeasured.length > 0) {
        return failed("Coverage of changed files could not be measured", [
          ...unmeasured.map((file) => `${unitPath(file)}: its package did not build or its tests did not run`),
          ...output(result),
        ]);
      }
      const outside = changedFiles
        .filter((file) => !inCoverPackages(file))
        .map((file) => `${unitPath(file)}: not measured, outside core_cover_packages and overall_cover_packages`);
      const changedMin = numberParam(this.#request.params.changed_min, 80);
      const core = changedLineCoverage(blocks, changedSources, isCore);
      const other = changedLineCoverage(blocks, changedSources, (file) => !isCore(file));
      const problems = [
        ...belowThreshold("changed core lines", core, coreMin),
        ...belowThreshold("changed lines", other, changedMin),
      ];
      const uncovered = [...core.uncovered, ...other.uncovered]
        .map(([file, missing]) => `${unitPath(file)}: uncovered lines ${lineRanges(missing)}`);
      const summary = `Changed-line coverage: core ${percent(core)}, other ${percent(other)}` +
        (outside.length === 0 ? "" : `; ${outside.length} changed file(s) not measured`);
      return problems.length === 0
        ? passed(summary, [...outside, ...warnings])
        : failed(summary, [...problems, ...uncovered, ...outside, ...warnings]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  public async vulnerabilities(): Promise<CheckOutcome> {
    if (!this.#dependenciesChanged()) return skipped("go.mod and go.sum unchanged");
    const tool = await this.#tool("govulncheck");
    if (tool.status !== "ready") return tool.outcome;
    const result = await this.#run("go", [...tool.prefix, "govulncheck", "./..."], 15 * minute);
    return result.exitCode === 0
      ? passed("No reachable known vulnerability")
      : failed("govulncheck reported reachable vulnerabilities", output(result));
  }

  public async fuzz(): Promise<CheckOutcome> {
    const cases = this.#input("cases", ["disabled"]).filter((value) => value !== "disabled");
    if (cases.length === 0) return skipped("No fuzz case configured");
    const changedPackages = new Set(this.#changedGoFiles().map(packageDirectory));
    const selected = cases
      .map((value) => {
        const [pkg, target, duration] = value.split(":");
        return { pkg: pkg!, target: target!, duration: duration! };
      })
      .filter((entry) => changedPackages.has(normalizePackage(entry.pkg)));
    if (selected.length === 0) return skipped("No fuzz case targets a changed package");
    for (const entry of selected) {
      const result = await this.#run(
        "go",
        ["test", "-run=^$", `-fuzz=^${entry.target}$`, `-fuzztime=${entry.duration}`, entry.pkg],
        30 * minute,
      );
      if (result.exitCode !== 0) return failed(`Fuzz case ${entry.target} failed in ${entry.pkg}`, output(result));
    }
    return passed(`${selected.length} fuzz case(s) passed`);
  }

  public async mutation(): Promise<CheckOutcome> {
    const scope = this.#input("packages", ["./..."]);
    const packages = [...new Set(this.#changedGoFiles().filter(isProductionGoFile).map(packageDirectory))]
      .filter((dir) => scope.some((pattern) => matchesPackagePattern(dir, pattern)));
    if (packages.length === 0) return skipped("No production package in the mutation scope changed");
    const tool = await this.#tool("gremlins");
    if (tool.status !== "ready") return tool.outcome;
    const modulePath = await this.#modulePath();
    const config = existsSync(join(this.#dir, ".gremlins.yaml")) ? ["--config", ".gremlins.yaml"] : [];
    const scratch = await mkdtemp(join(tmpdir(), "railguard-mutation-"));
    const survivors: string[] = [];
    let killed = 0;
    try {
      for (const [index, dir] of packages.sort().entries()) {
        const report = join(scratch, `report-${index}.json`);
        const result = await this.#run(
          "go",
          [...tool.prefix, "gremlins", ...config, "unleash", "--silent", "-o", report, packagePattern(dir)],
          60 * minute,
        );
        let parsed: GremlinsReport;
        try {
          parsed = JSON.parse(await readFile(report, "utf8")) as GremlinsReport;
        } catch {
          return failed(`Gremlins produced no report for ${packagePattern(dir)}`, output(result));
        }
        for (const file of parsed.files ?? []) {
          const path = mutationFile(file.file_name, dir, modulePath, this.#dir);
          for (const mutation of file.mutations ?? []) {
            if (!isLineChanged(this.#changed.get(path), mutation.line)) continue;
            if (mutation.status === "KILLED" || mutation.status === "TIMED_OUT") killed += 1;
            if (mutation.status === "LIVED" || mutation.status === "NOT_COVERED") {
              survivors.push(`${posix.join(this.#request.unitRoot, path)}:${mutation.line}:${mutation.column} ${mutation.type} ${mutation.status}`);
            }
          }
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    return survivors.length === 0
      ? passed(`${killed} mutant(s) killed on changed lines`)
      : failed(`${survivors.length} mutant(s) survived on changed lines`, survivors);
  }

  public async e2e(): Promise<CheckOutcome> {
    const packages = this.#input("packages", ["disabled"]).filter((value) => value !== "disabled");
    if (packages.length === 0) return skipped("No end-to-end package configured");
    if (this.#changed.size === 0) return skipped("Module unchanged");
    const result = await this.#run("go", ["test", "-count=1", "-tags=e2e", "-timeout=5m", ...packages], 10 * minute);
    return result.exitCode === 0
      ? passed(`End-to-end suites passed for ${describePackages(packages)}`)
      : failed("End-to-end suites failed", output(result));
  }

  /**
   * Dependency direction: files in core packages may import only the standard library (minus
   * transport and persistence packages), other core packages and explicitly allowed modules;
   * `forbidden_imports` adds `from -> to` package rules
   * for any other layering. Test files are exempt, and only changed files are judged.
   */
  public async imports(): Promise<CheckOutcome> {
    const modulePath = await this.#modulePath();
    if (modulePath === null) return unavailable("go.mod has no module directive");
    const core = this.#input("core_packages", []).filter((value) => value !== "disabled");
    const allowed = this.#input("core_allowed_imports", []).filter((value) => value !== "none");
    const deniedStandard = this.#input("core_denied_stdlib", []).filter((value) => value !== "none");
    const rules = this.#input("forbidden_imports", []).filter((value) => value !== "none").flatMap((rule) => {
      const [from, to] = rule.split("->").map((part) => part.trim());
      return from === undefined || to === undefined ? [] : [{ from, to, rule }];
    });
    if (core.length === 0 && rules.length === 0) return skipped("No dependency rule configured");
    const sources = this.#changedGoFiles()
      .filter((file) => existsSync(join(this.#dir, file)))
      .filter(isProductionGoFile);
    if (sources.length === 0) return skipped("No production Go file to judge");
    const violations: string[] = [];
    for (const file of sources) {
      const dir = packageDirectory(file);
      const inCore = core.some((pattern) => matchesPackagePattern(dir, pattern));
      const applicable = rules.filter((rule) => matchesPackagePattern(dir, rule.from));
      if (!inCore && applicable.length === 0) continue;
      const imports = goImports(await readFile(join(this.#dir, file), "utf8"));
      for (const imported of imports) {
        const internal = imported === modulePath || imported.startsWith(`${modulePath}/`);
        const target = internal ? imported.slice(modulePath.length + 1) || "." : null;
        if (inCore && isStandardLibrary(imported)) {
          if (deniedStandard.some((prefix) => imported === prefix || imported.startsWith(`${prefix}/`))) {
            violations.push(`${posix.join(this.#request.unitRoot, file)}: core imports ${imported}`);
          }
        } else if (inCore) {
          const allowedImport = target === null
            ? allowed.some((prefix) => imported === prefix || imported.startsWith(`${prefix}/`))
            : core.some((pattern) => matchesPackagePattern(target, pattern));
          if (!allowedImport) violations.push(`${posix.join(this.#request.unitRoot, file)}: core imports ${imported}`);
        }
        for (const rule of applicable) {
          if (target !== null && matchesPackagePattern(target, rule.to)) {
            violations.push(`${posix.join(this.#request.unitRoot, file)}: imports ${imported} (forbidden by "${rule.rule}")`);
          }
        }
      }
    }
    return violations.length === 0
      ? passed(`Dependency rules hold for ${sources.length} file(s)`)
      : failed(`${violations.length} forbidden import(s)`, violations);
  }

  /** Packages to vet and test: those that contain a changed Go file. */
  async #packages(): Promise<string[]> {
    const dirs = [...new Set(this.#changedGoFiles().map(packageDirectory))];
    if (dirs.length === 0) return [];
    const listed = await this.#listPackages(dirs.map(packagePattern));
    return listed.filter((entry) => entry.files > 0).map((entry) => packagePattern(entry.dir));
  }

  async #listPackages(patterns: readonly string[]): Promise<{ dir: string; files: number }[]> {
    const result = await this.#run(
      "go",
      ["list", "-e", "-f", "{{.Dir}}\t{{len .GoFiles}}\t{{len .TestGoFiles}}\t{{len .XTestGoFiles}}", ...patterns],
      5 * minute,
    );
    return lines(result.stdout).flatMap((line) => {
      const [dir, ...counts] = line.split("\t");
      if (dir === undefined || !dir.startsWith(this.#dir)) return [];
      const relative = dir === this.#dir ? "." : dir.slice(this.#dir.length + 1).split("\\").join("/");
      return [{ dir: relative, files: counts.reduce((total, count) => total + Number(count), 0) }];
    });
  }

  async #tool(name: string): Promise<
    | { readonly status: "ready"; readonly prefix: readonly string[] }
    | { readonly status: "unavailable"; readonly outcome: CheckOutcome }
  > {
    const modfile = this.#input("tool_modfile", ["go.mod"])[0] ?? "go.mod";
    const prefix = ["tool", `-modfile=${modfile}`];
    const probe = await this.#run("go", [...prefix, "-n", name], minute);
    if (probe.exitCode === 0) return { status: "ready", prefix };
    return {
      status: "unavailable",
      outcome: unavailable(`${name} is not a tool of ${modfile}`, [
        `Pin it with: go get -tool -modfile=${modfile} <module>@<version>`,
      ]),
    };
  }

  async #modulePath(): Promise<string | null> {
    try {
      const source = await readFile(join(this.#dir, "go.mod"), "utf8");
      return /^\s*module\s+(?:"([^"]+)"|(\S+))/m.exec(source)?.slice(1).find((value) => value !== undefined) ?? null;
    } catch {
      return null;
    }
  }

  #changedGoFiles(): string[] {
    return [...this.#changed.keys()].filter((file) => file.endsWith(".go") && !ignoredByGo(file)).sort();
  }

  #dependenciesChanged(): boolean {
    return this.#changed.has("go.mod") || this.#changed.has("go.sum");
  }

  #input(id: string, fallback: readonly string[]): readonly string[] {
    return this.#request.inputs[id] ?? fallback;
  }

  async #run(command: string, args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
    return await this.#process.run(command, args, {
      cwd: this.#dir,
      timeoutMs,
      ...(this.#request.signal === undefined ? {} : { signal: this.#request.signal }),
    });
  }
}

interface GremlinsReport {
  readonly files?: readonly {
    readonly file_name: string;
    readonly mutations?: readonly {
      readonly line: number;
      readonly column: number;
      readonly type: string;
      readonly status: string;
    }[];
  }[];
}

/** Whether a unit-relative package directory matches a Go package pattern such as `./internal/...`. */
export function matchesPackagePattern(dir: string, pattern: string): boolean {
  if (pattern === "./..." || pattern === "...") return true;
  if (pattern.endsWith("/...")) {
    const base = normalizePackage(pattern.slice(0, -"/...".length));
    return base === "." || dir === base || dir.startsWith(`${base}/`);
  }
  return dir === normalizePackage(pattern);
}

function normalizePackage(pattern: string): string {
  const value = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  return value.length === 0 || value === "." ? "." : value;
}

function packageDirectory(file: string): string {
  return posix.dirname(file);
}

function packagePattern(dir: string): string {
  return dir === "." ? "." : `./${dir}`;
}

function mutationFile(fileName: string, dir: string, modulePath: string | null, unitDir: string): string {
  if (fileName.startsWith(`${unitDir}/`)) return fileName.slice(unitDir.length + 1);
  if (modulePath !== null && fileName.startsWith(`${modulePath}/`)) return fileName.slice(modulePath.length + 1);
  return fileName.includes("/") ? fileName : posix.join(dir, fileName);
}

/** Import paths declared by a Go source file. */
export function goImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const imports: string[] = [];
  for (const block of code.matchAll(/\bimport\s*\(([^)]*)\)/g)) {
    for (const spec of block[1]!.matchAll(/"([^"]+)"/g)) imports.push(spec[1]!);
  }
  for (const single of code.matchAll(/\bimport\s+(?:[A-Za-z_.][A-Za-z0-9_]*\s+)?"([^"]+)"/g)) {
    imports.push(single[1]!);
  }
  return [...new Set(imports)];
}

/** Standard-library import paths have no dot in their first element. */
function isStandardLibrary(path: string): boolean {
  return !(path.split("/")[0] ?? "").includes(".");
}

/** Files the Go tool ignores for `./...`: vendored, testdata, or under a `.` or `_` directory. */
function ignoredByGo(file: string): boolean {
  return file.split("/").slice(0, -1).some(
    (segment) => segment === "vendor" || segment === "testdata" || segment.startsWith(".") || segment.startsWith("_"),
  );
}

function isProductionGoFile(file: string): boolean {
  return file.endsWith(".go") && !file.endsWith("_test.go") && !ignoredByGo(file);
}

function describePackages(packages: readonly string[]): string {
  return packages.length <= 3 ? packages.join(" ") : `${packages.length} packages`;
}

function belowThreshold(label: string, tally: { covered: number; total: number }, minimum: number): string[] {
  if (tally.total === 0) return [];
  return tally.covered * 100 < tally.total * minimum
    ? [`${label}: ${percent(tally)} is below the required ${minimum}%`]
    : [];
}

function percent(tally: { covered: number; total: number }): string {
  if (tally.total === 0) return "n/a";
  return `${((tally.covered * 100) / tally.total).toFixed(1)}% (${tally.covered}/${tally.total})`;
}

function numberParam(value: string | number | boolean | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

function output(result: ProcessResult): string[] {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  const all = text.length === 0 ? [] : text.split("\n");
  const tail = all.slice(-60);
  return [
    ...(result.timedOut ? ["The command timed out."] : []),
    ...(all.length > tail.length ? [`… ${all.length - tail.length} earlier line(s) omitted`] : []),
    ...tail,
  ];
}

function passed(summary: string, details: readonly string[] = []): CheckOutcome {
  return { status: "passed", summary, details };
}

function failed(summary: string, details: readonly string[] = []): CheckOutcome {
  return { status: "failed", summary, details };
}

function skipped(summary: string): CheckOutcome {
  return { status: "skipped", summary, details: [] };
}

function unavailable(summary: string, details: readonly string[] = []): CheckOutcome {
  return { status: "unavailable", summary, details };
}
