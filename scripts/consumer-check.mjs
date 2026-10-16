import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import('@agentforge/contracts').then(m=>{if(typeof m.createId!=='function')process.exit(2)})"], { stdio: 'inherit' });
if (result.status !== 0) process.exitCode = result.status ?? 1;
