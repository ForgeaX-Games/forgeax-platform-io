/**
 * @forgeax/platform-io 是可复用的后端 IO 基座。
 *
 * 除 @forgeax/extension-host/contracts 外，禁止 import 任何 @forgeax/* 兄弟包。
 * 当前迁入文件只依赖 Host contracts、hono 与 node 内建，本规则把这条锁死。
 * 与 architecture/layer-model.ts 的 isAllowed(platform-io → 任何非 shared)
 * 同源:platform-io 是叶子,谁都能依赖它,它依赖谁都不行。
 *
 * 跑法:bun run lint:boundaries(见 package.json scripts)。
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'platform-io-only-shared-host-contracts',
      severity: 'error',
      comment:
        '后端 IO 基座只能依赖 @forgeax/extension-host/contracts、第三方库与 node 内建。',
      from: { path: '^src/' },
      to: {
        path: '^@forgeax/',
        pathNot: '^@forgeax/extension-host/contracts$',
      },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: '包内禁止循环依赖。',
      from: { path: '^src/' },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules', 'dist', 'build', '.vite'] },
    includeOnly: '^src/',
    tsPreCompilationDeps: false,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
