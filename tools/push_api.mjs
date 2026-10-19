// 通过 GitHub REST Git Data API 推送,只用 api.github.com。
//
// 为什么不用 git push:
//   1. 本机的 git 与 PowerShell 都走 schannel,向 GitHub 发 HTTPS 一律失败
//      (SEC_E_NO_CREDENTIALS)。
//   2. 即便绕开 schannel,github.com:443(receive-pack 上传端点所在域名)在
//      这条网络上经常整体不可达,而 api.github.com 与 codeload.github.com 正常。
// 所以走 REST:建 blob -> 建 tree -> 建 commit -> 更新 ref,全程只用 API。
//
// 已知偏差:只有**提交信息结尾换行不规范**的那些提交,SHA 会与本地不同。
//
// 实测 6 个提交里 5 个 SHA 完全一致;唯一不同的是我早先用 `@'...'@` 写的那条,
// 结尾带了两个换行 —— GitHub 会把结尾换行规范化掉,那个字节差就改变了 SHA。
// git 自身的规范格式要求正文恰以一个 \n 结尾(用 git hash-object 逐变体验证过),
// 本脚本已按规范构造,所以只要提交信息本身规范,SHA 就能对上。
//
// 这不是"GitHub 必然改变 sha",而是"不规范的提交信息会被规范化"。
// 内容另由 verifyTree 逐文件自检保证正确。
//
// 需要 GH_TOKEN。用法:node tools/push_api.mjs [分支]
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const OWNER = '1iuTL'
const REPO = 'model-stove'
const BRANCH = process.argv[2] || 'main'
const SRC = 'C:\\deepseek harness\\model-stove'
const TMP = `${SRC}\\.api-push-tmp`

const token = process.env.GH_TOKEN
if (!token) { console.error('缺少 GH_TOKEN 环境变量'); process.exit(2) }

const BASE = `https://api.github.com/repos/${OWNER}/${REPO}`
const H = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'model-stove-push',
  'Content-Type': 'application/json',
}

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

// ------------------------------------------------------------------ git

function run(argv, { stdoutFile } = {}) {
  return new Promise((resolve, reject) => {
    let fd = null
    if (stdoutFile) fd = openSync(stdoutFile, 'w')
    const p = spawn(argv[0], argv.slice(1), {
      cwd: SRC,
      stdio: ['ignore', fd === null ? 'ignore' : fd, 'ignore'],
    })
    p.on('error', reject)
    p.on('close', () => { if (fd !== null) { try { closeSync(fd) } catch { /* 已关 */ } } resolve(0) })
  })
}

/** 跑一条 git 命令并取回 stdout 文本(去尾空白)。 */
async function git(args, tag) {
  const o = `${TMP}\\${tag}.o`
  await run(['git', ...args], { stdoutFile: o })
  return readFileSync(o, 'utf8').trim()
}

/** 取某个路径在某个提交里的 tree sha;不存在返回 null。 */
async function treeShaOf(commit, relPath) {
  const spec = relPath ? `${commit}:${relPath}` : `${commit}^{tree}`
  const v = await git(['rev-parse', spec], 'ts')
  return /^[0-9a-f]{40}$/.test(v) ? v : null
}

// ------------------------------------------------------------------ API

async function api(method, path, body, attempts = 4) {
  let lastErr = null
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: H,
        body: body === undefined ? undefined : JSON.stringify(body),
        // 必须显式超时:连接卡住时 fetch 会**无限期挂着** —— 既不断开也不抛错,
        // 于是下面的 catch 永远不触发,重试逻辑形同虚设,脚本就那么干等
        // (实测卡了十几分钟、毫无输出)。这是必需品,不是保险。
        signal: AbortSignal.timeout(30000),
      })
      const text = await r.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
      // 5xx 值得重试;4xx 是请求本身的问题,重试没用。
      if (r.status >= 500 && i < attempts) {
        console.log(`    HTTP ${r.status},${i * 2} 秒后重试 ...`)
        await sleep(2000 * i)
        continue
      }
      // 配额耗尽要单独报出来 —— 否则会被误当成网络问题白等很久。
      if (r.status === 403 && /rate limit/i.test(text)) {
        const reset = r.headers.get('x-ratelimit-reset')
        const when = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : '未知'
        throw new Error(
          `API 配额耗尽,预计 ${when} 重置。请确认 GH_TOKEN 已设置:` +
          `带 token 是 5000/小时,不带只有 60/小时。`
        )
      }
      return { status: r.status, json, text }
    } catch (e) {
      lastErr = e
      const cause = e && e.cause ? (e.cause.code || e.cause.message) : e.message
      console.log(`    第 ${i}/${attempts} 次失败: ${cause}`)
      if (i < attempts) await sleep(2000 * i)
    }
  }
  throw lastErr
}

