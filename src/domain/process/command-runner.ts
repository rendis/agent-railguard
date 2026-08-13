export interface CommandOutput {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

export interface CommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly onOutput?: (output: CommandOutput) => void;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}
