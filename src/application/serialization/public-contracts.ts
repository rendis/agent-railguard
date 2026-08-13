import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import eventSchema from "../../../schemas/event.v1.schema.json" with { type: "json" };
import planSchema from "../../../schemas/plan.v1.schema.json" with { type: "json" };
import resultSchema from "../../../schemas/result.v1.schema.json" with { type: "json" };
import { compareUtf8 } from "../../domain/shared/types.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(planSchema);
const validateResult = ajv.compile(resultSchema);
const validateEvent = ajv.compile(eventSchema);

export class PublicContractValidationError extends TypeError {
  public constructor(
    readonly contract: "result" | "event",
    readonly issues: readonly string[],
  ) {
    super(`Public ${contract} failed schema validation: ${issues.join("; ")}`);
    this.name = "PublicContractValidationError";
  }
}

export function assertPublicResult<Value>(value: Value): Value {
  if (!validateResult(value)) {
    throw new PublicContractValidationError(
      "result",
      validationIssues(validateResult.errors),
    );
  }
  return value;
}

export function assertPublicEvent<Value>(value: Value): Value {
  if (!validateEvent(value)) {
    throw new PublicContractValidationError(
      "event",
      validationIssues(validateEvent.errors),
    );
  }
  return value;
}

export function encodePublicResult(value: unknown): string {
  assertPublicResult(value);
  return `${JSON.stringify(value)}\n`;
}

export function encodePublicEvent(value: unknown): string {
  assertPublicEvent(value);
  return `${JSON.stringify(value)}\n`;
}

function validationIssues(
  errors: readonly ErrorObject[] | null | undefined,
): readonly string[] {
  return Object.freeze(
    (errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`)
      .sort(compareUtf8),
  );
}
