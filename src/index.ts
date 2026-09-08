export interface Env {
	IMAGES: R2Bucket
	IMAGE_BASE_URL: string
	REQUIRE_AUTH?: string
}

const ALLOWED_TYPES: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/avif': 'avif',
}

const MAX_SIZE = 10 * 1024 * 1024

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

async function upload(request: Request, env: Env): Promise<Response> {
	if (isAuthRequired(env) && !request.headers.has('CF-Access-Jwt-Assertion'))
		return json({ error: '未登录：请先通过 Cloudflare Access 登录' }, 401)

	const identity = identityOf(request)
	if (isAuthRequired(env) && !identity.email)
		return json({ error: '无法识别登录身份' }, 401)

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
	const key = `${folder}/${hash}.${extension}`
	const existing = await env.IMAGES.head(key)

	if (!existing)
		await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: file.type } })

	const baseUrl = env.IMAGE_BASE_URL.replace(/\/+$/, '')
	const url = `${baseUrl}/${key}`

	return json({
		url,
		key,
		duplicate: Boolean(existing),
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
	return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>NCEPUwiki 图片上传</title>
	<style>
		:root { color-scheme: light dark; }
		body { font-family: system-ui, sans-serif; max-width: 680px; margin: 48px auto; padding: 0 20px; }
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
			<p><strong>上传结果（直接复制图片链接）：</strong></p>
			<div id="resultList"></div>
		</div>
	</div>
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

		let pendingFiles = []
		let allArticles = []
		let articleValue = ''
		let levelState = []

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
			let successCount = 0
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
					item.url.value = data.url
					item.note.textContent = data.duplicate ? '已存在相同图片，直接复用链接' : '上传成功'
					item.note.className = 'ok'
					if (data.duplicate)
						duplicateCount++
					else
						successCount++
					const preview = document.createElement('a')
					preview.href = data.url
					preview.target = '_blank'
					preview.rel = 'noopener'
					preview.textContent = '预览 ↗'
					item.actions.append(preview)
					appendCopyButton(item.actions, item.url)
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
			if (successCount)
				summary.push(successCount + ' 张新上传')
			if (duplicateCount)
				summary.push(duplicateCount + ' 张已存在复用')
			if (failedCount)
				summary.push(failedCount + ' 张失败')
			msg.textContent = '完成：' + summary.join('，') + '。'
			msg.className = failedCount ? 'msg error' : 'msg ok'
		})
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
