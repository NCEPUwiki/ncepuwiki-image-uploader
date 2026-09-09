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
	type: 'upload' | 'delete' | 'move' | 'folder-create' | 'folder-delete' | 'folder-move'
	actorEmail: string
	createdAt: string
	upload?: { stagedKey: string; finalKey: string; originalName: string; size: number; sha256?: string }
	delete?: { key: string }
	move?: { oldKey: string; newKey: string }
	folderCreate?: { folder: string }
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
		// 移动/重命名/整目录移动时保留原文件名元数据
		customMetadata: source.customMetadata,
	})
	await env.IMAGES.delete(oldKey)
	return null
}

/**
 * 列出目录下的全部对象（包括隐藏占位文件）。
 * 文件夹删除/移动需要连同 .folder 占位一起处理，不能只删图片。
 */
async function listAllKeys(env: Env, prefix: string): Promise<string[]> {
	const keys: string[] = []
	let cursor: string | undefined
	do {
		const page = await env.IMAGES.list({ prefix, limit: 1000, cursor })
		for (const object of page.objects)
			keys.push(object.key)
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
			// 保存原始上传文件名与内容哈希；列表展示原名，同名同内容仍可去重
			customMetadata: {
				originalName: record.upload.originalName,
				...(record.upload.sha256 ? { sha256: record.upload.sha256 } : {}),
			},
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
		const keys = await listAllKeys(env, `${record.folderDelete.folder}/`)
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
		const sourceKeys = await listAllKeys(env, `${source}/`)
		const destKeys = new Set(await listAllKeys(env, `${dest}/`))
		const markerName = '.folder'
		for (const key of sourceKeys) {
			const newKey = `${dest}/${key.slice(source.length + 1)}`
			// 隐藏占位文件可重复存在于不同目录，不作为冲突；真正的图片冲突才阻止移动
			if (key.endsWith(`/${markerName}`))
				continue
			if (destKeys.has(newKey))
				return json({ error: `目标目录已有 ${newKey}，请先处理冲突` }, 409)
		}
		for (const key of sourceKeys) {
			const newKey = `${dest}/${key.slice(source.length + 1)}`
			if (key.endsWith(`/${markerName}`)) {
				// 目标若已有占位文件则不再重复创建，移动完成后删除旧的即可
				if (destKeys.has(newKey))
					await env.IMAGES.delete(key)
				else
					await moveObject(env, key, newKey)
				continue
			}
			const error = await moveObject(env, key, newKey)
			if (error)
				return json({ error }, 404)
		}
	}
	else if (record.type === 'folder-create' && record.folderCreate) {
		const folder = record.folderCreate.folder
		if (!FOLDER_RE.test(folder))
			return json({ error: '文件夹路径无效' }, 400)
		const markerKey = `${folder}/.folder`
		const existing = await env.IMAGES.head(markerKey)
		if (!existing) {
			// 没有占位文件但有图片，同样说明目录已存在，不能重复“新建”
			const probe = await env.IMAGES.list({ prefix: `${folder}/`, limit: 1 })
			if (probe.objects.length)
				return json({ error: `目录 ${folder} 已存在` }, 409)
		}
		await env.IMAGES.put(markerKey, '', { httpMetadata: { contentType: 'text/plain; charset=utf-8' } })
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
		include: ['httpMetadata', 'customMetadata'],
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
				// 原文件名只在 R2 元数据里，公开 key 仍是内容哈希
				originalName: object.customMetadata?.originalName || '',
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
	else if (body.action === 'folder-create') {
		if (!body.folder || !FOLDER_RE.test(body.folder))
			return json({ error: '文件夹路径无效' }, 400)
		record = { id, type: 'folder-create', actorEmail: identity.email, createdAt, folderCreate: { folder: body.folder } }
	}
	else {
		return json({ error: '不支持的操作' }, 400)
	}

	await writePending(env, record)
	return json({ ok: true, status: 'pending', requestId: id })
}

/**
 * 把上传时的本地文件名清洗成可安全用于 R2 key / URL 的文件名。
 * 扩展名以内容实际类型为准，防止文件后缀与内容不一致。
 */
function storageImageName(originalName: string, mappedExtension: string): string {
	let base = originalName.trim().replaceAll('\\', '/').split('/').pop() || ''
	// 去掉路径分隔与常见危险字符（保留中文、空格、横线、下划线等可读字符）
	base = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
		.replace(/\.+$/g, '')
		.trim()
	if (!base || base === '.' || base === '..')
		base = 'image'
	// 后缀统一按图片真实类型生成，避免 .png 内容却存成 .jpg
	base = base.replace(/\.[^.]+$/, '').slice(0, 150)
	if (!base)
		base = 'image'
	return `${base}.${mappedExtension}`
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

	const folderParam = String(form.get('folder') || '').trim()
	let folder = ''
	if (folderParam) {
		if (!FOLDER_RE.test(folderParam))
			return json({ error: '目录格式应为数字编号路径，例如 05/09' }, 400)
		folder = folderParam
	}
	else {
		const articlePath = String(form.get('article') || '').trim()
		const derived = articleFolder(articlePath)
		if (!derived)
			return json({ error: '缺少上传目录：请指定数字目录（如 05/09）或文章路径' }, 400)
		folder = derived
	}

	const bytes = await file.arrayBuffer()
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16)
	const baseUrl = (env.IMAGE_BASE_URL || '').replace(/\/+$/, '')

	// 公开文件名直接使用本地原名；同名但内容不同时追加短哈希避免覆盖
	let fileName = storageImageName(file.name, extension)
	let finalKey = `${folder}/${fileName}`
	let existing = await env.IMAGES.head(finalKey)
	if (existing && existing.customMetadata?.sha256 !== hash) {
		const dot = fileName.lastIndexOf('.')
		fileName = `${fileName.slice(0, dot)}-${hash.slice(0, 8)}${fileName.slice(dot)}`
		finalKey = `${folder}/${fileName}`
		existing = await env.IMAGES.head(finalKey)
	}

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
		upload: { stagedKey, finalKey, originalName: file.name, size: file.size, sha256: hash },
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
	<div class="card drive-card" id="driveCard">
		<h2>图片库</h2>
		<p class="drive-hint">进入目标目录后点“上传”，图片会存入当前目录；在“全部”上传时可选择目标文章，也支持把图片直接拖进来。新建文件夹、移动、重命名、删除都会提交申请，owner 批准后才真正执行。</p>
		<div class="drive-toolbar">
			<button type="button" id="driveUp">↑ 返回上级</button>
			<div id="driveCrumbs" class="drive-crumbs"></div>
			<span class="drive-spacer"></span>
			<div class="upload-split">
				<button type="button" id="driveUpload" class="upload-main" title="上传图片">上传</button>
				<button type="button" id="driveUploadToggle" class="upload-arrow" aria-label="更多上传方式" aria-haspopup="menu">▾</button>
				<div id="driveUploadMenu" class="upload-menu" hidden>
					<button type="button" id="driveUploadFiles">上传文件…</button>
					<button type="button" id="driveUploadFolder">上传文件夹…</button>
				</div>
			</div>
			<button type="button" id="driveNewFolder">＋ 新建文件夹</button>
			<button type="button" id="driveSelectAll">全选本页</button>
			<button type="button" id="driveRefresh">刷新</button>
		</div>
		<input id="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple hidden>
		<input id="folderInput" type="file" webkitdirectory multiple hidden>
		<div id="driveSelection" class="drive-selection" hidden>
			已选 <strong id="driveSelectedCount">0</strong> 项
			<button type="button" id="driveBatchDelete">申请删除</button>
			<button type="button" id="driveBatchMove">申请移动</button>
			<button type="button" id="driveClearSelection">取消选择</button>
		</div>
		<div id="uploadQueue" class="upload-queue" hidden>
			<div class="upload-queue-head">
				<strong id="uploadQueueTitle">上传</strong>
				<button type="button" id="uploadQueueClose">收起</button>
			</div>
			<div id="uploadQueueList" class="upload-queue-list"></div>
		</div>
		<div id="driveList" class="drive-list"></div>
		<p id="driveEmpty" class="drive-empty" hidden>这个目录还没有图片</p>
		<p id="driveMoreWrap" hidden><button type="button" id="driveMore">加载更多</button></p>
		<div id="driveDropLayer" class="drive-drop-layer" hidden>
			<div class="drive-drop-inner">
				<p class="drive-drop-title">松开鼠标上传图片</p>
				<p class="drive-drop-sub">图片将存入 <strong id="driveDropTarget">当前目录</strong></p>
			</div>
		</div>
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
	<title>NCEPUwiki 图片库</title>
	<style>
		:root { color-scheme: light dark; }
		[hidden] { display: none !important; }
		body { font-family: system-ui, sans-serif; max-width: 900px; margin: 48px auto; padding: 0 20px; }
		.card { border: 1px solid #ccc; border-radius: 12px; padding: 24px; }
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
		.drive-card { position: relative; }
		.drive-toolbar button { padding: 5px 12px; border-radius: 7px; border: 1px solid #ccc; background: #fff; color: #111; font-size: 14px; }
		.drive-toolbar button:hover { background: #eef4ff; }
		.drive-crumbs { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: 13px; }
		.drive-crumbs button { border: none; background: transparent; padding: 4px 6px; border-radius: 6px; color: #1d6fff; }
		.drive-crumbs button:hover { background: #00000012; }
		.drive-spacer { flex: 1; }
		.upload-split { position: relative; display: flex; }
		.upload-split .upload-main { background: #1d6fff; border-color: #1d6fff; color: #fff; border-radius: 7px 0 0 7px; }
		.upload-split .upload-arrow { border-left: none; border-radius: 0 7px 7px 0; padding: 5px 9px; }
		.upload-split .upload-main:hover, .upload-split .upload-arrow:hover { background: #0d5fe0; }
		.upload-menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 60; background: #fff; color: #111; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 8px 24px #0003; min-width: 160px; padding: 4px; }
		.upload-menu button { display: block; width: 100%; text-align: left; border: none; background: transparent; padding: 7px 10px; border-radius: 5px; font-size: 14px; }
		.upload-menu button:hover { background: #eef4ff; }
		.drive-selection { background: #eef5ff; border: 1px solid #bcd6ff; border-radius: 8px; padding: 6px 10px; margin: 6px 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
		.upload-queue { margin: 8px 0; border: 1px solid #cfe0ff; border-radius: 10px; overflow: hidden; background: #f5f9ff; }
		.upload-queue-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; background: #eaf2ff; font-size: 14px; }
		.upload-queue-head button { border: none; background: transparent; color: #1d6fff; font-size: 13px; }
		.upload-queue-list { max-height: 260px; overflow: auto; padding: 4px 12px; }
		.upload-item { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px dashed #d5e5ff; font-size: 13px; }
		.upload-item:last-child { border-bottom: none; }
		.upload-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.upload-name small { display: block; color: #888; }
		.upload-state { flex: none; max-width: 280px; text-align: right; }
		.upload-actions { flex: none; display: flex; gap: 6px; }
		.upload-actions button, .upload-actions a { border: none; background: transparent; color: #1d6fff; padding: 3px 6px; border-radius: 5px; text-decoration: none; font-size: 13px; }
		.upload-actions button:hover, .upload-actions a:hover { background: #1d6fff1f; }
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
		.drive-drop-layer { position: absolute; inset: 0; z-index: 20; background: #1d6fff1f; border-radius: 12px; display: flex; align-items: center; justify-content: center; pointer-events: none; }
		.drive-drop-inner { background: #fff; color: #111; border: 1px solid #1d6fff; border-radius: 12px; padding: 22px 34px; text-align: center; box-shadow: 0 12px 32px #0004; }
		.drive-drop-title { margin: 0 0 6px; font-size: 17px; }
		.drive-drop-sub { margin: 0; color: #555; font-size: 13px; }
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
	<h1>NCEPUwiki 图片库</h1>
	<p id="identity">当前身份：${email}</p>
	${managementCard}${approvalCard}${dialogMarkup}
	<script type="module">
		const fileInput = document.querySelector('#fileInput')
		const folderInput = document.querySelector('#folderInput')
		const driveCard = document.querySelector('#driveCard')
		const driveUpload = document.querySelector('#driveUpload')
		const driveUploadToggle = document.querySelector('#driveUploadToggle')
		const driveUploadMenu = document.querySelector('#driveUploadMenu')
		const driveUploadFiles = document.querySelector('#driveUploadFiles')
		const driveUploadFolder = document.querySelector('#driveUploadFolder')
		const uploadQueue = document.querySelector('#uploadQueue')
		const uploadQueueTitle = document.querySelector('#uploadQueueTitle')
		const uploadQueueList = document.querySelector('#uploadQueueList')
		const uploadQueueClose = document.querySelector('#uploadQueueClose')
		const driveDropLayer = document.querySelector('#driveDropLayer')
		const driveDropTarget = document.querySelector('#driveDropTarget')
		const driveList = document.querySelector('#driveList')
		const driveCrumbs = document.querySelector('#driveCrumbs')
		const driveUp = document.querySelector('#driveUp')
		const driveRefresh = document.querySelector('#driveRefresh')
		const driveNewFolder = document.querySelector('#driveNewFolder')
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

		let allArticles = []
		let driveFolder = ''
		let driveCursor = ''
		let driveLoading = false
		let drivePageFiles = []
		let driveSelected = new Map()
		let uploadRunning = false
		let dragDepth = 0

		function isImage(file) {
			return ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(file.type)
		}

		function hideUploadMenu() {
			driveUploadMenu.hidden = true
		}

		function addUploadFiles(fileList) {
			if (uploadRunning) {
				driveNoticeMessage('上一批图片仍在处理，请稍候再试', true)
				return
			}
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
				driveNoticeMessage('没有找到可上传的图片（仅支持 JPG / PNG / WebP / GIF / AVIF）。', true)
				return
			}
			hideUploadMenu()
			if (driveFolder)
				uploadImages(images, driveFolder, ignored)
			else
				chooseArticleDestination(images, ignored)
		}

		fileInput.addEventListener('change', () => {
			addUploadFiles(fileInput.files)
			fileInput.value = ''
		})
		folderInput.addEventListener('change', () => {
			addUploadFiles(folderInput.files)
			folderInput.value = ''
		})

		driveUpload.addEventListener('click', () => {
			fileInput.click()
		})
		driveUploadToggle.addEventListener('click', event => {
			event.stopPropagation()
			driveUploadMenu.hidden = !driveUploadMenu.hidden
		})
		driveUploadFiles.addEventListener('click', () => {
			fileInput.click()
		})
		driveUploadFolder.addEventListener('click', () => {
			folderInput.click()
		})
		document.addEventListener('click', hideUploadMenu)

		uploadQueueClose.addEventListener('click', () => {
			uploadQueue.hidden = true
		})

		function showDropLayer() {
			if (!driveFolder)
				driveDropTarget.textContent = '目标文章'
			else
				driveDropTarget.textContent = driveFolder
			driveDropLayer.hidden = false
		}

		function hideDropLayer() {
			dragDepth = 0
			driveDropLayer.hidden = true
		}

		if (driveCard) {
			driveCard.addEventListener('dragenter', event => {
				if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files'))
					return
				event.preventDefault()
				dragDepth++
				showDropLayer()
			})
			driveCard.addEventListener('dragover', event => {
				if (Array.from(event.dataTransfer.types).includes('Files'))
					event.preventDefault()
			})
			driveCard.addEventListener('dragleave', () => {
				dragDepth = Math.max(0, dragDepth - 1)
				if (!dragDepth)
					hideDropLayer()
			})
			driveCard.addEventListener('drop', event => {
				event.preventDefault()
				hideDropLayer()
				const files = event.dataTransfer ? event.dataTransfer.files : null
				if (!files || !files.length)
					return
				const targetRow = event.target instanceof Element ? event.target.closest('.drive-item.folder[data-folder]') : null
				if (targetRow && driveFolder !== targetRow.dataset.folder)
					openDriveFolder(targetRow.dataset.folder)
				addUploadFiles(files)
			})
		}

		document.addEventListener('paste', event => {
			if (!event.clipboardData)
				return
			const active = document.activeElement
			if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable))
				return
			const images = [...event.clipboardData.items].filter(item => item.kind === 'file' && item.type.startsWith('image/'))
			if (!images.length)
				return
			event.preventDefault()
			addUploadFiles(images.map(item => item.getAsFile()))
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

		async function loadArticles() {
			try {
				const response = await fetch('/api/articles')
				if (!response.ok)
					throw new Error('加载失败')
				const data = await response.json()
				allArticles = data.articles || []
			}
			catch {
				allArticles = []
			}
		}
		loadArticles()

		async function chooseArticleDestination(images, ignored) {
			if (!allArticles.length) {
				driveNoticeMessage('正在加载文章目录…', false)
				await loadArticles()
			}
			const body = document.createElement('div')
			const hint = document.createElement('p')
			hint.textContent = '从“全部”上传时，请选择这些图片要放到的文章；图片会自动按文章编号存入对应目录。'
			const picks = document.createElement('div')
			const note = document.createElement('p')
			note.className = 'drive-hint'
			const toggle = document.createElement('button')
			toggle.type = 'button'
			toggle.textContent = '＋ 没有我要的文章？手动输入'
			const manualWrap = document.createElement('div')
			manualWrap.hidden = true
			const manualLabel = document.createElement('label')
			manualLabel.textContent = '手动填写文章路径：'
			const manualInput = document.createElement('input')
			manualInput.type = 'text'
			manualInput.style.width = '100%'
			manualInput.placeholder = '例如：05.校园生活/09.美食 或 docs/05.校园生活/09.美食.md'
			manualLabel.append(document.createElement('br'), manualInput)
			manualWrap.append(manualLabel)
			body.append(hint, picks, note, toggle, manualWrap)

			const levels = []
			let articlePath = ''
			function clearLevelsFrom(fromIndex) {
				while (levels.length > fromIndex) {
					const level = levels.pop()
					level.element.remove()
				}
			}
			function renderLevel(prefix) {
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
				const index = levels.length
				levels.push({ element })
				element.append(label, select)
				picks.append(element)
				select.addEventListener('change', () => {
					if (!select.value)
						return
					const value = select.value.slice(4)
					clearLevelsFrom(index + 1)
					if (select.value.startsWith('art:')) {
						articlePath = prefix.concat(value).join('/')
						note.textContent = '将按文章编号存到：' + articlePath
					}
					else {
						articlePath = ''
						note.textContent = ''
						renderLevel(prefix.concat(value))
					}
				})
			}
			function rebuildPicker() {
				picks.hidden = false
				clearLevelsFrom(0)
				renderLevel([])
			}
			rebuildPicker()
			if (!allArticles.length) {
				picks.hidden = true
				toggle.hidden = true
				manualWrap.hidden = false
				note.textContent = '文章列表加载失败，请直接填写文章路径。'
				manualInput.focus()
			}
			toggle.addEventListener('click', () => {
				manualWrap.hidden = !manualWrap.hidden
				if (!manualWrap.hidden) {
					articlePath = ''
					note.textContent = ''
					picks.hidden = true
					clearLevelsFrom(0)
					manualInput.focus()
				}
				else {
					rebuildPicker()
				}
			})
			manualInput.addEventListener('input', () => {
				articlePath = manualInput.value.trim()
				note.textContent = articlePath ? '将按输入路径分层存放：' + articlePath : ''
			})

			let started = false
			openDialog('上传到哪篇文章？', body, '继续上传', async () => {
				const target = manualInput.value.trim() || articlePath
				if (!target) {
					alert('请先选择或填写图片所属文章')
					return
				}
				if (started)
					return
				started = true
				closeDialog()
				uploadImages(images, target, ignored, true)
			})
		}

		function createUploadRow(file) {
			const row = document.createElement('div')
			row.className = 'upload-item'
			const nameBox = document.createElement('div')
			nameBox.className = 'upload-name'
			const name = document.createElement('span')
			name.textContent = file.name
			const meta = document.createElement('small')
			meta.textContent = formatBytes(file.size) + (file.type ? ' · ' + file.type : '')
			nameBox.append(name, meta)
			const status = document.createElement('span')
			status.className = 'upload-state'
			status.textContent = '上传中…'
			const actions = document.createElement('span')
			actions.className = 'upload-actions'
			row.append(nameBox, status, actions)
			uploadQueueList.append(row)
			return { row, status, actions }
		}

		function addCopyAction(actions, url) {
			const copy = document.createElement('button')
			copy.type = 'button'
			copy.textContent = '复制链接'
			copy.addEventListener('click', async () => {
				await navigator.clipboard.writeText(url)
				copy.textContent = '已复制'
				setTimeout(() => { copy.textContent = '复制链接' }, 2000)
			})
			actions.append(copy)
		}

		function addPreviewAction(actions, url) {
			const preview = document.createElement('a')
			preview.href = url
			preview.target = '_blank'
			preview.rel = 'noopener'
			preview.textContent = '预览 ↗'
			actions.append(preview)
		}

		async function uploadImages(files, target, ignored, articleMode) {
			if (uploadRunning) {
				driveNoticeMessage('上一批图片仍在处理，请稍候再试', true)
				return
			}
			uploadRunning = true
			uploadQueue.hidden = false
			uploadQueueList.textContent = ''
			uploadQueueTitle.textContent = '正在上传到 ' + target + '…'
			if (ignored)
				driveNoticeMessage('已忽略 ' + ignored + ' 个非图片文件', false)
			let pendingCount = 0
			let duplicateCount = 0
			let failedCount = 0
			for (let index = 0; index < files.length; index++) {
				const file = files[index]
				uploadQueueTitle.textContent = '正在上传 ' + (index + 1) + ' / ' + files.length + '：' + file.name
				const item = createUploadRow(file)
				const body = new FormData()
				body.append('file', file)
				body.append(articleMode ? 'article' : 'folder', target)
				try {
					const response = await fetch('/api/upload', { method: 'POST', body })
					const data = await response.json()
					if (!response.ok)
						throw new Error(data.error || '上传失败')
					if (data.status === 'pending') {
						pendingCount++
						item.status.textContent = '已提交申请，等待批准后公开'
						item.status.className = 'upload-state ok'
					}
					else if (data.status === 'exists') {
						duplicateCount++
						item.status.textContent = '图片已存在，可直接使用'
						item.status.className = 'upload-state ok'
						addPreviewAction(item.actions, data.url)
						addCopyAction(item.actions, data.url)
					}
					else {
						throw new Error('未知上传状态')
					}
				}
				catch (error) {
					failedCount++
					item.status.textContent = error.message || '上传失败'
					item.status.className = 'upload-state error'
				}
			}
			const summary = []
			if (pendingCount)
				summary.push(pendingCount + ' 张已提交审批')
			if (duplicateCount)
				summary.push(duplicateCount + ' 张已存在复用')
			if (failedCount)
				summary.push(failedCount + ' 张失败')
			uploadQueueTitle.textContent = '上传到 ' + target + '：' + (summary.join('，') || '没有可上传的图片')
			driveNoticeMessage('上传到 ' + target + '：' + summary.join('，') + '。', failedCount > 0)
			uploadRunning = false
			if (pendingCount)
				loadRequests()
		}

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
			hideUploadMenu()
			driveCursor = ''
			drivePageFiles = []
			driveSelected.clear()
			updateDriveSelectionUI()
			loadDrive(true)
		}

		function openNewFolderDialog() {
			const body = document.createElement('div')
			const context = driveFolder ? '在「' + driveFolder + '」下' : '在「全部」根目录下'
			const hint = document.createElement('p')
			hint.textContent = context + '新建文件夹。R2 不支持真空目录，申请批准后会写入一个隐藏占位文件让空文件夹显示在列表中。'
			const label = document.createElement('label')
			label.textContent = '新文件夹编号（1-3 位数字）：'
			const input = document.createElement('input')
			input.type = 'text'
			input.inputMode = 'numeric'
			input.maxLength = 3
			input.style.width = '100%'
			label.append(document.createElement('br'), input)
			body.append(hint, label)
			openDialog('新建文件夹', body, '提交新建申请', async () => {
				const name = input.value.trim()
				if (!/^\\d{1,3}$/.test(name)) {
					alert('文件夹编号只能是 1-3 位数字，例如 99')
					return
				}
				const folder = driveFolder ? driveFolder + '/' + name : name
				driveDialogOk.disabled = true
				try {
					const result = await apiPost('/api/file', { action: 'folder-create', folder })
					driveNoticeMessage('已提交新建文件夹申请：' + folder + '（' + result.requestId + '），等待 owner 批准', false)
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
			// 优先展示上传时的本地文件名；旧图没有元数据时回退显示哈希文件名
			title.textContent = file.originalName || file.name
			title.title = file.key
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
			if (request.type === 'folder-create' && request.folderCreate)
				return '新建文件夹：' + request.folderCreate.folder + '/'
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
						if (request.type === 'folder-create' && request.folderCreate) {
							const created = request.folderCreate.folder
							const parent = created.includes('/') ? created.slice(0, created.lastIndexOf('/')) : ''
							openDriveFolder(parent)
						}
						else {
							loadDrive(true)
						}
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
			driveNewFolder.addEventListener('click', openNewFolderDialog)
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
