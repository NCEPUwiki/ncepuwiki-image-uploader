# NCEPUwiki 图片上传器

普通编辑者无需接触 Cloudflare/R2，只需打开上传页、登录、选择图片/文件夹并复制返回的图片链接。

上传只把图片存入 R2，**不会修改 wiki 仓库中的任何 Markdown 文件**。

## 主要文件

| 文件 | 作用 |
| --- | --- |
| `src/index.ts` | 上传器全部代码：页面 UI、上传接口、SHA-256 去重、按文章编号分层存 R2 |
| `wrangler.toml` | Cloudflare Worker 配置：R2 桶绑定、`IMAGE_BASE_URL`、`REQUIRE_AUTH` |
| `package.json` | 常用命令（`pnpm dev` / `pnpm typecheck` / `pnpm run deploy:worker`） |
| `README.md` | 本文档 |

## 当前能力（第二步）

- 限制常见图片格式与大小
- 用文件内容 SHA-256 去重，避免同一张图重复占用空间
- 支持一次选择多张图片、或选择整个文件夹（只取文件夹内的图片，不创建空目录/不上传其他文件）
- 支持拖拽与粘贴上传
- 图片按文章编号分层存放：上传页从 GitHub 仓库自动加载文章目录，按“栏目 → 子栏目 → 文章”逐级下拉选择；尚未推送的新文章可手动输入路径。Worker 自动提取每层数字编号（`docs/05.校园生活/09.美食.md` → `05/09`）作为目录，与仓库 `docs/public/img/` 的分层规则一致
- 每个上传结果下方直接给出可复制的图片链接与预览入口

例：文章 `docs/03.计算机知识专题/08.踏入AI高阶之路.md` 上传的图片会存为
`https://img.ncepuinfo.cc/03/08/<hash>.webp`。

本版本暂不处理压缩 / WebP 转换 / EXIF 剥离，后续可加 Worker 端图片处理。

## 日常修改与发布

1. 用 VSCode 打开本文件夹 `ncepuwiki-image-uploader`（不是打开 NCEPUwiki 仓库）。
2. 改页面按钮、提示文字、上传结果展示 → 编辑 `src/index.ts` 里的 `page()`（HTML 字符串）。
3. 改上传限制、去重、分层存储逻辑 → 编辑 `src/index.ts` 里的 `upload()`。
4. 改 R2 桶 / 图片域名 / 是否需要登录 → 编辑 `wrangler.toml`。
5. 在项目根目录打开终端，先做类型检查：

   ```bash
   pnpm typecheck
   ```

6. 发布到 Cloudflare（会直接替换线上 Worker，无需再进控制台）：

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