// ------------------------------------------------------------------ 并发

/**
 * 限制并发数地跑一批任务。
 *
 * 为什么要并发:这条网络下单个 API 请求要几十秒,而串行上传十几个文件
 * 会让一次推送超过一小时(实测十几分钟一个 blob 都没传完)。并发到 6 路
 * 快得多,又不至于把连接打满或撞上服务端限制。
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return results
}

// ------------------------------------------------------------------ tree 构建

let blobCount = 0
let treeCount = 0
let reuseCount = 0
let blobCacheHits = 0

// blob 的磁盘缓存:本地 blob sha -> 远程 blob sha。
//
// 为什么放在磁盘上而不是内存里:这条网络不稳定,推送可能中途超时。
// 缓存落盘后重跑就能跳过已上传的内容,不必从头再来一遍(实测全量重传
// 会直接把一次推送拖过 5 分钟)。文件在 .gitignore 里。
const CACHE_DIR = `${SRC}\\.api-push-cache`
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })

function cacheGet(localSha) {
  try {
    const v = readFileSync(`${CACHE_DIR}\\${localSha}`, 'utf8').trim()
    return /^[0-9a-f]{40}$/.test(v) ? v : null
  } catch { return null }
}
function cacheSet(localSha, remoteSha) {
  try { writeFileSync(`${CACHE_DIR}\\${localSha}`, remoteSha, 'utf8') } catch { /* 缓存失败不影响推送 */ }
}

/**
 * 递归建好一个目录的 tree,返回它的 sha。
 *
 * 两级复用,都是为了少发请求:
 *   1. 本地这个目录在该提交里的 tree sha,如果远程已经有同名 tree
 *      (tree sha 由内容唯一决定),整棵直接复用,零请求。
 *   2. 如果父提交里同一路径的 tree sha 与它相同,说明这个目录没变,
 *      同样直接复用。
 * 都命中不了才逐条构建;构建时也只传本目录的直接条目,子目录递归处理。
 *
 * depth 用于防空转:曾经因为 ls-tree 参数写错(用 `-- src` 而不是 `commit:src`),
 * 子目录只返回它自己那一条,于是无限递归、进程卡死十几分钟毫无输出。
 * 现在超过 32 层直接报错,让这类问题立刻暴露而不是表现为"卡住"。
 */
