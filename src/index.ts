export interface Env {
	IMAGES: R2Bucket
	IMAGE_BASE_URL: string
	REQUIRE_AUTH?: string
	ADMIN_EMAILS?: string
}

const ALLOWED_TYPES: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/avif': 'avif',
}

const MAX_SIZE = 10 * 1024 * 1024
const FOLDER_RE = /^(?:\d{1,3}(?:\/\d{1,3})*)?$/
const IMAGE_KEY_RE = /^(?:\d{1,3}\/)*\d{1,3}\/[^/]+\.(?:jpg|jpeg|png|webp|gif|avif)$/i
const MIME_BY_EXT: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
	gif: 'image/gif',
	avif: 'image/avif',
}

interface Identity {
	email?: string
	name?: string
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)

		if (request.method === 'GET' && url.pathname === '/')
			return page(request, env)

		if (request.method === 'GET' && url.pathname === '/api/me')
			return json({ identity: identityOf(request), requireAuth: isAuthRequired(env) })

		if (request.method === 'GET' && url.pathname === '/api/articles')
			return json({ articles: await articleOptions() })

		if (request.method === 'POST' && url.pathname === '/api/upload')
			return upload(request, env)

		if (request.method === 'GET' && url.pathname === '/api/files')
			return listFiles(request, env)

		if (request.method === 'POST' && url.pathname === '/api/file')
			return fileAction(request, env)

		if (request.method === 'GET' && url.pathname === '/api/requests')
			return listRequests(request, env)

		if (request.method === 'POST' && url.pathname === '/api/approve')
			return approveRequest(request, env)

		return json({ error: 'Not Found' }, 404)
	},
}

function isAuthRequired(env: Env): boolean {
	return env.REQUIRE_AUTH === 'true'
}

function identityOf(request: Request): Identity {
	const token = request.headers.get('CF-Access-Jwt-Assertion')
	if (!token)
		return {}
	try {
		const payload = token.split('.')[1]
		const base64 = payload.replaceAll('-', '+').replaceAll('_', '/')
		const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=')
		const raw = atob(padded)
		const bytes = Uint8Array.from(raw, char => char.charCodeAt(0))
		const claims = JSON.parse(new TextDecoder().decode(bytes)) as { email?: string, name?: string }
		return { email: claims.email, name: claims.name || claims.email }
	}
	catch {
		return {}
	}
}

const GITHUB_TREE_URL = 'https://api.github.com/repos/NCEPUwiki/NCEPUwiki/git/trees/main?recursive=1'

/**
 * 从 GitHub 仓库 main 分支读取 docs/ 下所有编号文章路径（与 wiki 目录结构一致），
 * 供上传页下拉选择；列表缓存 15 分钟，未推送的新文章可手动输入路径。
 */
async function articleOptions(): Promise<string[]> {
	try {
		const cached = await caches.default.match(GITHUB_TREE_URL)
		if (cached) {
			const paths = await cached.json() as string[]
			if (Array.isArray(paths))
				return paths
		}
	}
	catch {
		// 缓存不可用时继续走 GitHub 请求
	}

	try {
		const response = await fetch(GITHUB_TREE_URL, {
			headers: {
				Accept: 'application/vnd.github+json',
				'User-Agent': 'ncepuwiki-image-uploader',
			},
		})
		if (!response.ok)
			return []
		const data = await response.json() as { tree?: { path?: string }[] }
		const articles: string[] = []
		for (const entry of data.tree || []) {
			const path = entry.path || ''
			if (!path.startsWith('docs/') || !path.endsWith('.md'))
				continue
			const relative = path.slice('docs/'.length)
			if (!relative.split('/').every(part => /^\d+\./.test(part)))
				continue
			articles.push(relative.slice(0, -'.md'.length))
		}
		const cached = new Response(JSON.stringify(articles), {
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				'Cache-Control': 'public, max-age=900',
			},
		})
		try {
			await caches.default.put(GITHUB_TREE_URL, cached)
		}
		catch {
			// 缓存失败不影响本次返回
		}
		return articles
	}
	catch {
		return []
	}
}

function adminEmails(env: Env): string[] {
	return (env.ADMIN_EMAILS || '')
		.split(',')
		.map(email => email.trim().toLowerCase())
		.filter(Boolean)
}

function isAdminIdentity(email: string | undefined, env: Env): boolean {
	if (!email)
		return false
	const admins = adminEmails(env)
	return admins.length > 0 && admins.includes(email.toLowerCase())
}

function requireIdentity(request: Request, env: Env): (Identity & { email: string }) | null {
	if (isAuthRequired(env) && !request.headers.has('CF-Access-Jwt-Assertion'))
		return null
	const identity = identityOf(request)
	return identity.email ? { email: identity.email, name: identity.name } : null
}

interface PendingRecord {
	id: string
	type: 'upload' | 'delete' | 'move' | 'folder-delete' | 'folder-move'
	actorEmail: string
	createdAt: string
	upload?: { stagedKey: string; finalKey: string; originalName: string; size: number }
	delete?: { key: string }
	move?: { oldKey: string; newKey: string }
	folderDelete?: { folder: string }
	folderMove?: { sourceFolder: string; destFolder: string }
}

const PENDING_PREFIX = '_pending/'
const validKey = (key: string | undefined): key is string => Boolean(key && IMAGE_KEY_RE.test(key))

