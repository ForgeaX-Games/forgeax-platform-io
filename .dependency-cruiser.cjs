/**
 * @forgeax/platform-io 是后端 L1 基建。L1 铁律:零上行依赖。
 *
 * 禁止 import 任何 @forgeax/* 兄弟包(它若依赖 cli/server/types 等就不再是
 * 最通用的底座)。当前迁入文件只依赖 hono + node 内建,本规则把这条锁死。
 * 与 architecture/layer-model.ts 的 isAllowed(platform-io → 任何非 shared)
 * 同源:platform-io 是叶子,谁都能依赖它,它依赖谁都不行。
 *
 * 跑法:bun run lint:boundaries(见 package.json scripts)。
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'platform-io-no-forgeax-deps',
      severity: 'error',
      comment:
        '后端 L1 基建不得依赖任何 @forgeax/* 包(零上行)。它是最通用的底座,' +
        '只能依赖第三方(hono)与 node 内建。',
      from: { path: '^src/' },
      to: { path: '^@forgeax/' },
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