async function ensureTree(commit, relPath, remoteKnown, parentCommit, depth = 0) {
  if (depth > 32) {
    throw new Error(`目录递归超过 32 层,疑似 ls-tree 参数有问题(当前路径: ${relPath})`)
  }
  const localSha = await treeShaOf(commit, relPath)
  if (localSha && remoteKnown.has(localSha)) {
    reuseCount++
    return localSha
  }
  // 与父提交同路径比较:相同即未改动
  if (localSha && parentCommit) {
    const parentSha = await treeShaOf(parentCommit, relPath)
    if (parentSha && parentSha === localSha) {
      reuseCount++
      remoteKnown.add(localSha)
      return localSha
    }
  }

  // 列出该目录的**直接**子项。参数形式很关键,这里踩过两次:
  //
  //   git ls-tree -z <commit> -- src   -> 只返回 "src" 这一个 tree 条目本身
  //   git ls-tree -z <commit>:src      -> 返回 src 目录里的 6 个文件  <-- 要这个
  //
  // 用 `-- src` 的形式时,src 被当作**过滤路径**而不是"要展开的目录",
  // 于是脚本拿到 1 个 tree 条目后又去递归它自己 —— 无限递归卡死。
  // 之前误判成"不能带 -r",其实和 -r 无关,是参数形式的问题。
  const spec = relPath ? `${commit}:${relPath}` : commit
  const o = `${TMP}\\ls-${(relPath || 'root').replace(/[\\/]/g, '_')}.o`
  await run(['git', 'ls-tree', '-z', spec], { stdoutFile: o })
  const entries = readFileSync(o, 'utf8').split('\x00').filter(Boolean)

  // 先扫一遍,把子目录递归做掉、把需要上传的 blob 收集起来。
  //
  // 为什么不在循环里逐个 await 上传:这条网络下单个请求要几十秒,而一个提交
  // 有十几个文件、总共五个提交 —— 串行会跑一个多小时还看不出进展(实测卡了
  // 十几分钟一个 blob 都没传完)。收集后并发上传,快好几倍。
  const treeEntries = []
  const pendingBlobs = []   // { name, mode, sha }
  const seen = new Map()    // 同一提交内内容相同的 blob 只传一次

  for (const e of entries) {
    const tab = e.indexOf('\t')
    const [mode, type, sha] = e.slice(0, tab).split(' ')
    // 用 <commit>:<relPath> 列目录时,路径是**相对于该目录**的
    // (如 "config.js"),所以直接就是子项名字,不需要再切前缀。
    const name = e.slice(tab + 1)
    if (!name) continue
    // 子目录的递归路径是相对仓库根的
    const full = relPath ? `${relPath}/${name}` : name

    if (type === 'commit') {
      treeEntries.push({ path: name, mode: '160000', type: 'commit', sha })
      continue
    }
    if (type === 'tree') {
      const sub = await ensureTree(commit, full, remoteKnown, parentCommit, depth + 1)
      treeEntries.push({ path: name, mode, type: 'tree', sha: sub })
      continue
    }

    // blob:先查磁盘缓存(跨次运行也有效)
    const cached = cacheGet(sha)
    if (cached) {
      blobCacheHits++
      treeEntries.push({ path: name, mode, type: 'blob', sha: cached })
      continue
    }
    // 同一提交里相同内容只上传一次
    if (seen.has(sha)) {
      treeEntries.push({ path: name, mode, type: 'blob', sha: seen.get(sha) })
      continue
    }
    pendingBlobs.push({ name, mode, sha })
    treeEntries.push({ path: name, mode, type: 'blob', sha: null })   // 位置占位,稍后回填
  }

  // ── 并发上传待传的 blob ──
  if (pendingBlobs.length) {
    const slots = treeEntries.filter((x) => x.sha === null)
    const results = new Array(pendingBlobs.length)
    await mapLimit(pendingBlobs, 6, async (item, idx) => {
      const blobFile = `${TMP}\\blob-${idx}.bin`
      await run(['git', 'cat-file', 'blob', item.sha], { stdoutFile: blobFile })
      const buf = readFileSync(blobFile)
      const b = await api('POST', '/git/blobs', {
        content: buf.toString('base64'),
        encoding: 'base64',
      })
      if (b.status !== 201) throw new Error(`建 blob 失败 (${item.name}) HTTP ${b.status}: ${b.text.slice(0, 200)}`)
      blobCount++
      cacheSet(item.sha, b.json.sha)
      seen.set(item.sha, b.json.sha)
      results[idx] = b.json.sha
    })
    // 回填占位
    for (let i = 0; i < slots.length; i++) {
      slots[i].sha = seen.get(pendingBlobs[i].sha) || results[i]
    }
  }

  if (!treeEntries.length) {
    throw new Error(`目录 ${relPath || '/'} 没有列出任何条目 —— ls-tree 参数有问题`)
  }

  console.log(`    [建 tree] ${relPath || '/'}  条目 ${treeEntries.length} 个: ${treeEntries.map((x) => x.path + '(' + x.type[0] + ')').join(' ')}`)

  const t = await api('POST', '/git/trees', { tree: treeEntries })
  if (t.status !== 201) {
    const dump = `${TMP}\\tree-fail.json`
    writeFileSync(dump, JSON.stringify({ dir: relPath || '/', response: t.text, entries: treeEntries }, null, 2), 'utf8')
    throw new Error(`建 tree 失败 (${relPath || '/'}) HTTP ${t.status},详情见 ${dump}`)
  }
  treeCount++
  // 记进已知集合:同一提交内若有相同内容的目录,可直接复用。
  if (localSha) remoteKnown.add(localSha)
  return t.json.sha
}

