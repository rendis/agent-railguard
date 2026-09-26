import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

/**
 * Compiles a JSON Schema on first use, so a command that never validates a document does not pay
 * for compiling its schema at startup. `references` are schemas the compiled one points to.
 */
export function lazyValidator<Value>(
  schema: object,
  references: readonly object[] = [],
): () => ValidateFunction<Value> {
  let compiled: ValidateFunction<Value> | undefined;
  return () => {
    if (compiled === undefined) {
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      for (const reference of references) ajv.addSchema(reference);
      compiled = ajv.compile<Value>(schema);
    }
    return compiled;
  };
}
