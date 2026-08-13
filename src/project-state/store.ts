import type { CatalogSnapshot } from "../domain/catalog/model.js";
import type {
  LockDecodeContext,
  LockStateResult,
} from "./lock-state.js";
import type { DesiredStateResult } from "./desired-state.js";

export type StoredLockResult =
  | { readonly kind: "absent" }
  | LockStateResult;

export type StoredDesiredResult =
  | { readonly kind: "absent" }
  | DesiredStateResult;

export interface ProjectStateReader {
  loadDesired(root: string, catalog: CatalogSnapshot): Promise<StoredDesiredResult>;
  loadLock(root: string, context: LockDecodeContext): Promise<StoredLockResult>;
}