// ------------------------------------------------------------------ 自检

/**
 * 把刚建好的 tree 递归拉回来,与本地 `ls-tree -r` 逐文件比对。
 *
 * 为什么要这一步:建 tree 的逻辑一旦漏掉子目录内容,推送会"成功"但内容残缺,
 * 而且 commit sha 对不上,极难定位(实际踩过:src/ 与 tools/ 整层丢失,
 * 根目录看着却完全正常)。提交前花几个请求验一遍,比事后从 sha 反推便宜得多。
 */
async function verifyTree(treeSha, localCommit) {
  const remote = new Map()
  async function walk(sha, prefix) {
    const r = await api('GET', `/git/trees/${sha}`)
    if (r.status !== 200) throw new Error(`自检读取 tree 失败 HTTP ${r.status}`)
    for (const e of r.json.tree) {
      const p = prefix ? `${prefix}/${e.path}` : e.path
      if (e.type === 'tree') await walk(e.sha, p)
      else remote.set(p, e.sha)
    }
  }
  await walk(treeSha, '')

  const o = `${TMP}\\selfcheck.o`
  await run(['git', 'ls-tree', '-r', '-z', localCommit], { stdoutFile: o })
  const local = new Map()
  for (const e of readFileSync(o, 'utf8').split('\x00').filter(Boolean)) {
    const tab = e.indexOf('\t')
    local.set(e.slice(tab + 1), e.slice(0, tab).split(' ')[2])
  }

  const problems = []
  for (const [p, s] of local) {
    if (!remote.has(p)) problems.push(`漏掉 ${p}`)
    else if (remote.get(p) !== s) problems.push(`内容不符 ${p}`)
  }
  for (const p of remote.keys()) if (!local.has(p)) problems.push(`多出 ${p}`)

  return { localCount: local.size, remoteCount: remote.size, problems }
}

// ------------------------------------------------------------------ 主流程

console.log(`仓库: ${OWNER}/${REPO}   分支: ${BRANCH}`)

const ref = await api('GET', `/git/ref/heads/${BRANCH}`)
if (ref.status !== 200) {
  console.error(`读 ref 失败 HTTP ${ref.status}: ${ref.text.slice(0, 200)}`)
  process.exit(1)
}
const remoteSha = ref.json.object.sha
const headSha = await git(['rev-parse', 'HEAD'], 'head')
console.log(`远程 ${BRANCH}: ${remoteSha.slice(0, 7)}`)
console.log(`本地 HEAD : ${headSha.slice(0, 7)}`)

if (remoteSha === headSha) {
  console.log('已是最新,无需推送。')
  rmSync(TMP, { recursive: true, force: true })
  process.exit(0)
}

// 远程已有的 tree 集合,用于整棵复用。tree sha 由内容决定,所以远程提交的
// tree 一定在远程。
const remoteKnown = new Set()

// 远程 tip 是否在本地对象库里?
//
// 不在的情况真会发生:如果某条历史被服务端规范化过(例如提交信息结尾换行
// 不规范,GitHub 会改写提交对象),远程的 sha 就与本地不同,而 F 本地又没有
// 那个改写后的对象。以前这里直接报错退出,导致"明明内容一致却再也推不上去"。
//
// 现在改成从 API 取远程 tip 的 tree 并塞进 remoteKnown,照样能做增量:
// 变化的只有最上面几条,下面的树按内容复用。
const kind = await git(['cat-file', '-t', remoteSha], 'kind')
const remoteTipLocal = kind === 'commit'
if (remoteTipLocal) {
  const t = await git(['rev-parse', `${remoteSha}^{tree}`], 'rt')
  if (/^[0-9a-f]{40}$/.test(t)) remoteKnown.add(t)
} else {
  console.log('远程 tip 不在本地对象库(可能被服务端规范化过),改从 API 取它的 tree。')
  const c = await api('GET', `/git/commits/${remoteSha}`)
  if (c.status !== 200) {
    console.error(`取远程提交失败 HTTP ${c.status}: ${c.text.slice(0, 200)}`)
    process.exit(1)
  }
  remoteKnown.add(c.json.tree.sha)
  console.log(`远程 tree: ${c.json.tree.sha.slice(0, 7)}`)
}

