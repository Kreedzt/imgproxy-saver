# imgproxy-saver

基于 Fastify 的 imgproxy 社区版持久化中间层：永久保存原图和处理结果。相同请求读取本地结果；新尺寸复用本地原图，因此首次保存成功后不再依赖原图站点。

```text
客户端 → saver → 已保存结果 → 返回
              → 原图存储 → imgproxy Docker → 保存结果 → 返回
```

## 本地开发与回归

需要 Node.js 24，Docker 用于真实图片端到端测试。

```sh
npm ci
npm run check
npm run test:e2e
```

`check` 执行类型检查、全部单元/集成测试和生产构建。`test:e2e` 构建 saver 镜像，启动隔离的原图、imgproxy 和 saver 容器，验收后删除测试容器、网络和临时数据。固定使用 imgproxy v3.29.1，详见 [CHECKPOINTS.md](CHECKPOINTS.md)。本地集成测试需要绑定回环 HTTP 端口。

开发启动：先按下节准备 `.env`，另设 `IMGPROXY_URL` 指向可访问的 imgproxy，并将同一原图目录挂载给它，再执行：

```sh
node --env-file=.env --import tsx src/server.ts
```

## Docker Compose 部署

1. 创建配置与持久化目录：

   ```sh
   cp .env.example .env
   mkdir -p data/originals data/variants
   ```

2. 使用 `openssl rand -hex 32` 分别生成四个值，填入 `.env` 的 `EXTERNAL_KEY`、`EXTERNAL_SALT`、`INTERNAL_KEY`、`INTERNAL_SALT`。已有 imgproxy 客户端可将原有 key/salt 作为 external 值。
3. 将 `SOURCE_ALLOWED_HOSTS` 改为允许下载的准确主机名，以逗号分隔；重定向目标也必须列出。不支持 `*` 通配符。默认禁止私网地址，测试或可信内网源可显式设置 `ALLOW_PRIVATE_SOURCES=true`。
4. 确保 data 可由容器 UID/GID 1000 写入。Linux 上可对新建的专用 data 目录运行 `sudo chown -R 1000:1000 data`；不要对其他目录套用此命令。
5. 启动：

   ```sh
   docker compose up -d --build
   curl http://127.0.0.1:3000/healthz
   ```

默认仅绑定宿主机 `127.0.0.1:3000`，可接入已有 HTTPS 反向代理；需要其他监听地址时配置 `BIND_ADDRESS`。只对外开放 saver，imgproxy 留在 Docker 内部网络。`/healthz` 表示 saver 存活，imgproxy 不可用时已有文件仍能返回，新结果生成会明确失败并可重试。

`data` 是持久化业务数据，不能清理。应用不会自动淘汰旧文件；磁盘不足返回 507（STORAGE_FULL），需要扩容。

## 生成图片地址

处理参数沿用 imgproxy 路径形式。推荐将完整原图 URL 编码为 URL-safe Base64：

```sh
node --env-file=.env --import tsx scripts/sign.ts \
  'https://images.example.com/photo.jpg?token=abc&version=1' \
  'rs:fit:300:200/q:80' webp
```

命令输出已签名路径，将它拼接到 `http://127.0.0.1:3000` 即可访问。不要将生产密钥传给浏览器，URL 应由可信后端生成。

- 首次：`X-Storage-Status: MISS`，原图与结果完整落盘后开始返回。
- 后续相同请求：`X-Storage-Status: HIT`，不再访问 imgproxy。
- 新尺寸或格式：新增结果，复用已保存原图。
- 文件流返回，不把整张图片放进 Node.js 内存。

**查询字符串的区别：** imgproxy 3.29.1 在验证签名与处理前忽略请求外层 `?x=1`。原图的查询参数必须放进 Base64 源地址，或对 plain 源正确百分号编码，例如 `plain/https%3A%2F%2Fexample.com%2Fa.jpg%3Ftoken%3Dabc@webp`。中间层也按此规则解析；外层查询串仍进入结果键，因此会产生独立结果，但不会改变图片处理。先前“查询参数透传”的讨论不能理解成 imgproxy 支持任意外层处理参数。

