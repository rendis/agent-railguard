import {
  autocompleteMultiselect,
  confirm,
  groupMultiselect,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
  spinner,
  type Option,
} from "@clack/prompts";
import type { Choice, WizardUi } from "./wizard.js";

/** The wizard's prompts rendered with @clack/prompts. */
export function clackUi(): WizardUi {
  return {
    intro: (title) => intro(title),
    outro: (message) => outro(message),
    note: (message, title) => note(message, title),
    warn: (message) => log.warn(message),
    error: (message) => log.error(message),
    async select(message, options) {
      const result = await select({ message, options: options.map(option) as never });
      return isCancel(result) ? null : (result as never);
    },
    async multiselect(message, options, initial) {
      const result = await multiselect({
        message,
        options: options.map(option) as never,
        initialValues: [...initial] as never,
        required: false,
      });
      return isCancel(result) ? null : ([...result] as never);
    },
    async groupMultiselect(message, groups, initial) {
      const result = await groupMultiselect({
        message,
        options: Object.fromEntries(
          Object.entries(groups).map(([group, options]) => [group, options.map(option)]),
        ) as never,
        initialValues: [...initial] as never,
        required: false,
      });
      return isCancel(result) ? null : ([...result] as never);
    },
    async searchMultiselect(message, options, initial) {
      const result = await autocompleteMultiselect({
        message,
        options: options.map(option) as never,
        initialValues: [...initial] as never,
        placeholder: "Type to filter…",
      });
      return isCancel(result) ? null : ([...result] as never);
    },
    async confirm(message) {
      const result = await confirm({ message, initialValue: false });
      return isCancel(result) ? null : result;
    },
    progress(message) {
      const indicator = spinner();
      indicator.start(message);
      return {
        update: (next) => indicator.message(next),
        stop: (final) => indicator.stop(final),
      };
    },
    onInterrupt(handler) {
      process.on("SIGINT", handler);
      return () => process.off("SIGINT", handler);
    },
  };
}

function option<Value>(choice: Choice<Value>): Option<Value> {
  return {
    value: choice.value,
    label: choice.label,
    ...(choice.hint === undefined ? {} : { hint: choice.hint }),
  } as Option<Value>;
}
