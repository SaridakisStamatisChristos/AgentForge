import { spawn } from 'node:child_process';
import { AgentForgeError } from '@agentforge/contracts';

export type PsqlVariables = Readonly<Record<string, string | number | boolean>>;

function safeDatabaseLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`;
  } catch {
    return '<invalid database url>';
  }
}

export class PostgresCli {
  constructor(readonly databaseUrl: string, readonly executable = 'psql') {}

  async query(sql: string, variables: PsqlVariables = {}): Promise<string[]> {
    const args = [this.databaseUrl, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
    for (const [key, value] of Object.entries(variables)) args.push('-v', `${key}=${String(value)}`);
    return new Promise<string[]>((resolve, reject) => {
      const child = spawn(this.executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const fail = (error: AgentForgeError): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const succeed = (lines: string[]): void => {
        if (settled) return;
        settled = true;
        resolve(lines);
      };

      child.stdout.on('data', (chunk: Uint8Array) => { stdout += new TextDecoder().decode(chunk); });
      child.stderr.on('data', (chunk: Uint8Array) => { stderr += new TextDecoder().decode(chunk); });
      child.stdin.on('error', (error: Error) => {
        fail(new AgentForgeError({
          code: 'DATABASE_CLIENT_ERROR',
          category: 'PERSISTENCE',
          message: `Unable to write SQL to psql for ${safeDatabaseLabel(this.databaseUrl)}: ${error.message}`,
          retryable: true,
        }));
      });
      child.on('error', (error: Error) => {
        fail(new AgentForgeError({
          code: 'DATABASE_CLIENT_ERROR',
          category: 'PERSISTENCE',
          message: `Unable to execute psql for ${safeDatabaseLabel(this.databaseUrl)}: ${error.message}`,
          retryable: true,
        }));
      });
      child.on('close', (code: number | null) => {
        if (settled) return;
        if (code !== 0) {
          fail(new AgentForgeError({
            code: 'DATABASE_QUERY_FAILED',
            category: 'PERSISTENCE',
            message: `PostgreSQL command failed for ${safeDatabaseLabel(this.databaseUrl)}: ${stderr.trim().slice(0, 2000)}`,
            retryable: true,
          }));
          return;
        }
        succeed(stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0));
      });
      child.stdin.end(sql);
    });
  }

  async json<T>(sql: string, variables: PsqlVariables = {}): Promise<T[]> {
    const lines = await this.query(sql, variables);
    const values: T[] = [];
    for (const line of lines) {
      if (!line.startsWith('{') && !line.startsWith('[')) continue;
      values.push(JSON.parse(line) as T);
    }
    return values;
  }

  async execute(sql: string, variables: PsqlVariables = {}): Promise<void> {
    await this.query(sql, variables);
  }
}
