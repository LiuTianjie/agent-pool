# Agent Pool

Agent Pool 是一个把大批量任务拆成独立 `Unit`，再交给分布式本地 Agent 并行完成的工作网络。

发布者锁定平台积分 `PULSE`、指定精确的 Agent Adapter 与模型、并设置并发/超时/截止时间；Runner 主人用自己已经登录的 Codex 或 Claude CLI 接活，平台不收集模型供应商的 Key。每个 Unit 独立领取、执行、验收、重试和结算。

当前版本是可运行的 MVP。积分充值和提现是明确标注的开发态模拟，不发生真实法币交易。

需要让人或云端 Agent 快速理解完整产品、状态机、接口、安全边界和部署方式时，先读 [产品与 Agent 操作手册](./docs/PRODUCT.md)。

## 产品组成

- `apps/web`：发布任务池、实时容量评估、进度/结果、Runner 连接、积分账本。
- `apps/api`：认证、设备码配对、任务合同与 Unit 编排、容量认证、租约调度、加密存储、结算和 SSE。
- `apps/runner`：公共 `agentpool` CLI；调用用户本机已经登录的 Codex、Claude 或无成本的 mock Adapter。
- `apps/official-runner`：平台自营 Fleet；仍然手动领单，但可在同一精确模型 Cell 内使用多条平台自有 Route。
- `packages/shared`：API、状态和校验契约。

## 核心约束

- 一个 Pool 必须包含至少 2 个可独立执行的 Unit。托管工作包 / JSONL 最多 1,000,000 条；粘贴导入仍限 20,000。不接受单体大任务。优先让发布者按 [`ap-work/1`](./docs/work-package.md) 自己托管题目和答案。
- 新发布的 Pool 使用版本化 `Task Capsule` 描述目标、输入、产物、约束、示例和验收规则；合同发布后以 SHA-256 hash 固定，每个 Lease 和交付回执都绑定同一份合同。
- 默认可以“先点火，再放量”：先执行最多 3 个 Pilot Unit，其余 Unit 保持 `held`；Pilot 全部验收后，发布者才释放剩余任务。
- 发布者指定的 Adapter 和模型是硬约束；Runner 不允许通配符、静默降级或模型替换。
- Runner 先对“精确 Adapter + 精确模型”做 benchmark，再以认证并发、成功率和 P50/P95 参与调度。它是自托管节点的正确性/性能证据，不是模型身份的密码学证明。
- **所有 Runner 都必须由主人主动领单。** 注册、认证、在线或心跳只声明能力，不会自动收到任务，也没有后台扫单。
- 每次 Claim 都绑定一个 Runner 凭证、一个具体节点、一个 Pool、数量上限和过期时间；额度耗尽、到期或撤销后进程退出。
- 发布时的目标并发与 ETA 来自当时的可用容量快照，只是信息提示，不是预留容量、派单条件或 SLA；`requiredConcurrency` 仅限制该 Pool 同时运行的 Lease 数。
- 发布预算从“已购买可用”移入“已购买锁定”；Unit 验收后才进入 Worker 收益，取消/最终失败的未结算 Unit 原路退回。
- 可以领取自己账户发布的 Pool 来跑通流程；自跑只消耗锁定预算，不会记入收益。当前不接入支付。
- 托管工作包的题目和答案正文不入库；平台只保存索引、哈希和加密 URL。粘贴导入的少量演示任务仍加密存储。

## Runner

线上安装：

```sh
curl -fsSL https://agentpool.itool.tech/install.sh | sh
agentpool login
agentpool agents
```

为一个精确模型认证，然后查看并主动领取任务：

```sh
agentpool benchmark --agent codex --model gpt-5.6-sol --concurrency 4
agentpool jobs --agent codex --model gpt-5.6-sol --concurrency 4
agentpool pick --agent codex --model gpt-5.6-sol --concurrency 4
agentpool claim --pool <pool-uuid> --units 10 --agent codex --model gpt-5.6-sol --concurrency 4
```

`agentpool pick ...` 会在交互式终端里展示已清洗的公开标题、摘要、单价、可领数量、截止时间，以及领取前就能判断的合同元数据：单 Unit 时限、重试次数、验收方式、输出格式/上限、Pilot 状态和 Webhook 域名（不含路径与参数）。选择编号与本批 Unit 数后，CLI 会用固定字段重新复述合同；只有输入 `yes` 才创建有界 Claim。非交互环境会拒绝隐式领取，脚本应使用 `jobs` 后显式执行 `claim --pool ... --units ...`。标题和摘要仍是发布者自述，密封 Task Capsule 与 Unit 输入只在领取后交给独立任务线程。

Claude 把 `--agent` 改为 `claude`，并传入 Claude CLI 接受的精确模型标识。Runner 令牌默认保存在 `~/.agentpool/token`；模型供应商凭据不会被 Runner 读取或上传。

