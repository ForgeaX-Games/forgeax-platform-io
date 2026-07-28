import { createFilesystemResourceStore } from '../../src/resource-substrate/filesystem-store';
import { openResourceRoot } from '../../src/resource-substrate';

const directory = process.argv[2];
const failpoint = process.argv[3];
if (!directory || !failpoint) process.exit(2);

const store = createFilesystemResourceStore({
  directory,
  crashAt: failpoint,
});
const opened = await openResourceRoot({ rootId: 'game-main', store });
if (!opened.ok) process.exit(3);

const snapshot = await opened.value.readSnapshot();
if (!snapshot.ok) process.exit(4);

const result = await opened.value.commit({
  identity: `crash-${failpoint}`,
  expectedRevision: snapshot.value.revision,
  changes: [
    { kind: 'put', resourceId: 'assets/crash-a.bin', bytes: Uint8Array.from([6, 7]) },
    { kind: 'put', resourceId: 'assets/crash-b.bin', bytes: Uint8Array.from([8, 9]) },
  ],
});
if (!result.ok) process.exit(5);
