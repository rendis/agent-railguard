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
    async select(message, options, settings = {}) {
      // `q` cancels the prompt like Esc does; the caller decides what a cancel means.
      const cancel = new AbortController();
      const onKeypress = (_input: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => {
        if (key?.name === "q" && key.ctrl !== true && key.meta !== true) cancel.abort();
      };
      if (settings.quitKey === true) process.stdin.on("keypress", onKeypress);
      try {
        const result = await select({ message, options: options.map(option) as never, signal: cancel.signal });
        return isCancel(result) ? null : (result as never);
      } finally {
        process.stdin.off("keypress", onKeypress);
      }
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