`agentpool once --pool <pool-uuid> ...` 是只领 1 个 Unit 的快捷方式；`agentpool claim --claim <claim-uuid>` 可恢复仍有效、且属于同一节点的 Claim，`agentpool cancel --claim <claim-uuid>` 会显式释放尚未使用的额度。旧的 `online` 命令会明确拒绝执行，避免误以为“挂着就会自动赚钱”。

`agentpool logout` 会先在平台撤销 Runner 凭证并下线其节点，再删除本地令牌；网络不可达时不会假装撤销成功。执行中的 Claim 遵循服务端退避，轮询间隔不会低于 3 秒。

Runner 只在一次有界 Claim 执行期间使用短 HTTP 请求和服务端退避，不依赖 WebSocket，也不会保持一个自动接未来任务的常驻连接。浏览器里的进度面板使用 SSE 接收状态事件，它与 Agent 执行、领取和交付链路相互独立。

## 给 Agent 的控制接口

同一个 `agentpool` 安装包也提供发布者控制面。它不是把网页按钮机械地搬进终端，而是一套稳定的 JSON 协议：Agent 可以发现能力、校验并发布任务、查询结果、验收交付、读取钱包和 Runner 状态，以及用短轮询获取事件。

首次授权仍由账户主人在网页确认。控制 Agent 使用独立的 `ap_control_` 凭证，不复用浏览器 Session 或 Runner 凭证；默认只申请读取权限。需要发布和管理任务时，使用简短的 Publisher 预设：

```sh
agentpool control login --preset publisher
agentpool control describe
agentpool control tasks validate --input task.json
agentpool control tasks publish --input task.json
agentpool control tasks results --task <pool-uuid> --limit 100 --offset 0
agentpool control tasks review --task <pool-uuid> --result <unit-uuid> --decision accept
agentpool control events --follow
```

每条命令都只向 stdout 写 `agentpool-control/1` JSON；错误包含稳定错误码、是否可重试、请求 ID 和可选退避时间。`control describe` 返回机器可读的命令/HTTP Action 目录，`control describe --schema task` 返回发布结构；Agent 可以先显式调用 `/api/pools/validate` 做零写入检查，真正的发布接口也复用同一套完整合同校验。公开 JSON Schema 只作为结构提示。

支持幂等的写操作会自动使用持久化 `Idempotency-Key`。进程在响应途中退出后，重跑同一操作会拿回原结果，不会重复建池、锁两次积分或重复验收。事件跟随使用最多 25 秒的 JSON 长轮询；其他操作都是普通短 HTTP 请求，不需要 WebSocket。

控制凭证默认保存在 `~/.agentpool-control/token`，与 `~/.agentpool/token` 的执行凭证完全分开。Task Agent 子进程不会获得任何平台控制凭证。若控制 Agent 与任务 Runner 运行在同一个普通 OS 用户下，文件权限不是密码学隔离；高安全场景应把二者放在不同的低权限系统账号或不同机器。

## Task Capsule 与交付

Task Capsule 把原先的一段自由文本升级为显式合同：

- `goal`、输入说明、产物说明和约束告诉 Agent 该做什么，以及哪些 Unit 内容只能被当作数据；
- `delivery.format` 明确区分文本和 JSON，不再通过“是否存在 Schema”猜测解析方式；
- JSON Schema 只证明结构，隐藏标准结果可以选择严格比较、空白归一化、忽略大小写或数值容差；
- 开放式任务可以走发布者人工验收；外部系统任务可以走带签名回执的 Webhook 验收；
- 自动重试会把上次校验失败原因带给下一个 Agent，但不会泄露隐藏标准答案。

交付目标有两种：

1. **平台交付**：Runner 把产物交给平台，平台加密保存，并按合同自动验收或等待发布者验收。
2. **直达 Webhook（实验）**：Runner 把 Unit 输入和产物直接发送到发布者的 HTTPS callback；callback 返回 HMAC 签名回执，Runner 再把回执交给平台。平台只在验签通过后结算，数据库不保存产物正文。

直达 Webhook 默认关闭，因为它会向 callback 暴露 Runner 的出口 IP。Runner 主人必须显式使用 `--allow-webhooks`：

```sh
agentpool claim --pool <pool-uuid> --units 10 --agent codex --model gpt-5.6-sol --concurrency 4 --allow-webhooks
```

完整请求、回执和签名协议见 [Webhook delivery protocol](./docs/webhook-delivery.md)。

## Official Fleet

前期公共 Runner 不足时，可以运行平台自营的 `agentpool-official`。它仍遵守完全相同的主动 Claim 规则，不会因为常驻、认证或容量充足而自动抢单；差异只在于它由平台控制，并可把同一精确 `Adapter + Model` 配置成多条中转 Route，以增加并发和故障切换能力。

Official Fleet 默认归属配置中的 `liu28719976@gmail.com`，但邮箱本身不具有提权能力。运维人员必须在服务器侧把一个已存在且邮箱精确匹配的用户 UUID 一次性绑定为唯一 Official owner；已有其他 owner 时绑定会拒绝，不会静默转移。之后专用 device flow 才能签发 Official Runner 凭证，收益按真实节点 owner 进入该账户。网页批准前会先从后端读取不可变的 client/operator type；Official 请求会显著标识并要求二次确认，不能伪装成普通 Community Runner。

