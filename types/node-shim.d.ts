declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  pid: number;
  version: string;
  platform: string;
  arch: string;
  exitCode?: number;
  cwd(): string;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): void;
};

declare const Buffer: {
  byteLength(value: string): number;
  concat(chunks: readonly Uint8Array[]): Uint8Array;
};

declare module 'node:crypto' {
  export function randomUUID(): string;
}

declare module 'node:child_process' {
  export type SpawnedProcess = {
    stdout: { on(event: 'data', listener: (chunk: Uint8Array) => void): void };
    stderr: { on(event: 'data', listener: (chunk: Uint8Array) => void): void };
    stdin: { end(content?: string): void };
    on(event: 'error', listener: (error: Error) => void): void;
    on(event: 'close', listener: (code: number | null) => void): void;
  };
  export function spawn(command: string, args?: string[], options?: unknown): SpawnedProcess;
  export function spawnSync(command: string, args?: string[], options?: unknown): { status: number | null };
}

declare module 'node:fs' {
  export const promises: {
    readdir(path: string, options?: unknown): Promise<unknown[]>;
    readFile(path: string, encoding: 'utf8'): Promise<string>;
    writeFile(path: string, content: string, encoding?: 'utf8'): Promise<void>;
    mkdir(path: string, options?: unknown): Promise<void>;
  };
}

declare module 'node:path' {
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:http' {
  export type IncomingMessage = {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    on(event: 'data', listener: (chunk: Uint8Array) => void): void;
    on(event: 'end', listener: () => void): void;
    on(event: 'error', listener: (error: Error) => void): void;
    on(event: 'close', listener: () => void): void;
  };
  export type ServerResponse = {
    statusCode: number;
    setHeader(name: string, value: string | number): void;
    writeHead(statusCode: number, headers?: Record<string, string | number>): void;
    write(chunk: string): boolean;
    end(chunk?: string): void;
  };
  export type Server = {
    readonly listening: boolean;
    listen(port: number, host: string, callback?: () => void): void;
    close(callback?: (error?: Error) => void): void;
    address(): { port: number; address: string; family: string } | string | null;
    once(event: 'error', listener: (error: Error) => void): void;
    removeListener(event: 'error', listener: (error: Error) => void): void;
  };
  export function createServer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Server;
}

declare module 'node:test' {
  type TestContext = { name: string };
  type TestFunction = (name: string, fn: (context: TestContext) => void | Promise<void>) => void;
  const test: TestFunction;
  export default test;
}

declare module 'node:assert/strict' {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    rejects(block: (() => Promise<unknown>) | Promise<unknown>, error?: unknown, message?: string): Promise<void>;
    throws(block: () => unknown, error?: unknown, message?: string): void;
    match(value: string, regexp: RegExp, message?: string): void;
  };
  export default assert;
}
