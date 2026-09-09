# NCEPUwiki 图片上传器

任何能登录页面的用户都可以选择图片/文件夹、提交上传或修改申请；**所有修改 R2 的操作都要等 owner 批准后才真正执行**。批准后公开的图片链接可直接复制使用。

本工具只操作 R2 图片，**不会修改 wiki 仓库中的任何 Markdown 文件**。

## 主要文件

| 文件 | 作用 |
| --- | --- |
| `src/index.ts` | 上传器全部代码：页面 UI、申请/审批接口、SHA-256 去重、按文章编号分层存 R2 |
| `wrangler.toml` | Cloudflare Worker 配置：R2 桶绑定、`IMAGE_BASE_URL`、`REQUIRE_AUTH`、`ADMIN_EMAILS` |
| `package.json` | 常用命令（`pnpm dev` / `pnpm typecheck` / `pnpm run deploy:worker`） |
| `README.md` | 本文档 |

## 当前能力

- 限制常见图片格式与大小
- 上传后的 R2 key 与复制链接使用清洗后的原始文件名（如 `00/活动电力之光杯.jpg`），保留中文等可读字符
- 用文件内容 SHA-256 检测“同名同内容”重复：同一目录上传同名同内容的图片会直接复用，同名不同内容会自动追加短哈希后缀避免覆盖
- 图片库为网盘式浏览：进入目录后通过工具栏“上传”（可切换“上传文件夹”）把图片放入当前目录；从“全部”上传时可以按文章目录选择目标，尚未推送的新文章可手动填路径
- 支持一次选择多张图片，或选择整个文件夹（只取文件夹内的图片，不创建空目录/不上传其他文件）
- 支持把图片直接拖进图片库、拖到文件夹图标上，或剪贴板粘贴上传
- 图片按文章编号分层存放：目录名取自文章路径各层数字（`docs/05.校园生活/09.美食.md` → `05/09`），与仓库 `docs/public/img/` 的分层规则一致；移动/重命名时仍从 GitHub 自动加载文章目录，按“栏目 → 子栏目 → 文章”选择目标
- 上传、删除、移动、重命名都以“申请”形式提交，暂存于 R2 的 `_pending/` 隐藏前缀下
- 支持“新建文件夹”：R2 本身不能存空目录，新建申请经 owner 批准后会写入隐藏占位文件，让空文件夹显示在列表中，可进入后继续上传图片
- 文件夹本身支持“打开 / 申请新建子文件夹 / 申请移动整个目录 / 申请删除整个目录”，目录内嵌套图片与占位文件会一起处理
- 只有 `wrangler.toml` 中 `ADMIN_EMAILS` 列出的 owner 能在页面上批准/拒绝
- 批准后图片才真正写入最终路径；申请人的“我的申请”与 owner 的“待批准”列表都在同一页面

例：文章 `docs/03.计算机知识专题/08.踏入AI高阶之路.md` 上传的图片会存为
`https://img.ncepuinfo.cc/03/08/<hash>.webp`。

本版本暂不处理压缩 / WebP 转换 / EXIF 剥离，后续可加 Worker 端图片处理。

## 日常修改与发布

1. 用 VSCode 打开本文件夹 `ncepuwiki-image-uploader`（不是打开 NCEPUwiki 仓库）。
2. 改页面按钮、提示文字、上传结果展示 → 编辑 `src/index.ts` 里的 `page()`（HTML 字符串）。
3. 改上传限制、去重、分层存储逻辑 → 编辑 `src/index.ts` 里的 `upload()`。
4. 改 R2 桶 / 图片域名 / 是否需要登录 → 编辑 `wrangler.toml`。
5. 改可批准申请的 owner 邮箱 → 编辑 `wrangler.toml` 的 `ADMIN_EMAILS`（多个用英文逗号分隔）。
6. 在项目根目录打开终端，先做类型检查：

   ```bash
   pnpm typecheck
   ```

7. 发布到 Cloudflare（会直接替换线上 Worker，无需再进控制台）：

   ```bash
   pnpm run deploy:worker
   ```

   看到 `Deployed ncepuwiki-image-uploader` 即成功；刷新 `https://upload.ncepuinfo.cc` 验证。

部署只会更新 Worker 代码与变量，**不会**改动 R2 里已有的图片、自定义域名和 Cloudflare Access 策略。

## 部署前需要修改

编辑 `wrangler.toml`：

1. `bucket_name` / `preview_bucket_name`：改成你的真实 R2 桶名（示例 `ncepuwiki-image`）。
2. `IMAGE_BASE_URL`：改成图片公开域名（示例 `https://img.ncepuinfo.cc`）。
3. `REQUIRE_AUTH`：套上 Cloudflare Access 之前保持 `"false"`，配置好后再改成 `"true"`。
4. `ADMIN_EMAILS`：填写 NCEPUwiki GitHub 组织 owner 的登录邮箱（例如 `1361942776@qq.com`），只有这些邮箱能批准图片修改。

R2 桶需先在 Cloudflare 控制台绑定 `img.ncepuinfo.cc` 之类的自定义域名，上传 URL 才能公开访问。

## 本地开发

```bash
pnpm install
pnpm dev
```

## 部署

需要先在本机登录 Cloudflare：

```bash
pnpm wrangler login
pnpm deploy:worker
```

注意：不要运行 `pnpm deploy`，那是 pnpm 自带的部署命令（会报 `ERR_PNPM_NOTHING_TO_DEPLOY`）；本项目部署请使用 `pnpm deploy:worker`。

部署后把 Worker 绑定到 `upload.ncepuinfo.cc`（或在 Cloudflare 控制台添加自定义域 / Worker 路由）。

## 登录限制（第三步，建议上线前完成）

不要直接把上传 Worker 公开给所有人。推荐：

1. Cloudflare Zero Trust → Access → Applications 新建应用，覆盖 `upload.ncepuinfo.cc/*`。
2. 身份源选择 GitHub，并限制只有 NCEPUwiki 组织/团队成员可访问。
3. 将 `wrangler.toml` 中 `REQUIRE_AUTH` 改为 `"true"` 后重新部署。

启用后，Worker 会要求请求携带 Cloudflare Access 签发的 JWT；未登录请求会被拒绝。
