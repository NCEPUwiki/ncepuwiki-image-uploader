# NCEPUwiki 图片上传器

任何能登录页面的用户都可以选择图片/文件夹、提交上传或修改申请；**NCEPUwiki 组织的 owner 可以批准别人的申请，组织成员与 owner 自己的操作直接生效，其他人的改动要等 owner 批准后才真正执行**。批准后公开的图片链接可直接复制使用。

本工具只操作 R2 图片，**不会修改 wiki 仓库中的任何 Markdown 文件**。

## 主要文件

| 文件 | 作用 |
| --- | --- |
| `src/index.ts` | 上传器全部代码：页面 UI、申请/审批接口、SHA-256 去重、按文章编号分层存 R2、GitHub 组织角色判定 |
| `wrangler.toml` | Cloudflare Worker 配置：R2 桶绑定、`IMAGE_BASE_URL`、`REQUIRE_AUTH`、`GITHUB_ORG`、`ADMIN_EMAILS`（应急） |
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
- 上传、删除、移动、重命名都会先写入 R2 的 `_pending/` 隐藏前缀（该前缀不会出现在图片库列表里）：组织成员/owner 的改动随即执行并删除申请记录，其他人的改动留在待批准列表里
- 支持“新建文件夹”：目录名不再限于数字编号，字母、中文、空格与常见符号都可用（不能含 `/ \ : * ? " < > |` 等字符，也不能用 `_` 开头）；R2 本身不能存空目录，新建申请经 owner 批准后会写入隐藏占位文件，让空文件夹显示在列表中，可进入后继续上传图片
- 文件夹本身支持“打开 / 重命名 / 申请新建子文件夹 / 申请移动整个目录 / 申请删除整个目录”，目录内嵌套图片与占位文件会一起处理
- 移动图片或文件夹时，目标目录从 R2 里现有的存储目录逐级选择（可一路选到根目录），不再依赖 wiki 文章列表
- 多选移动合并成一条申请、一次提交：服务端先校验全部目标再统一移动，任何一张冲突都会整体回滚，不会出现“只移动了一部分”的中间状态；提交失败的原因直接显示在弹窗里
- 组织 owner 的“待批准”列表支持勾选、全选、一键批准/拒绝全部，以及批准/拒绝选中项
- 权限由 GitHub 组织身份决定：登录身份经 Cloudflare Access 验签后，通过 Access 的 get-identity 接口与 GitHub API 判定组织角色（owner / 成员 / 非成员），结果缓存 5 分钟；`ADMIN_EMAILS` 只是 GitHub 校验不可用时的应急通道
- 批准（或成员/owner 直接操作）后图片才真正写入最终路径；申请人的“我的申请”与 owner 的“待批准”列表都在同一页面

例：文章 `docs/03.计算机知识专题/08.踏入AI高阶之路.md` 上传的图片会存为
`https://img.ncepuinfo.cc/03/08/活动现场.jpg`（文件名为清洗后的原始文件名）。

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
4. `GITHUB_ORG`：GitHub 组织名（示例 `NCEPUwiki`），owner 审批权限与成员免审批都按这个组织判定。
5. `ADMIN_EMAILS`：应急 owner 名单，只在 GitHub 角色校验不可用时兜底（例如未配置 `GITHUB_TOKEN` 或接口故障）；不想保留兜底就留空。
6. `GITHUB_TOKEN`（Worker 密钥，不写进 `wrangler.toml`）：用于查询组织成员角色。细粒度 PAT 需要组织权限 `Members: Read`，或经典 PAT 勾选 `read:org`；令牌持有者必须是该组织成员。配置命令：`pnpm exec wrangler secret put GITHUB_TOKEN`。
7. `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`：Cloudflare Access 的团队域名与 Application Audience，用于校验登录 JWT 签名。AUD 可在 Zero Trust → Access → Applications 对应应用里找到（登录跳转 URL 的 `kid` 参数也是它）。`REQUIRE_AUTH = "true"` 时这两个值必须与 Access 应用一致，否则所有人都会被判为未登录。

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
2. 身份源选择 GitHub。注意：**登录策略不要限制成只有组织成员能登录**，否则外部用户进不来、也就无法提交申请；审批权限由 Worker 里的组织角色判定负责。
3. 将 `wrangler.toml` 中 `REQUIRE_AUTH` 改为 `"true"` 后重新部署。

### 权限模型（谁批准、谁免批）

- 任何能通过 Access 登录的人：都能浏览图片库，并提交上传 / 删除 / 移动 / 重命名 / 新建文件夹申请。
- **GitHub 组织成员**：自己的操作直接生效，不进入审批列表。
- **GitHub 组织 owner**：自己的操作直接生效，并且能在“待批准”里批准 / 拒绝其他人的申请。
- **其他人**：改动进入“待批准”，等 owner 处理。

角色判定流程：Access JWT 验签（见下）→ 用用户自己的 cookie 调 Access 的 `/cdn-cgi/access/get-identity` 取 GitHub 账号 → 经 GitHub API 解析登录名 → 查询组织成员关系（`role: admin` 即 owner）。判定结果按用户缓存 5 分钟，组织内角色变化最多 5 分钟后生效。

如果 GitHub 校验暂时不可用（未配置 `GITHUB_TOKEN`、令牌失效、接口异常等），相关用户会被当作“角色未确认”：其改动进入待批准，同时 `ADMIN_EMAILS` 里的邮箱暂以应急 owner 身份继续工作（他们的操作直接生效、可批准申请），避免系统停摆。排查用 `pnpm exec wrangler tail`，看 `[auth]` 开头的日志。

启用后，Worker 会要求请求携带 Cloudflare Access 签发的 JWT，并用 `ACCESS_TEAM_DOMAIN` 的公钥校验 RS256 签名、`iss`、`aud` 与有效期；只伪造 `CF-Access-Jwt-Assertion` 头无法再冒充 owner，未登录请求会被拒绝。校验失败原因会以 `[access] JWT 校验失败：…` 打到 Worker 日志里，可用 `pnpm exec wrangler tail` 排查。
