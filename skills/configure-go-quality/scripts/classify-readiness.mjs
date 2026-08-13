#!/usr/bin/env node

const statuses = Object.freeze({
  READY: "ready",
  READY_WITH_FINDINGS: "ready_with_findings",
  MISSING: "missing",
  BROKEN: "broken",
  BLOCKED_SETUP: "blocked_setup",
});

const usage = [
  "Usage: node classify-readiness.mjs --inputs ready|missing|broken",
  "       [--blocked-prerequisite LABEL]... [--product-finding LABEL]...",
].join("\n");

function requiredValue(args, index, option) {
  const value = args[index + 1];
  if (value === undefined || value.trim().length === 0 || value.startsWith("--")) {
    throw new Error(`${option} requires a non-empty value`);
  }
  return value;
}

function parseArguments(args) {
  let inputs = null;
  const blockedPrerequisites = [];
  const productFindings = [];

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--inputs") {
      if (inputs !== null) throw new Error("--inputs may be provided only once");
      inputs = requiredValue(args, index, option);
      index += 1;
      continue;
    }
    if (option === "--blocked-prerequisite") {
      blockedPrerequisites.push(requiredValue(args, index, option));
      index += 1;
      continue;
    }
    if (option === "--product-finding") {
      productFindings.push(requiredValue(args, index, option));
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${option}`);
  }

  if (inputs === null) throw new Error("--inputs is required");
  if (!["ready", "missing", "broken"].includes(inputs)) {
    throw new Error(`Invalid --inputs value: ${inputs}`);
  }
  return Object.freeze({ inputs, blockedPrerequisites, productFindings });
}

function classify({ inputs, blockedPrerequisites, productFindings }) {
  if (inputs === "missing") return "MISSING";
  if (inputs === "broken") return "BROKEN";
  if (blockedPrerequisites.length > 0) return "BLOCKED_SETUP";
  if (productFindings.length > 0) return "READY_WITH_FINDINGS";
  return "READY";
}

try {
  const state = classify(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ state, status: statuses[state] })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n${usage}\n`);
  process.exitCode = 2;
}