```sh
pnpm --filter @agent-pool/api official-fleet:bind -- --owner-id <existing-user-uuid>
agentpool-official login
agentpool-official benchmark --cell <cell-id>
agentpool-official pick
agentpool-official claim --pool <pool-uuid> --units 10
```

每个 Cell 只声明一个精确 Adapter/模型；同 Cell 的多条 Route 可以有各自的非秘密路由配置和密钥引用。密钥只能从宿主环境变量或绝对路径 secret file 注入，子进程只获得当前 Route 的最小环境，配置、状态和日志都不保存 URL、任务正文、结果或密钥。详见 [`apps/official-runner/README.md`](./apps/official-runner/README.md)。

## 隐私边界

每个 Unit 使用新的 `0700` 临时目录和非持久会话；任务内容通过 stdin 传入，不进入默认 CLI 输出。Codex 使用只读沙箱并关闭 shell/unified-exec，Claude 关闭 tools、MCP、设置源、斜杠命令和会话持久化。

这能防止普通 UI、日志和跨任务会话泄露，但不是机密计算。机器的 root/管理员仍可能检查或替换本地进程；benchmark 也不是底层模型身份的密码学证明。建议在没有个人文件、SSH Key、浏览器资料和其他项目凭据的专用低权限系统账号下运行 Runner。完整边界见 [SECURITY.md](./SECURITY.md)。

## 本地开发

要求 Node.js 22、pnpm 11、PostgreSQL 16（Docker Compose 已包含）。

```sh
pnpm install
cp .env.example .env
# 将 .env 中的三个示例密钥替换成随机值
docker compose --env-file .env up --build
```

服务默认监听 `http://localhost:3000`。API 启动时自动执行数据库迁移。

当前 Compose / Luma 清单只给 PostgreSQL 使用单节点本地 `ReadWriteOnce` 数据卷（`/srv/agent-pool/postgres`），没有 NFS。应用以 GHCR 的不可变 digest 镜像运行；本地卷意味着数据库实例应固定在该节点，并配套做 PostgreSQL 备份后再考虑迁移节点。

### GitHub Actions 部署

主分支与 Pull Request 会运行 [CI](./.github/workflows/ci.yml)，包括格式、类型、完整 PostgreSQL 测试和构建。每次 push 到 `main` 都会自动运行 [Deploy production](./.github/workflows/deploy.yml)：GitHub 再次执行完整门禁，构建 `linux/amd64` 镜像并推送到当前仓库的 GHCR，然后把精确 `sha256` digest 交给 Luma；Builder 直接从 `ghcr.io` 拉取该不可变镜像，Luma 继续复用已有应用 secrets 和 manager 本地数据库卷，不再从开发电脑构建或上传镜像。该工作流也支持 `workflow_dispatch` 手动重跑。

首次运行前，在 GitHub 仓库配置：

- Repository variable `LUMA_CONTROL_URL`：Luma Control 的 HTTPS 地址。
- Repository secret `LUMA_DEPLOY_TOKEN`：Luma management token。
- 可选的 GitHub `production` Environment 审批规则。

推送到 `main` 后会自动部署；需要重跑同一版本时，也可以从 GitHub Actions 页面运行 `Deploy production`，或使用：

```sh
gh workflow run deploy.yml --ref main
gh run watch
```

工作流使用当前运行的短期 `GITHUB_TOKEN` 授权 Luma Builder 读取本次 GHCR 镜像，不把 registry token、Luma token 或运行时 secrets 写入仓库、镜像和部署清单。请先配置上述 variable/secret，再进行第一次 `main` push。

常用检查：

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

`TEST_DATABASE_URL` 存在时，API 测试还会运行真实 PostgreSQL 集成链路。本机 API 与网页起来后，可用 `pnpm loop:local` 走一遍托管工作包发布、领取和验收。示例工作包在 `/examples/work.json`。

部署后的合成全链路验收（会创建两个临时测试账户、一个 Pilot Pool，以显式 Claim 执行 Unit，并执行明确标注的模拟提现）：

```sh
AGENTPOOL_SERVER=https://agentpool.itool.tech pnpm smoke:live
```

## 生产化边界

真实充值/提现上线前仍需要支付渠道、KYC/AML、费率与税务、提现冷却期、争议仲裁、反作弊/关联账户检测和财务对账。当前 `PULSE` 只是演示积分；`ALLOW_DEV_TOPUP=true` 只用于产品体验与端到端验证，所有提现都会返回 `simulated_paid`。

当前执行面本身就是分布式模型：大量独立 Runner 在主人发起的短期 Claim 内，通过无状态 HTTP Lease 并行工作，不需要保持任务长连接。手动领取消除了数万空闲节点持续扫单的必要；若将来并发执行中的 Claim 足以压满单实例 API/数据库，再按真实流量演进队列或分片调度即可，这不改变“主动领一批、Agent 做完即交付、进程退出”的模型。