自动格式协商依赖 `Accept`：该头会透传并进入结果键，返回 `Vary: Accept`。同一 URL 的不同 Accept 值可能分别保存，例如缺省 Accept 与 `*/*`；这是避免错误共享格式的保守设计。

## 兼容范围

已实现：plain、分段 Base64、默认 `:` 参数分隔符、常用社区版缩放/裁剪/质量/格式/旋转/滤镜参数、GET/HEAD、ETag/If-None-Match、完整文件返回。支持的选项以 `src/protocol.ts` 的显式列表为准。文件下载模式的 `filename/fn`、`return_attachment/att` 会保留 imgproxy 的 Content-Disposition；未指定文件名时 imgproxy 看到本地源名 `body`，若需要原始文件名请显式传 `fn`。

限制：

- 单 saver 进程、单副本、本地文件系统；禁止两个 saver 共用同一 DATA_DIR。初始化会清理未发布的 tmp 目录。
- 外部源只支持无需额外认证头的 HTTP(S)。拒绝带 Authorization/Cookie 的客户端请求；私有源后续单独设计。
- 不支持 SVG/XML、加密源 URL、预设、水印、Pro 选项、S3 源、自定义分隔符、路径前缀、URL 替换和 Base64 追加文件名模式。未知或不支持的选项返回 400。
- 签名使用 SHA-256 完整 32 字节及单个 key/salt 对；不支持截短签名、trusted signatures、轮换密钥列表。应用默认验证签名；`ALLOW_INSECURE=true` 接受 `/insecure/...` 和旧机器人使用的 `/sig/...`，其他无效签名仍被拒绝。迁移时需在 saver 容器环境变量中显式设置此项（Compose 部署时添加到 `saver.environment`）；关闭后两种免签链接都会被拒绝，包括本地缓存命中。
- 兼容机器人原有 `/sig/size:200:200/resizing_type:fit/<Base64URL>` 路径，无需改动生成代码。源 URL 解码后的原始空格会转为 `%20`；已有百分号编码和查询参数顺序保持不变，签名仍验证原始请求路径。原图及重定向目标仍须配置 `SOURCE_ALLOWED_HOSTS`。要保持客户端服务地址不变，可让 saver 接管旧端口；部署时必须使用包含此兼容修改的新 saver 镜像。
- `expires/exp` 在本地命中之前和返回之前都检查；首版拒绝小于等于当前秒的时间戳（比 imgproxy 原生的 0 值和边界行为更严格）。有有效期的 URL 使用 `Cache-Control: no-cache`。
- 不转发 Client Hints；首版不要在 imgproxy 启用 Client Hints。Range 被忽略，返回完整 200，不存储 206。
- 原图下载不采用上游的 Cache-Control/Expires 淘汰策略；同一源 URL 永远绑定首次成功保存的原图。HTTP 200 且可识别的二进制图片才保存；实际解码由 imgproxy 完成，解码失败可保留原图供排查。

## 接入现有 imgproxy Docker

可以保留原有镜像部署，但须匹配本项目验证的版本与默认协议配置，并做以下配置：

```text
IMGPROXY_KEY=<与 saver INTERNAL_KEY 一致>
IMGPROXY_SALT=<与 saver INTERNAL_SALT 一致>
IMGPROXY_LOCAL_FILESYSTEM_ROOT=/sources
IMGPROXY_ALLOWED_SOURCES=local:///
```

将 saver 的 `data/originals` 只读挂载到 imgproxy `/sources`，让两个容器加入同一 Docker 网络。saver 的 `IMGPROXY_URL` 指向 imgproxy 内部地址。禁用 fallback 图、预设、水印、URL 替换、Base URL、Client Hints 等未验证功能；否则不能保证永久结果与请求对应。升级到其他 imgproxy 版本前运行兼容和端到端回归。

客户端外部签名首先由 saver 验证，然后 saver 将源地址改为 `local:///.../body`，用 INTERNAL 密钥重新签名。因此命中已保存图片也不会绕过签名验证，撤销 EXTERNAL 密钥后旧签名立即失效（客户端自己缓存的响应除外）。

