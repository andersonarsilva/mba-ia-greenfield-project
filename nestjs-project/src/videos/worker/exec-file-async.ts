import { execFile } from 'node:child_process';

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export function execFileAsync(
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number },
): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        // `execFile`'s callback always yields a real Error instance at runtime;
        // @types/node models it as ExecFileException, which is not declared as
        // extending Error.
        reject(error as Error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
