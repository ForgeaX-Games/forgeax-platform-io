import { createFilesystemResourceStore } from '../../src/resource-substrate/filesystem-store';
import { appendFile } from 'node:fs/promises';

const directory = process.argv[2];
if (!directory) process.exit(2);
const mode = process.argv[3];
const terminalLog = process.argv[4];
const store = createFilesystemResourceStore(mode === 'prepared-reader' ? {
  directory,
  afterPreparedRecoveryDetectedForTest: async () => {
    if (!terminalLog) throw new Error('missing prepared reader terminal log');
    console.log(JSON.stringify({ type: 'prepared-detected', pid: process.pid }));
    if ((await Bun.stdin.text()).trim() !== 'release') throw new Error('invalid prepared reader release signal');
  },
  beforeTerminalWriteForTest: async (identity) => {
    if (terminalLog) await appendFile(terminalLog, `${JSON.stringify({ pid: process.pid, identity })}\n`);
  },
} : { directory });
const result = await store.readSnapshot('game-main');
if (!result.ok) {
  console.error(JSON.stringify(result.error));
  process.exit(3);
}
console.log(JSON.stringify({ pid: process.pid, revision: result.value.revision }));