## 存储、更新与恢复

```text
data/
  originals/<前两位>/<原图URL的SHA256>/body + meta.json
  variants/<前两位>/<请求及Accept等的SHA256>/body + meta.json
  tmp/                    # 未发布文件，可在停机时清理
```

对象目录包含 body 和 meta.json。写完、同步后原子发布，下载失败不会暴露半个文件。元数据保留字节数、内容摘要、内容类型与原图关联，不保存源站令牌 URL。没有数据库。

更新规则：

- 原图内容需要更新：使用新的源 URL，例如将版本号放入原图 URL，再编码并签名。
- 修改 imgproxy 镜像或默认处理配置：递增 `PROCESSING_VERSION` 后重建 saver，生成新结果并保留旧文件。
- 同一原图 URL 的临时令牌变更也会生成不同原图键；服务不会擅自去除鉴权参数。
- 首版没有删除和刷新接口，完整历史文件需要人工管理。不要只删除 meta.json 或 body 的一部分。

备份时停掉 saver（或使用一致性文件系统快照），备份整个 data 目录和单独妥善保存的配置密钥：

```sh
docker compose stop saver
tar -czf imgproxy-data-backup.tar.gz data
docker compose start saver
```

恢复时停止 saver，将备份恢复到空的 data 目录、恢复 UID/GID 1000 的写权限，再启动。保留相同的 EXTERNAL 密钥、PROCESSING_VERSION 和请求头，才能命中原来的结果键。数据没有自动过期不等于磁盘不会损坏，应将备份放在独立存储。

## 运维与错误

默认日志只打印启动状态，不输出带令牌 URL。HTTP 错误响应包含稳定错误码，不泄露原始上游响应。需要访问日志时在入口代理中对源 URL、查询参数和签名做脱敏。

| 状态 | 含义 |
|---|---|
| 400 | URL/参数不支持或请求携带私有认证头 |
| 403 | 签名无效、URL 过期或源地址被禁止 |
| 413 / 415 | 文件过大 / 无法识别的二进制图片 |
| 422 | imgproxy 拒绝处理参数或图片 |
| 502 / 504 | 原图或处理请求失败 / 超时 |
| 503 | 并发等待队列已满 |
| 507 | 磁盘不足，已保存图片不会自动删除 |
| 500 STORAGE_CORRUPT | 已发布对象元数据或文件长度损坏，需要从备份恢复 |

文件摘要用于 ETag，命中时校验元数据与文件长度；首版不逐次重新哈希整个文件。数据盘需由服务独占管理，不应允许非可信用户写入。

## 发布镜像到 Docker Hub

[release.yml](.github/workflows/release.yml) 参考 [robin-server 的发布流程](https://github.com/rwr-infra/robin-server/blob/master/.github/workflows/release.yml)，在 GitHub Release **发布（published）**后运行；仅推送 Git tag 不触发发布。流程先复用完整回归工作流，通过后构建并推送 `linux/amd64` 和 `linux/arm64` 镜像。

在仓库 Settings → Secrets and variables → Actions 配置：

| 类型 | 名称 | 用途 |
|---|---|---|
| Secret | `DOCKERHUB_USERNAME` | Docker Hub 登录用户名 |
| Secret | `DOCKERHUB_TOKEN` | 对目标镜像仓库具有写权限的访问令牌 |
| Variable（可选） | `DOCKERHUB_IMAGE` | 完整镜像名，如 `my-org/imgproxy-saver`；默认 `<DOCKERHUB_USERNAME>/imgproxy-saver` |

在 Docker Hub 准备对应仓库，然后在 GitHub 发布如 `v0.1.0` 的 Release。镜像标签保留 Release tag 原样：

- 正式版：`<image>:v0.1.0` 和 `<image>:latest`。
- 预发布版：仅 `<image>:v0.2.0-rc.1`，不更新 `latest`。

`latest` 指最近一次执行的正式发布；不要将它理解为自动比较出的最高语义版本。Release tag 必须符合 Docker tag 语法。工作流内置 Buildx 缓存；正式发布需要 GitHub 和 Docker Hub 凭据环境，本地验收不会推送镜像。