// 待推送的提交。远程 tip 不在本地时无法用 rev-list 算区间,退化为
// "推送本地 HEAD 这一个提交"(内容仍由 verifyTree 逐文件自检保证)。
let commits
if (remoteTipLocal) {
  commits = (await git(['rev-list', '--reverse', `${remoteSha}..HEAD`], 'list'))
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
} else {
  commits = [headSha]
}
console.log(`待推送 ${commits.length} 个提交`)

let parent = remoteSha
for (const sha of commits) {
  const msg = await git(['log', '-1', '--format=%B', sha], 'msg')
  const an = await git(['log', '-1', '--format=%an', sha], 'an')
  const ae = await git(['log', '-1', '--format=%ae', sha], 'ae')
  const ad = await git(['log', '-1', '--format=%aI', sha], 'ad')

  console.log(`\n${sha.slice(0, 7)}  ${msg.split('\n')[0]}`)

  const treeSha = await ensureTree(sha, '', remoteKnown, parent)

  const chk = await verifyTree(treeSha, sha)
  if (chk.problems.length) {
    console.log(`  !! 自检不通过:本地 ${chk.localCount} 个文件 / 远程 ${chk.remoteCount} 个`)
    chk.problems.slice(0, 12).forEach((p) => console.log(`     ${p}`))
    if (chk.problems.length > 12) console.log(`     ...另有 ${chk.problems.length - 12} 条`)
    throw new Error(`tree 内容不完整 (${sha.slice(0, 7)}),已中止,未更新 ref`)
  }
  console.log(`  自检通过:${chk.localCount} 个文件全部一致`)

  // 正文保证恰以一个 \n 结尾(git 规范格式)。GitHub 仍会规范化掉它,
  // 导致 sha 不同,但至少传过去的是规范形式。
  const cleanMsg = msg.replace(/\n+$/, '') + '\n'
  const c = await api('POST', '/git/commits', {
    message: cleanMsg,
    tree: treeSha,
    parents: [parent],
    author: { name: an, email: ae, date: ad },
    committer: { name: an, email: ae, date: ad },
  })
  if (c.status !== 201) throw new Error(`建 commit 失败 HTTP ${c.status}: ${c.text.slice(0, 300)}`)

  if (c.json.sha === sha) {
    console.log(`  -> ${c.json.sha.slice(0, 7)}  与本地一致`)
  } else {
    console.log(`  -> ${c.json.sha.slice(0, 7)}  与本地 ${sha.slice(0, 7)} 不同(GitHub 规范化正文结尾换行所致)`)
  }
  console.log(`     上传 blob ${blobCount} / 新建 tree ${treeCount} / 复用 tree ${reuseCount}`)
  parent = c.json.sha
}

console.log(`\n更新 refs/heads/${BRANCH} -> ${parent.slice(0, 7)}`)
const up = await api('PATCH', `/git/refs/heads/${BRANCH}`, { sha: parent, force: true })
if (up.status !== 200) {
  console.error(`更新 ref 失败 HTTP ${up.status}: ${up.text.slice(0, 300)}`)
  rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
}

// 校验:远程最终指向哪里,内容是否与本地 HEAD 一致
const after = await api('GET', `/git/ref/heads/${BRANCH}`)
const now = after.status === 200 ? after.json.object.sha : null
console.log(`\n远程 ${BRANCH} = ${now ? now.slice(0, 7) : '?'}`)

let contentOk = false
if (now) {
  const cRes = await api('GET', `/git/commits/${now}`)
  const finalChk = await verifyTree(cRes.json.tree.sha, headSha)
  contentOk = finalChk.problems.length === 0
  console.log(contentOk
    ? `内容校验通过:${finalChk.localCount} 个文件与本地 HEAD 完全一致 —— 推送成功`
    : `!! 内容校验未通过(${finalChk.problems.length} 处差异)`)
  finalChk.problems.slice(0, 8).forEach((p) => console.log(`     ${p}`))
}
console.log(`统计: 上传 blob ${blobCount} 个(缓存命中 ${blobCacheHits} 个),新建 tree ${treeCount} 个,复用 tree ${reuseCount} 个`)

rmSync(TMP, { recursive: true, force: true })
process.exit(contentOk ? 0 : 1)
