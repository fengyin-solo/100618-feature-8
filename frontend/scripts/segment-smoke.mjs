// 拼装记录服务层冒烟测试的运行器：用 esbuild 把测试与服务层打包后在 node 里跑。
// 用法：npm run test:segment
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSync } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const outfile = join(here, '.segment-smoke.bundle.cjs')

buildSync({
  entryPoints: [join(here, 'segment-smoke.entry.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  alias: { '@': join(here, '..', 'src') },
  outfile,
  logLevel: 'silent',
})

execFileSync(process.execPath, [outfile], { stdio: 'inherit' })
