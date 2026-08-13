export type ContentSourceKind = "local" | "remote";

export interface ResolvedContentSource {
  readonly kind: ContentSourceKind;
  readonly root: string;
  readonly catalogFile: string;
  readonly revision: string | null;
  readonly identity: string;
  readonly location: string;
}

export interface ContentSourceProgress {
  readonly phase: "local" | "manifest" | "cache" | "files";
  readonly status: "started" | "completed" | "failed";
  readonly message: string;
  readonly current?: number;
  readonly total?: number;
}

export type ContentSourceProgressSink = (event: ContentSourceProgress) => void;

export interface ContentSource {
  resolve(signal?: AbortSignal): Promise<ResolvedContentSource>;
}