function newRequestId(): string {
	return `${Date.now().toString(36)}-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
}

async function readPending(env: Env, id: string): Promise<PendingRecord | null> {
	const object = await env.IMAGES.get(`${PENDING_PREFIX}${id}.json`)
	if (!object)
		return null
	const raw = new TextDecoder().decode(await object.arrayBuffer())
	try {
		return JSON.parse(raw) as PendingRecord
	}
	catch {
		return null
	}
}

async function writePending(env: Env, record: PendingRecord): Promise<void> {
	await env.IMAGES.put(`${PENDING_PREFIX}${record.id}.json`, JSON.stringify(record), {
		httpMetadata: { contentType: 'application/json; charset=utf-8' },
	})
}

async function moveObject(env: Env, oldKey: string, newKey: string): Promise<string | null> {
	const source = await env.IMAGES.get(oldKey)
	if (!source)
		return '源图片不存在'
	const extension = newKey.split('.').pop()?.toLowerCase() || ''
	await env.IMAGES.put(newKey, source.body, {
		httpMetadata: { contentType: MIME_BY_EXT[extension] || source.httpMetadata?.contentType || 'application/octet-stream' },
	})
	await env.IMAGES.delete(oldKey)
	return null
}

async function listAllImageKeys(env: Env, prefix: string): Promise<string[]> {
	const keys: string[] = []
	let cursor: string | undefined
	do {
		const page = await env.IMAGES.list({ prefix, limit: 1000, cursor })
		for (const object of page.objects) {
			if (IMAGE_KEY_RE.test(object.key))
				keys.push(object.key)
		}
		if (page.truncated)
			cursor = page.cursor
		else
			cursor = undefined
	} while (cursor)
	return keys
}

async function approveRequest(request: Request, env: Env): Promise<Response> {
	const identity = requireIdentity(request, env)
	if (!identity)
		return json({ error: '未登录：请先通过 Cloudflare Access 登录' }, 401)
	if (!isAdminIdentity(identity.email, env))
		return json({ error: '只有 NCEPUwiki owner 可以批准' }, 403)

	let body: { requestId?: string; decision?: string }
	try {
		body = await request.json() as typeof body
	}
	catch {
		return json({ error: '请求不是有效的 JSON' }, 400)
	}
	if (!body.requestId || !['approve', 'reject'].includes(body.decision || ''))
		return json({ error: '参数不完整' }, 400)

	const record = await readPending(env, body.requestId)
	if (!record)
		return json({ error: '申请不存在或已处理' }, 404)
	const recordKey = `${PENDING_PREFIX}${record.id}.json`

	if (body.decision === 'reject') {
		if (record.type === 'upload' && record.upload)
			await env.IMAGES.delete(record.upload.stagedKey)
		await env.IMAGES.delete(recordKey)
		return json({ ok: true, status: 'rejected' })
	}

	if (record.type === 'upload' && record.upload) {
		if (await env.IMAGES.head(record.upload.finalKey))
			return json({ error: '目标位置已有图片，无法重复上传，请改为拒绝' }, 409)
		const staged = await env.IMAGES.get(record.upload.stagedKey)
		if (!staged)
			return json({ error: '待上传的图片数据已丢失' }, 404)
		const extension = record.upload.finalKey.split('.').pop()?.toLowerCase() || ''
		await env.IMAGES.put(record.upload.finalKey, staged.body, {
			httpMetadata: { contentType: MIME_BY_EXT[extension] || 'application/octet-stream' },
		})
		await env.IMAGES.delete(record.upload.stagedKey)
	}
	else if (record.type === 'delete' && record.delete) {
		await env.IMAGES.delete(record.delete.key)
	}
	else if (record.type === 'move' && record.move) {
		if (!validKey(record.move.oldKey) || !validKey(record.move.newKey))
			return json({ error: '申请中的图片路径无效' }, 400)
		if (record.move.oldKey !== record.move.newKey && await env.IMAGES.head(record.move.newKey))
			return json({ error: '目标位置已有同名图片，请先处理冲突' }, 409)
		const error = record.move.oldKey === record.move.newKey ? null : await moveObject(env, record.move.oldKey, record.move.newKey)
		if (error)
			return json({ error }, 404)
	}
	else if (record.type === 'folder-delete' && record.folderDelete) {
		const keys = await listAllImageKeys(env, `${record.folderDelete.folder}/`)
		for (const key of keys)
			await env.IMAGES.delete(key)
	}
	else if (record.type === 'folder-move' && record.folderMove) {
		const source = record.folderMove.sourceFolder
		const dest = record.folderMove.destFolder
		if (!FOLDER_RE.test(source) || !FOLDER_RE.test(dest) || !source)
			return json({ error: '文件夹路径无效' }, 400)
		if (dest === source || dest.startsWith(source + '/'))
			return json({ error: '不能移动到自身或其子目录' }, 409)
		const sourceKeys = await listAllImageKeys(env, `${source}/`)
		const destKeys = new Set(await listAllImageKeys(env, `${dest}/`))
		for (const key of sourceKeys) {
			const newKey = `${dest}/${key.slice(source.length + 1)}`
			if (destKeys.has(newKey))
				return json({ error: `目标目录已有 ${newKey}，请先处理冲突` }, 409)
		}
		for (const key of sourceKeys) {
			const newKey = `${dest}/${key.slice(source.length + 1)}`
			const error = await moveObject(env, key, newKey)
			if (error)
				return json({ error }, 404)
		}
	}

	await env.IMAGES.delete(recordKey)
	return json({ ok: true, status: 'approved' })
}

async function listRequests(request: Request, env: Env): Promise<Response> {
	const identity = requireIdentity(request, env)
	if (!identity)
		return json({ error: '未登录：请先通过 Cloudflare Access 登录' }, 401)

	const mineOnly = new URL(request.url).searchParams.get('mine') === '1'
	const admin = isAdminIdentity(identity.email, env)
	const page = await env.IMAGES.list({ prefix: PENDING_PREFIX, delimiter: '/' })
	const requests: PendingRecord[] = []
	for (const object of page.objects) {
		if (!object.key.endsWith('.json'))
			continue
		const id = object.key.slice(PENDING_PREFIX.length, -'.json'.length)
		const record = await readPending(env, id)
		if (!record)
			continue
		if (mineOnly && record.actorEmail.toLowerCase() !== identity.email.toLowerCase())
			continue
		if (!mineOnly && !admin && record.actorEmail.toLowerCase() !== identity.email.toLowerCase())
			continue
		requests.push(record)
	}
	requests.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
	return json({ requests, admin })
}

async function listFiles(request: Request, env: Env): Promise<Response> {
	const identity = requireIdentity(request, env)
	if (!identity)
		return json({ error: '未登录：请先通过 Cloudflare Access 登录' }, 401)

	const url = new URL(request.url)
	const folder = url.searchParams.get('folder') || ''
	if (!FOLDER_RE.test(folder))
		return json({ error: '目录格式应为数字编号路径，例如 05/09' }, 400)

	const cursor = url.searchParams.get('cursor') || undefined
	const prefix = folder ? `${folder}/` : ''
	const page = await env.IMAGES.list({
		prefix,
		delimiter: '/',
		cursor,
		include: ['httpMetadata'],
	})
	const truncated = page.truncated
	const baseUrl = (env.IMAGE_BASE_URL || '').replace(/\/+$/, '')
	return json({
		folder,
		folders: (page.delimitedPrefixes || [])
			.map(prefixPath => prefixPath.replace(/\/+$/, ''))
			.filter(folderName => /^\d/.test(folderName)),
		files: page.objects
			.filter(object => IMAGE_KEY_RE.test(object.key))
			.map(object => ({
				key: object.key,
				name: object.key.split('/').pop() || object.key,
				size: object.size,
				uploaded: object.uploaded.toISOString(),
				contentType: object.httpMetadata?.contentType || '',
				url: baseUrl ? `${baseUrl}/${object.key}` : '',
			})),
		truncated,
		cursor: truncated ? page.cursor : '',
	})
}

async function fileAction(request: Request, env: Env): Promise<Response> {
	const identity = requireIdentity(request, env)
	if (!identity)
		return json({ error: '未登录：请先通过 Cloudflare Access 登录' }, 401)

	let body: { action?: string; key?: string; oldKey?: string; newKey?: string; folder?: string; destFolder?: string }
	try {
		body = await request.json() as typeof body
	}
	catch {
		return json({ error: '请求不是有效的 JSON' }, 400)
	}

	const id = newRequestId()
	const createdAt = new Date().toISOString()
	let record: PendingRecord

	if (body.action === 'delete') {
		if (!validKey(body.key))
			return json({ error: '无效的图片 key' }, 400)
		record = { id, type: 'delete', actorEmail: identity.email, createdAt, delete: { key: body.key } }
	}
	else if (body.action === 'move') {
		if (!validKey(body.oldKey) || !validKey(body.newKey))
			return json({ error: '无效的图片 key' }, 400)
		if (body.oldKey === body.newKey)
			return json({ error: '新旧路径相同' }, 400)
		record = { id, type: 'move', actorEmail: identity.email, createdAt, move: { oldKey: body.oldKey, newKey: body.newKey } }
	}
	else if (body.action === 'folder-delete') {
		if (!body.folder || !FOLDER_RE.test(body.folder))
			return json({ error: '文件夹路径无效' }, 400)
		record = { id, type: 'folder-delete', actorEmail: identity.email, createdAt, folderDelete: { folder: body.folder } }
	}
	else if (body.action === 'folder-move') {
		if (!body.folder || !body.destFolder || !FOLDER_RE.test(body.folder) || !FOLDER_RE.test(body.destFolder))
			return json({ error: '文件夹路径无效' }, 400)
		if (body.folder === body.destFolder)
			return json({ error: '新旧路径相同' }, 400)
		record = { id, type: 'folder-move', actorEmail: identity.email, createdAt, folderMove: { sourceFolder: body.folder, destFolder: body.destFolder } }
	}
	else {
		return json({ error: '不支持的操作' }, 400)
	}

	await writePending(env, record)
	return json({ ok: true, status: 'pending', requestId: id })
}

async function upload(request: Request, env: Env): Promise<Response> {
	const identity = requireIdentity(request, env)
	if (!identity)
		return json({ error: '未登录：请先通过 Cloudflare Access 登录' }, 401)

	let form: FormData
	try {
		form = await request.formData()
	}
	catch {
		return json({ error: '请求不是有效的表单数据' }, 400)
	}

	const file = form.get('file')
	if (!(file instanceof File))
		return json({ error: '缺少文件字段 file' }, 400)

	const extension = ALLOWED_TYPES[file.type]
	if (!extension)
		return json({ error: `不支持的图片类型：${file.type || '未知'}` }, 400)

	if (file.size > MAX_SIZE)
		return json({ error: '图片不能超过 10MB' }, 400)

	if (file.size === 0)
		return json({ error: '图片内容为空' }, 400)

	const articlePath = String(form.get('article') || '').trim()
	const folder = articleFolder(articlePath)
	if (!folder)
		return json({ error: '请填写图片所属文章路径，例如 docs/05.校园生活/09.美食.md' }, 400)

	const bytes = await file.arrayBuffer()
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16)
	const finalKey = `${folder}/${hash}.${extension}`
	const existing = await env.IMAGES.head(finalKey)
	const baseUrl = (env.IMAGE_BASE_URL || '').replace(/\/+$/, '')

	if (existing) {
		return json({
			status: 'exists',
			duplicate: true,
			url: `${baseUrl}/${finalKey}`,
			key: finalKey,
		})
	}

	const id = newRequestId()
	const stagedKey = `${PENDING_PREFIX}${id}/${hash}.${extension}`
	await env.IMAGES.put(stagedKey, bytes, { httpMetadata: { contentType: file.type } })
	const record: PendingRecord = {
		id,
		type: 'upload',
		actorEmail: identity.email,
		createdAt: new Date().toISOString(),
		upload: { stagedKey, finalKey, originalName: file.name, size: file.size },
	}
	await writePending(env, record)
	return json({
		status: 'pending',
		requestId: id,
		message: '图片已提交，等待 owner 批准后才会公开',
	})
}

/**
 * 从文章路径提取分层目录，规则与仓库 docs/public/img/ 一致：
 * 取每一层名称开头的数字（栏目/文章编号）作为目录，
 * 例如 docs/03.计算机知识专题/08.踏入AI高阶之路.md -> 03/08。
 * 每段必须以数字开头，避免路径穿越或任意字符进入 R2 key。
 */
function articleFolder(input: string): string | null {
	let value = input.trim().replaceAll('\\', '/')
	if (value.startsWith('./'))
		value = value.slice(2)
	value = value.replace(/^docs\//i, '')
	if (!value)
		return null
	const segments = value.replace(/\.md$/i, '').split('/').filter(Boolean)
	const numbers: string[] = []
	for (const segment of segments) {
		const match = /^(\d+)/.exec(segment)
		if (!match || match[1].length > 3)
			return null
		numbers.push(match[1])
	}
	if (numbers.length === 0)
		return null
	const folder = numbers.join('/')
	return folder.length <= 100 ? folder : null
}

function page(request: Request, env: Env): Response {
	const identity = identityOf(request)
	const email = identity.email ? `<span id="email">${escapeHtml(identity.email)}</span>` : '<span id="email">未登录（尚未启用 Access）</span>'
	const isAdmin = isAdminIdentity(identity.email, env)
	const managementCard = `
	<div class="card">
		<h2>图片库</h2>
		<p class="drive-hint">点目录进入浏览；移动、重命名、删除都会提交申请，owner 批准后才真正执行。</p>
		<div class="drive-toolbar">
			<button type="button" id="driveUp">↑ 返回上级</button>
			<div id="driveCrumbs" class="drive-crumbs"></div>
			<span class="drive-spacer"></span>
			<button type="button" id="driveSelectAll">全选本页</button>
			<button type="button" id="driveRefresh">刷新</button>
		</div>
		<div id="driveSelection" class="drive-selection" hidden>
			已选 <strong id="driveSelectedCount">0</strong> 项
			<button type="button" id="driveBatchDelete">申请删除</button>
			<button type="button" id="driveBatchMove">申请移动</button>
			<button type="button" id="driveClearSelection">取消选择</button>
		</div>
		<div id="driveList" class="drive-list"></div>
		<p id="driveEmpty" class="drive-empty" hidden>这个目录还没有图片</p>
		<p id="driveMoreWrap" hidden><button type="button" id="driveMore">加载更多</button></p>
		<p id="driveNotice" class="msg"></p>
	</div>
	<div class="card">
		<h2>我的申请</h2>
		<div id="myReqList"></div>
		<p><button type="button" id="myReqRefresh">刷新</button></p>
	</div>`
	const dialogMarkup = `
	<div id="driveDialog" class="modal-mask" hidden>
		<div class="modal" role="dialog" aria-modal="true">
			<h3 id="driveDialogTitle"></h3>
			<div id="driveDialogBody"></div>
			<div class="modal-actions">
				<button type="button" id="driveDialogCancel">取消</button>
				<button type="button" id="driveDialogOk" class="primary">确定</button>
			</div>
		</div>
	</div>
	<div id="driveContext" class="context-menu" hidden></div>`
	const approvalCard = isAdmin ? `
	<div class="card">
		<h2>待批准（owner）</h2>
		<div id="approvalList"></div>
		<p><button type="button" id="approvalRefresh">刷新</button></p>
	</div>` : ''
	return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>NCEPUwiki 图片上传</title>
	<style>
		:root { color-scheme: light dark; }
		[hidden] { display: none !important; }
		body { font-family: system-ui, sans-serif; max-width: 900px; margin: 48px auto; padding: 0 20px; }
		.card { border: 1px solid #ccc; border-radius: 12px; padding: 24px; }
		.drop { border: 2px dashed #888; border-radius: 12px; padding: 40px 16px; text-align: center; cursor: pointer; }
		.drop.over { border-color: #1d6fff; background: #1d6fff14; }
		.result { margin-top: 18px; }
		.result-item { border: 1px solid #ddd; border-radius: 8px; padding: 8px 10px; margin: 8px 0; }
		.result-item .row-url { width: 100%; box-sizing: border-box; font-size: 12px; }
		.result-item .row-actions { display: flex; gap: 8px; align-items: center; margin-top: 4px; flex-wrap: wrap; }
		button { cursor: pointer; }
		.msg { margin-top: 12px; white-space: pre-wrap; }
		.error { color: #d33; }
		.ok { color: #287a3a; }
		small { color: #888; }
		.article-level { margin: 6px 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
		.article-level .level-label { color: #888; font-size: 13px; }
		.level-select { max-width: 100%; }
		.drive-hint { color: #666; font-size: 13px; }
		.drive-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
		.drive-crumbs { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: 13px; }
		.drive-crumbs button { border: none; background: transparent; padding: 4px 6px; border-radius: 6px; color: #1d6fff; }
		.drive-crumbs button:hover { background: #00000012; }
		.drive-spacer { flex: 1; }
		.drive-selection { background: #eef5ff; border: 1px solid #bcd6ff; border-radius: 8px; padding: 6px 10px; margin: 6px 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
		.drive-list { border: 1px solid #eee; border-radius: 8px; overflow: hidden; }
		.drive-item { display: flex; gap: 10px; align-items: center; padding: 6px 10px; border-bottom: 1px solid #f1f1f1; cursor: default; }
		.drive-item:last-child { border-bottom: none; }
		.drive-item:hover { background: #f7f9fc; }
		.drive-item.selected { background: #e8f1ff; }
		.drive-item.folder { cursor: pointer; }
		.drive-item.folder:hover { background: #f0f6ff; }
		.drive-thumb { width: 42px; height: 42px; border-radius: 6px; object-fit: cover; background: #f0f0f0; flex: none; }
		.drive-icon { font-size: 26px; width: 42px; text-align: center; flex: none; line-height: 42px; }
		.drive-name { flex: 1; min-width: 0; }
		.drive-name .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.drive-name .meta { color: #888; font-size: 12px; }
		.drive-size { color: #888; font-size: 12px; flex: none; width: 70px; text-align: right; }
		.drive-actions { flex: none; display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
		.drive-item:hover .drive-actions, .drive-item:focus-within .drive-actions { opacity: 1; }
		.drive-actions button, .drive-actions a { border: none; background: transparent; color: #1d6fff; padding: 4px 7px; border-radius: 6px; text-decoration: none; font-size: 13px; }
		.drive-actions button:hover, .drive-actions a:hover { background: #1d6fff1f; }
		.drive-empty { color: #888; text-align: center; padding: 26px 0; }
		.modal-mask { position: fixed; inset: 0; background: #00000066; display: flex; align-items: center; justify-content: center; z-index: 30; }
		.modal { background: #fff; color: #111; border-radius: 10px; padding: 18px 20px; width: min(92vw, 520px); max-height: 84vh; overflow: auto; box-shadow: 0 16px 40px #0003; }
		.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
		.modal-actions button { padding: 6px 16px; border-radius: 7px; border: 1px solid #ccc; background: #fff; }
		.modal-actions button.primary { background: #1d6fff; border-color: #1d6fff; color: #fff; }
		.context-menu { position: fixed; z-index: 40; background: #fff; color: #111; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 8px 24px #0003; min-width: 150px; padding: 4px; }
		.context-menu button { display: block; width: 100%; text-align: left; border: none; background: transparent; padding: 7px 10px; border-radius: 5px; }
		.context-menu button:hover { background: #f0f0f0; }
	</style>
</head>
<body>
	<h1>NCEPUwiki 图片上传</h1>
	<p id="identity">当前身份：${email}</p>
	<div class="card">
		<div class="drop" id="drop">
			<p>把图片拖到这里，或点击选择文件</p>
			<small>支持 JPG / PNG / WebP / GIF / AVIF，≤ 10MB</small>
		</div>
		<input id="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple hidden>
		<input id="folderInput" type="file" webkitdirectory multiple hidden>
		<p>
			<button type="button" id="pickFiles">选择图片文件</button>
			<button type="button" id="pickFolder">选择整个文件夹</button>
		</p>
		<p><strong>图片所属文章</strong></p>
		<div id="articlePicks"></div>
		<p id="articleStatus" class="msg">正在加载文章目录…</p>
		<p><button type="button" id="manualToggle">＋ 没有我要的文章？手动输入</button></p>
		<div id="articleManual" hidden>
			<p><label>手动填写文章路径：<br><input id="article" type="text" size="60" placeholder="例如：05.校园生活/09.美食 或 docs/05.校园生活/09.美食.md"></label></p>
		</div>
		<button id="upload">上传</button>
		<div class="msg" id="msg"></div>
		<div class="result" id="result" hidden>
			<p><strong>上传结果（批准后才能得到公开链接）：</strong></p>
			<div id="resultList"></div>
		</div>
	</div>
	${managementCard}${approvalCard}${dialogMarkup}
	<script type="module">
		const drop = document.querySelector('#drop')
		const fileInput = document.querySelector('#fileInput')
		const folderInput = document.querySelector('#folderInput')
		const pickFiles = document.querySelector('#pickFiles')
		const pickFolder = document.querySelector('#pickFolder')
		const articleInput = document.querySelector('#article')
		const articlePicks = document.querySelector('#articlePicks')
		const articleStatus = document.querySelector('#articleStatus')
		const articleManual = document.querySelector('#articleManual')
		const manualToggle = document.querySelector('#manualToggle')
		const uploadButton = document.querySelector('#upload')
		const msg = document.querySelector('#msg')
		const result = document.querySelector('#result')
		const resultList = document.querySelector('#resultList')
		const driveList = document.querySelector('#driveList')
		const driveCrumbs = document.querySelector('#driveCrumbs')
		const driveUp = document.querySelector('#driveUp')
		const driveRefresh = document.querySelector('#driveRefresh')
		const driveSelectAll = document.querySelector('#driveSelectAll')
		const driveSelection = document.querySelector('#driveSelection')
		const driveSelectedCount = document.querySelector('#driveSelectedCount')
		const driveBatchDelete = document.querySelector('#driveBatchDelete')
		const driveBatchMove = document.querySelector('#driveBatchMove')
		const driveClearSelection = document.querySelector('#driveClearSelection')
		const driveEmpty = document.querySelector('#driveEmpty')
		const driveMoreWrap = document.querySelector('#driveMoreWrap')
		const driveMore = document.querySelector('#driveMore')
		const driveNotice = document.querySelector('#driveNotice')
		const driveDialog = document.querySelector('#driveDialog')
		const driveDialogTitle = document.querySelector('#driveDialogTitle')
		const driveDialogBody = document.querySelector('#driveDialogBody')
		const driveDialogOk = document.querySelector('#driveDialogOk')
		const driveDialogCancel = document.querySelector('#driveDialogCancel')
		const driveContext = document.querySelector('#driveContext')
		const myReqList = document.querySelector('#myReqList')
		const myReqRefresh = document.querySelector('#myReqRefresh')
		const approvalList = document.querySelector('#approvalList')
		const approvalRefresh = document.querySelector('#approvalRefresh')

		let pendingFiles = []
		let allArticles = []
		let articleValue = ''
		let levelState = []
		let driveFolder = ''
		let driveCursor = ''
		let driveLoading = false
		let drivePageFiles = []
		let driveSelected = new Map()

		function isImage(file) {
			return ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(file.type)
		}

		function addFiles(fileList) {
			const images = []
			let ignored = 0
			for (const file of fileList) {
				if (!file) {
					ignored++
					continue
				}
				if (isImage(file))
					images.push(file)
				else
					ignored++
			}
			if (!images.length) {
				msg.textContent = '没有找到可上传的图片（仅支持 JPG / PNG / WebP / GIF / AVIF）。'
				msg.className = 'msg error'
				return
			}
			pendingFiles = pendingFiles.concat(images)
			showSelection(ignored)
		}

		function showSelection(ignored) {
			const totalMb = pendingFiles.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024
			msg.textContent = '已选择 ' + pendingFiles.length + ' 张图片（共 ' + totalMb.toFixed(2) + ' MB）' + (ignored ? '，已忽略 ' + ignored + ' 个非图片文件' : '')
			msg.className = 'msg'
			uploadButton.disabled = false
		}

		drop.addEventListener('click', () => fileInput.click())
		pickFiles.addEventListener('click', () => fileInput.click())
		pickFolder.addEventListener('click', () => folderInput.click())
		fileInput.addEventListener('change', () => {
			addFiles(fileInput.files)
			fileInput.value = ''
		})
		folderInput.addEventListener('change', () => {
			addFiles(folderInput.files)
			folderInput.value = ''
		})
		drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('over') })
		drop.addEventListener('dragleave', () => drop.classList.remove('over'))
		drop.addEventListener('drop', event => {
			event.preventDefault()
			drop.classList.remove('over')
			addFiles(event.dataTransfer.files)
		})
		document.addEventListener('paste', event => {
			const item = [...event.clipboardData.items].find(item => item.type.startsWith('image/'))
			if (item)
				addFiles([item.getAsFile()])
		})

		function addOption(select, text, value) {
			const option = document.createElement('option')
			option.textContent = text
			option.value = value
			select.append(option)
		}

		function childrenOf(prefix) {
			const folders = new Map()
			const articles = []
			for (const path of allArticles) {
				const parts = path.split('/')
				if (parts.length <= prefix.length)
					continue
				let matches = true
				for (let index = 0; index < prefix.length; index++) {
					if (parts[index] !== prefix[index]) {
						matches = false
						break
					}
				}
				if (!matches)
					continue
				const next = parts[prefix.length]
				if (parts.length === prefix.length + 1) {
					if (!articles.includes(next))
						articles.push(next)
				}
				else {
					folders.set(next, true)
				}
			}
			return { folders: [...folders.keys()], articles }
		}

		function pickArticle(path) {
			articleValue = path
			articleManual.hidden = true
			articleStatus.className = 'msg ok'
			articleStatus.textContent = '已选择：' + path
		}

		function clearLevelsFrom(fromIndex) {
			while (levelState.length > fromIndex) {
				const level = levelState.pop()
				level.element.remove()
			}
		}

		function createLevel(prefix) {
			const children = childrenOf(prefix)
			if (children.folders.length + children.articles.length === 0)
				return

			const element = document.createElement('div')
			element.className = 'article-level'
			const label = document.createElement('span')
			label.className = 'level-label'
			label.textContent = prefix.length ? '第 ' + (prefix.length + 1) + ' 级（当前 ' + prefix.join(' / ') + '）' : '第 1 级：'
			const select = document.createElement('select')
			select.className = 'level-select'
			addOption(select, '请选择…', '')
			for (const folder of children.folders)
				addOption(select, '📁 ' + folder, 'dir:' + folder)
			for (const article of children.articles)
				addOption(select, '📄 ' + article, 'art:' + article)

			const levelIndex = levelState.length
			levelState.push({ element, select, prefix })
			element.append(label, select)
			articlePicks.append(element)

			select.addEventListener('change', () => {
				const raw = select.value
				if (!raw)
					return
				const value = raw.slice(4)
				const isArticle = raw.startsWith('art:')
				clearLevelsFrom(levelIndex + 1)
				articleValue = ''
				if (isArticle) {
					pickArticle(prefix.concat(value).join('/'))
					return
				}
				articleStatus.className = 'msg'
				articleStatus.textContent = '已选目录：' + prefix.concat(value).join(' / ') + '，继续选择下一级'
				createLevel(prefix.concat(value))
			})
		}

		function startLevels() {
			clearLevelsFrom(0)
			articleValue = ''
			createLevel([])
		}

		async function loadArticles() {
			try {
				const response = await fetch('/api/articles')
				if (!response.ok)
					throw new Error('加载失败')
				const data = await response.json()
				allArticles = data.articles || []
				if (!allArticles.length)
					throw new Error('列表为空')
				startLevels()
				articleStatus.className = 'msg'
				articleStatus.textContent = '按栏目逐级选择文章；新建文章点下方“手动输入”。'
			}
			catch {
				articleStatus.className = 'msg error'
				articleStatus.textContent = '文章列表加载失败，请使用手动输入。'
				articleManual.hidden = false
			}
		}
		loadArticles()

		manualToggle.addEventListener('click', () => {
			articleManual.hidden = !articleManual.hidden
			if (!articleManual.hidden)
				articleInput.focus()
		})

		articleInput.addEventListener('input', () => {
			articleValue = articleInput.value.trim()
			if (articleValue) {
				articleStatus.className = 'msg'
				articleStatus.textContent = '将按输入路径分层存放：' + articleValue
			}
		})

		function createResultRow(file) {
			const row = document.createElement('div')
			row.className = 'result-item'
			const name = document.createElement('div')
			name.textContent = file.name
			const url = document.createElement('input')
			url.className = 'row-url'
			url.readOnly = true
			url.value = '上传中…'
			const actions = document.createElement('div')
			actions.className = 'row-actions'
			const note = document.createElement('span')
			row.append(name, url, actions, note)
			resultList.append(row)
			return { row, url, actions, note }
		}

		function appendCopyButton(actions, urlInput) {
			const copy = document.createElement('button')
			copy.type = 'button'
			copy.textContent = '复制链接'
			copy.addEventListener('click', async () => {
				await navigator.clipboard.writeText(urlInput.value)
				copy.textContent = '已复制'
				setTimeout(() => { copy.textContent = '复制链接' }, 2000)
			})
			actions.append(copy)
		}

		uploadButton.addEventListener('click', async () => {
			if (!pendingFiles.length) {
				alert('请先选择图片或文件夹')
				return
			}
			if (!articleValue) {
				alert('请先选择或填写图片所属文章')
				return
			}
			uploadButton.disabled = true
			result.hidden = false
			resultList.textContent = ''
			let pendingCount = 0
			let duplicateCount = 0
			let failedCount = 0
			for (let index = 0; index < pendingFiles.length; index++) {
				const file = pendingFiles[index]
				msg.textContent = '正在上传 ' + (index + 1) + ' / ' + pendingFiles.length + '：' + file.name
				msg.className = 'msg'
				const item = createResultRow(file)
				const body = new FormData()
				body.append('file', file)
				body.append('article', articleValue)
				try {
					const response = await fetch('/api/upload', { method: 'POST', body })
					const data = await response.json()
					if (!response.ok)
						throw new Error(data.error || '上传失败')
					if (data.status === 'pending') {
						pendingCount++
						item.url.value = '等待 owner 批准…'
						item.note.textContent = '已提交申请（' + data.requestId + '），批准后公开'
						item.note.className = 'ok'
					}
					else if (data.status === 'exists') {
						duplicateCount++
						item.url.value = data.url
						item.note.textContent = '图片已存在，链接可直接使用'
						item.note.className = 'ok'
						const preview = document.createElement('a')
						preview.href = data.url
						preview.target = '_blank'
						preview.rel = 'noopener'
						preview.textContent = '预览 ↗'
						item.actions.append(preview)
						appendCopyButton(item.actions, item.url)
					}
					else {
						throw new Error('未知上传状态')
					}
				}
				catch (error) {
					failedCount++
					item.url.value = ''
					item.url.placeholder = '上传失败'
					item.note.textContent = error.message || '上传失败'
					item.note.className = 'error'
				}
			}
			uploadButton.disabled = false
			const summary = []
			if (pendingCount)
				summary.push(pendingCount + ' 张已提交审批')
			if (duplicateCount)
				summary.push(duplicateCount + ' 张已存在复用')
			if (failedCount)
				summary.push(failedCount + ' 张失败')
			msg.textContent = '完成：' + summary.join('，') + '。'
			msg.className = failedCount ? 'msg error' : 'msg ok'
			if (pendingCount)
				loadRequests()
		})

		function formatBytes(bytes) {
			if (!bytes && bytes !== 0)
				return ''
			if (bytes < 1024)
				return bytes + ' B'
			if (bytes < 1024 * 1024)
				return (bytes / 1024).toFixed(1) + ' KB'
			return (bytes / 1024 / 1024).toFixed(2) + ' MB'
		}

		async function apiGet(path) {
			const response = await fetch(path)
			const data = await response.json()
			if (!response.ok)
				throw new Error(data.error || '请求失败')
			return data
		}

		async function apiPost(path, payload) {
			const response = await fetch(path, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			})
			const data = await response.json()
			if (!response.ok)
				throw new Error(data.error || '请求失败')
			return data
		}

		function addButton(parent, text, handler) {
			const button = document.createElement('button')
			button.type = 'button'
			button.textContent = text
			button.addEventListener('click', handler)
			parent.append(button)
			return button
		}

		function driveNoticeMessage(text, isError) {
			driveNotice.textContent = text
			driveNotice.className = isError ? 'msg error' : 'msg ok'
		}

		function updateDriveSelectionUI() {
			driveSelection.hidden = driveSelected.size === 0
			driveSelectedCount.textContent = String(driveSelected.size)
		}

		function toggleFileSelection(file, row, checkbox) {
			if (driveSelected.has(file.key))
				driveSelected.delete(file.key)
			else
				driveSelected.set(file.key, file)
			if (row)
				row.classList.toggle('selected', driveSelected.has(file.key))
			if (checkbox)
				checkbox.checked = driveSelected.has(file.key)
			updateDriveSelectionUI()
		}

		function renderCrumbs() {
			driveCrumbs.textContent = ''
			const parts = driveFolder ? driveFolder.split('/') : []
			const root = document.createElement('button')
			root.type = 'button'
			root.textContent = '全部'
			root.addEventListener('click', () => openDriveFolder(''))
			driveCrumbs.append(root)
			let prefix = ''
			for (const part of parts) {
				prefix = prefix ? prefix + '/' + part : part
				const crumb = document.createElement('button')
				crumb.type = 'button'
				crumb.textContent = part
				crumb.addEventListener('click', () => openDriveFolder(prefix))
				driveCrumbs.append(document.createTextNode(' / '), crumb)
			}
			driveUp.disabled = !driveFolder
		}

		function openDriveFolder(folder) {
			driveFolder = folder
			driveCursor = ''
			drivePageFiles = []
			driveSelected.clear()
			updateDriveSelectionUI()
			loadDrive(true)
		}

		function fileActions(file, row) {
			const actions = document.createElement('div')
			actions.className = 'drive-actions'

			const copy = document.createElement('button')
			copy.type = 'button'
			copy.textContent = '复制链接'
			copy.addEventListener('click', async () => {
				await navigator.clipboard.writeText(file.url || '')
				copy.textContent = '已复制'
				setTimeout(() => { copy.textContent = '复制链接' }, 1500)
			})
			actions.append(copy)

			const rename = document.createElement('button')
			rename.type = 'button'
			rename.textContent = '重命名'
			rename.addEventListener('click', () => openRenameDialog(file))
			actions.append(rename)

			const move = document.createElement('button')
			move.type = 'button'
			move.textContent = '移动'
			move.addEventListener('click', () => openMoveDialog([file]))
			actions.append(move)

			const remove = document.createElement('button')
			remove.type = 'button'
			remove.textContent = '删除'
			remove.addEventListener('click', () => openDeleteDialog([file]))
			actions.append(remove)
			return actions
		}

		function folderActions(folder) {
			const actions = document.createElement('div')
			actions.className = 'drive-actions'
			const open = document.createElement('button')
			open.type = 'button'
			open.textContent = '打开'
			open.addEventListener('click', () => openDriveFolder(folder))
			actions.append(open)
			const move = document.createElement('button')
			move.type = 'button'
			move.textContent = '移动'
			move.addEventListener('click', () => openMoveFolderDialog(folder))
			actions.append(move)
			const remove = document.createElement('button')
			remove.type = 'button'
			remove.textContent = '删除'
			remove.addEventListener('click', () => openDeleteFolderDialog(folder))
			actions.append(remove)
			return actions
		}

		function renderFileRow(file) {
			const row = document.createElement('div')
			row.className = 'drive-item file'
			row.dataset.key = file.key

			const checkbox = document.createElement('input')
			checkbox.type = 'checkbox'
			checkbox.className = 'drive-check'
			checkbox.checked = driveSelected.has(file.key)
			checkbox.addEventListener('click', event => {
				event.stopPropagation()
				toggleFileSelection(file, row, checkbox)
			})

			const thumb = document.createElement('img')
			thumb.className = 'drive-thumb'
			thumb.loading = 'lazy'
			thumb.alt = ''
			if (file.url)
				thumb.src = file.url
			thumb.addEventListener('error', () => {
				thumb.remove()
				const icon = document.createElement('div')
				icon.className = 'drive-icon'
				icon.textContent = '🖼'
				row.insertBefore(icon, row.children[1] || null)
			})

			const nameBox = document.createElement('div')
			nameBox.className = 'drive-name'
			const title = document.createElement('div')
			title.className = 'title'
			title.textContent = file.name
			const meta = document.createElement('div')
			meta.className = 'meta'
			meta.textContent = file.uploaded ? new Date(file.uploaded).toLocaleString() : ''
			nameBox.append(title, meta)

			const size = document.createElement('div')
			size.className = 'drive-size'
			size.textContent = formatBytes(file.size)

			const actions = fileActions(file, row)
			row.append(checkbox, thumb, nameBox, size, actions)
			row.addEventListener('click', () => toggleFileSelection(file, row, checkbox))
			row.addEventListener('dblclick', () => {
				if (file.url)
					window.open(file.url, '_blank')
			})
			row.addEventListener('contextmenu', event => {
				event.preventDefault()
				event.stopPropagation()
				showDriveContext(event, file)
			})
			driveList.append(row)
		}

		function renderFolderRow(folder) {
			const row = document.createElement('div')
			row.className = 'drive-item folder'
			row.dataset.folder = folder
			const spacer = document.createElement('input')
			spacer.type = 'checkbox'
			spacer.tabIndex = -1
			spacer.disabled = true
			const icon = document.createElement('div')
			icon.className = 'drive-icon'
			icon.textContent = '📁'
			const nameBox = document.createElement('div')
			nameBox.className = 'drive-name'
			const title = document.createElement('div')
			title.className = 'title'
			title.textContent = folder
			nameBox.append(title)
			const size = document.createElement('div')
			size.className = 'drive-size'
			const actions = folderActions(folder)
			row.append(spacer, icon, nameBox, size, actions)
			row.addEventListener('click', () => openDriveFolder(folder))
			row.addEventListener('contextmenu', event => {
				event.preventDefault()
				event.stopPropagation()
				showDriveContext(event, { folder })
			})
			driveList.append(row)
		}

		async function loadDrive(reset) {
			if (driveLoading)
				return
			if (!reset && !driveCursor)
				return
			driveLoading = true
			driveRefresh.disabled = true
			driveRefresh.textContent = '加载中…'
			try {
				let url = '/api/files?folder=' + encodeURIComponent(driveFolder)
				if (!reset && driveCursor)
					url += '&cursor=' + encodeURIComponent(driveCursor)
				const data = await apiGet(url)
				if (reset) {
					driveList.textContent = ''
					drivePageFiles = []
				}
				drivePageFiles = drivePageFiles.concat(data.files || [])
				for (const folder of data.folders || [])
					renderFolderRow(folder)
				for (const file of data.files || [])
					renderFileRow(file)
				driveEmpty.hidden = reset && !(data.folders || []).length && !(data.files || []).length
				driveMoreWrap.hidden = !data.truncated
				driveCursor = data.truncated ? data.cursor : ''
				renderCrumbs()
			}
			catch (error) {
				driveNoticeMessage(error.message || '加载失败', true)
			}
			finally {
				driveLoading = false
				driveRefresh.disabled = false
				driveRefresh.textContent = '刷新'
			}
		}

		function hideDriveContext() {
			driveContext.hidden = true
			driveContext.textContent = ''
		}

		function showDriveContext(event, target) {
			hideDriveContext()
			if (!target.folder) {
				const copy = addButton(driveContext, '复制链接', () => navigator.clipboard.writeText(target.url || ''))
				copy.type = 'button'
				addButton(driveContext, '重命名', () => { hideDriveContext(); openRenameDialog(target) }).type = 'button'
				addButton(driveContext, '移动', () => { hideDriveContext(); openMoveDialog([target]) }).type = 'button'
				addButton(driveContext, '删除', () => { hideDriveContext(); openDeleteDialog([target]) }).type = 'button'
			}
			else {
				addButton(driveContext, '打开文件夹', () => { hideDriveContext(); openDriveFolder(target.folder) }).type = 'button'
				addButton(driveContext, '移动文件夹', () => { hideDriveContext(); openMoveFolderDialog(target.folder) }).type = 'button'
				addButton(driveContext, '删除文件夹', () => { hideDriveContext(); openDeleteFolderDialog(target.folder) }).type = 'button'
			}
			const width = driveContext.offsetWidth || 160
			driveContext.style.left = Math.min(event.clientX, window.innerWidth - width - 8) + 'px'
			driveContext.style.top = Math.min(event.clientY, window.innerHeight - 150) + 'px'
			driveContext.hidden = false
		}

		function openDialog(title, body, okText, onOk) {
			driveDialogTitle.textContent = title
			driveDialogBody.textContent = ''
			driveDialogBody.append(body)
			driveDialogOk.textContent = okText
			driveDialog.dataset.handler = ''
			driveDialog._onOk = onOk
			driveDialog.hidden = false
		}

		function closeDialog() {
			driveDialog.hidden = true
			driveDialogBody.textContent = ''
			driveDialog._onOk = null
		}

		function dialogButton(text, kind) {
			const button = document.createElement('button')
			button.type = 'button'
			button.textContent = text
			if (kind)
				button.className = kind
			return button
		}

		function openDeleteDialog(files) {
			const body = document.createElement('div')
			const intro = document.createElement('p')
			intro.textContent = '将提交删除申请，owner 批准后才会真正删除：'
			body.append(intro)
			const list = document.createElement('ul')
			for (const file of files) {
				const item = document.createElement('li')
				item.textContent = file.key
				list.append(item)
			}
			body.append(list)
			openDialog('申请删除', body, '提交删除申请', async () => {
				driveDialogOk.disabled = true
				try {
					let count = 0
					for (const file of files) {
						await apiPost('/api/file', { action: 'delete', key: file.key })
						count++
					}
					driveNoticeMessage('已提交 ' + count + ' 条删除申请，等待 owner 批准', false)
					closeDialog()
					driveSelected.clear()
					updateDriveSelectionUI()
					loadDrive(true)
					loadRequests()
				}
				catch (error) {
					alert(error.message)
				}
				finally {
					driveDialogOk.disabled = false
				}
			})
		}

		function openDeleteFolderDialog(folder) {
			const body = document.createElement('div')
			const warning = document.createElement('p')
			warning.textContent = '将删除文件夹 ' + folder + ' 下的全部图片（含子目录），owner 批准后才会真正执行。'
			const note = document.createElement('small')
			note.textContent = '请确认这些图片在 wiki 文章中已不再使用。'
			body.append(warning, note)
			openDialog('申请删除文件夹', body, '提交删除申请', async () => {
				driveDialogOk.disabled = true
				try {
					const result = await apiPost('/api/file', { action: 'folder-delete', folder })
					driveNoticeMessage('已提交删除文件夹申请：' + result.requestId, false)
					closeDialog()
					loadRequests()
				}
				catch (error) {
					alert(error.message)
				}
				finally {
					driveDialogOk.disabled = false
				}
			})
		}

		function openRenameDialog(file) {
			const body = document.createElement('div')
			const input = document.createElement('input')
			input.type = 'text'
			input.value = file.name
			input.style.width = '100%'
			body.append(input)
			openDialog('重命名 ' + file.name, body, '提交重命名申请', async () => {
				const newName = input.value.trim()
				const parent = file.key.slice(0, file.key.lastIndexOf('/'))
				if (!newName || newName === file.name) {
					alert('请输入新文件名')
					return
				}
				if (newName.includes('/') || newName.includes('\\\\') || !/\\.(?:jpg|jpeg|png|webp|gif|avif)$/i.test(newName)) {
					alert('文件名格式不正确，请保留图片扩展名')
					return
				}
				try {
					const result = await apiPost('/api/file', { action: 'move', oldKey: file.key, newKey: parent + '/' + newName })
					driveNoticeMessage('已提交重命名申请：' + result.requestId, false)
					closeDialog()
					loadRequests()
				}
				catch (error) {
					alert(error.message)
				}
			})
		}

		let moveDestination = ''
		let moveLevels = []

		function clearMoveLevelsFrom(from) {
			while (moveLevels.length > from) {
				const level = moveLevels.pop()
				level.element.remove()
			}
		}

		function renderMoveLevel(prefix) {
			const children = childrenOf(prefix)
			const element = document.createElement('div')
			element.className = 'article-level'
			const label = document.createElement('span')
			label.className = 'level-label'
			label.textContent = prefix.length ? '第 ' + (prefix.length + 1) + ' 级' : '第 1 级'
			const select = document.createElement('select')
			select.className = 'level-select'
			addOption(select, '请选择…', '')
			for (const folder of children.folders)
				addOption(select, '📁 ' + folder, 'dir:' + folder)
			for (const article of children.articles)
				addOption(select, '📄 ' + article, 'art:' + article)
			const index = moveLevels.length
			moveLevels.push({ element, prefix })
			element.append(label, select)
			movePickerBody.append(element)
			select.addEventListener('change', () => {
				if (!select.value)
					return
				const value = select.value.slice(4)
				const isArticle = select.value.startsWith('art:')
				clearMoveLevelsFrom(index + 1)
				if (isArticle) {
					const full = prefix.concat(value)
					const digits = full.map(part => (part.match(/^\\d+/) || [''])[0]).filter(Boolean).join('/')
					moveDestination = digits
					moveDestNote.textContent = '将移动到：' + full.join(' / ') + '（' + digits + '）'
				}
				else {
					moveDestination = ''
					moveDestNote.textContent = ''
					renderMoveLevel(prefix.concat(value))
				}
			})
		}

		let movePickerBody = null
		let moveDestNote = null
		let moveTargetFiles = []
		let moveSourceFolder = ''

		function openMoveDialog(files) {
			moveTargetFiles = files
			moveDestination = ''
			moveLevels = []
			const body = document.createElement('div')
			const hint = document.createElement('p')
			hint.textContent = files.length > 1 ? '将移动 ' + files.length + ' 张图片到：' : '将移动：' + files[0].name
			movePickerBody = document.createElement('div')
			moveDestNote = document.createElement('p')
			moveDestNote.className = 'drive-hint'
			body.append(hint, movePickerBody, moveDestNote)
			openDialog('申请移动', body, '提交移动申请', async () => {
				if (!moveDestination) {
					alert('请先逐级选择目标文章目录')
					return
				}
				driveDialogOk.disabled = true
				try {
					let count = 0
					for (const file of moveTargetFiles) {
						const newKey = moveDestination + '/' + file.name
						if (newKey !== file.key) {
							await apiPost('/api/file', { action: 'move', oldKey: file.key, newKey })
							count++
						}
					}
					driveNoticeMessage('已提交 ' + count + ' 条移动申请，等待 owner 批准', false)
					closeDialog()
					driveSelected.clear()
					updateDriveSelectionUI()
					loadDrive(true)
					loadRequests()
				}
				catch (error) {
					alert(error.message)
				}
				finally {
					driveDialogOk.disabled = false
				}
			})
			renderMoveLevel([])
		}

		function openMoveFolderDialog(folder) {
			moveSourceFolder = folder
			moveTargetFiles = []
			moveDestination = ''
			moveLevels = []
			const body = document.createElement('div')
			const hint = document.createElement('p')
			hint.textContent = '将移动文件夹 ' + folder + ' 内的全部图片（含子目录）到：'
			movePickerBody = document.createElement('div')
			moveDestNote = document.createElement('p')
			moveDestNote.className = 'drive-hint'
			body.append(hint, movePickerBody, moveDestNote)
			openDialog('申请移动文件夹', body, '提交移动申请', async () => {
				if (!moveDestination) {
					alert('请先逐级选择目标文章目录')
					return
				}
				if (moveDestination === moveSourceFolder || moveDestination.startsWith(moveSourceFolder + '/')) {
					alert('不能移动到自身或其子目录')
					return
				}
				driveDialogOk.disabled = true
				try {
					const result = await apiPost('/api/file', { action: 'folder-move', folder: moveSourceFolder, destFolder: moveDestination })
					driveNoticeMessage('已提交移动文件夹申请：' + result.requestId, false)
					closeDialog()
					loadDrive(true)
					loadRequests()
				}
				catch (error) {
					alert(error.message)
				}
				finally {
					driveDialogOk.disabled = false
				}
			})
			renderMoveLevel([])
		}

		function requestDescription(request) {
			if (request.type === 'upload' && request.upload)
				return '上传：' + request.upload.originalName + ' → ' + request.upload.finalKey
			if (request.type === 'delete' && request.delete)
				return '删除：' + request.delete.key
			if (request.type === 'move' && request.move)
				return '移动：' + request.move.oldKey + ' → ' + request.move.newKey
			if (request.type === 'folder-delete' && request.folderDelete)
				return '删除文件夹：' + request.folderDelete.folder + '/'
			if (request.type === 'folder-move' && request.folderMove)
				return '移动文件夹：' + request.folderMove.sourceFolder + '/ → ' + request.folderMove.destFolder + '/'
			return '未知操作'
		}

		function appendRequestRow(container, request, allowAction) {
			const row = document.createElement('div')
			row.className = 'result-item'
			const head = document.createElement('div')
			head.textContent = '#' + request.id + '  ' + requestDescription(request)
			const meta = document.createElement('small')
			meta.textContent = '申请人：' + request.actorEmail + '　时间：' + new Date(request.createdAt).toLocaleString()
			row.append(head, meta)
			if (allowAction) {
				const actions = document.createElement('div')
				actions.className = 'row-actions'
				addButton(actions, '批准', async () => {
					try {
						await apiPost('/api/approve', { requestId: request.id, decision: 'approve' })
						alert('已批准')
						loadRequests()
					}
					catch (error) {
						alert(error.message)
					}
				})
				addButton(actions, '拒绝', async () => {
					try {
						await apiPost('/api/approve', { requestId: request.id, decision: 'reject' })
						alert('已拒绝')
						loadRequests()
					}
					catch (error) {
						alert(error.message)
					}
				})
				row.append(actions)
			}
			container.append(row)
		}

		async function loadRequests() {
			try {
				const mine = await apiGet('/api/requests?mine=1')
				myReqList.textContent = ''
				if (!mine.requests.length)
					myReqList.append(Object.assign(document.createElement('p'), { textContent: '暂无待处理的申请' }))
				for (const request of mine.requests)
					appendRequestRow(myReqList, request, false)

				if (approvalList) {
					const all = await apiGet('/api/requests')
					approvalList.textContent = ''
					if (!all.requests.length)
						approvalList.append(Object.assign(document.createElement('p'), { textContent: '暂无待批准的申请' }))
					for (const request of all.requests)
						appendRequestRow(approvalList, request, true)
				}
			}
			catch (error) {
				alert(error.message || '申请列表加载失败')
			}
		}

		function syncDriveRows() {
			for (const row of driveList.children) {
				const key = row.dataset ? row.dataset.key : ''
				const checkbox = row.querySelector ? row.querySelector('input[type=checkbox]') : null
				if (checkbox && !checkbox.disabled) {
					const checked = key && driveSelected.has(key)
					checkbox.checked = Boolean(checked)
					row.classList.toggle('selected', Boolean(checked))
				}
			}
		}

		if (driveList) {
			driveRefresh.addEventListener('click', () => loadDrive(true))
			driveMore.addEventListener('click', () => loadDrive(false))
			driveUp.addEventListener('click', () => {
				const index = driveFolder.lastIndexOf('/')
				openDriveFolder(index >= 0 ? driveFolder.slice(0, index) : '')
			})
			driveSelectAll.addEventListener('click', () => {
				const visible = drivePageFiles
				const allSelected = visible.length > 0 && visible.every(file => driveSelected.has(file.key))
				if (allSelected) {
					for (const file of visible)
						driveSelected.delete(file.key)
				}
				else {
					for (const file of visible)
						driveSelected.set(file.key, file)
				}
				syncDriveRows()
				updateDriveSelectionUI()
			})
			driveClearSelection.addEventListener('click', () => {
				driveSelected.clear()
				syncDriveRows()
				updateDriveSelectionUI()
			})
			driveBatchDelete.addEventListener('click', () => openDeleteDialog([...driveSelected.values()]))
			driveBatchMove.addEventListener('click', () => openMoveDialog([...driveSelected.values()]))
			driveDialogCancel.addEventListener('click', closeDialog)
			driveDialogOk.addEventListener('click', async () => {
				if (driveDialog._onOk)
					await driveDialog._onOk()
			})
			document.addEventListener('click', hideDriveContext)
			loadDrive(true)
		}
		if (myReqRefresh)
			myReqRefresh.addEventListener('click', loadRequests)
		if (approvalRefresh)
			approvalRefresh.addEventListener('click', loadRequests)
		loadRequests()
	</script>
</body>
</html>`, {
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	})
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'X-Content-Type-Options': 'nosniff',
		},
	})
}

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
