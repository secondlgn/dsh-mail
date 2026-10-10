# dsh-mail

给一台机器上的 DSH 配一个**专属邮箱**作为会话入口：邮件即会话，回复即续接上下文，答复自动回信，长任务可被打断。

- **纯出站**：IMAP 轮询收信 + SMTP 发信。机器不需要公网 IP，不开放任何入站端口，没有回调地址。
- **准入靠白名单**：只认 `From` 精确地址，其余一律丢弃，连回执都不发。
- **回复判定双保险**：`In-Reply-To`/`References` 优先，主题里的 `[dsh-xxxx]` 标签兜底。
- **零运行时依赖**：IMAP/SMTP 客户端与 MIME 解析都是本包自己实现的，只用 Node 内置模块。

设计取舍与逐条决策记录见 [docs/design-spec.md](docs/design-spec.md)。

## 仓库结构

```
src/                    插件本体（Host 插件，ESM）
  index.js              插件入口：Config、withDefaults、apply
  imap.js               IMAP 客户端（literal、IDLE、APPEND、互斥）
  smtp.js               SMTP 客户端（多行应答、AUTH、点填充）
  mime.js               MIME 解析：RFC 2047/2231、引文剥离、HTML 转文本
  inbound.js            入站判定：白名单、循环抑制、线程归属、提示渲染
  outgoing.js           出站组装：主题标签、线程信头、MIME 与附件
  session.js            会话控制器适配（投递、打断、取结果）
  store.js              原子状态库（messages / threads / cursor）
test/                   全部离线测试（node:test）
tools/                  对真实邮箱的只读自检脚本
docs/design-spec.md     设计规格 v1
cordis.patch.yml        插件自带的 bundle 补丁（只含中性默认值）
```

## 状态

已实现并在离线仿真中验证：白名单准入、循环邮件抑制、新会话/续接判定、受理回执、结果回信、**同线程回复打断当前轮次**、附件落工作区、崩溃重放、Sent 文件夹回写。

未实现（按约定属于后续阶段）：基于 plan todo 的阶段汇报、权限清单与超范围询问。

## 安装

插件是标准的 DSH Host 插件包（ESM，导出 `name` / `inject` / `Config` / `apply`），同时是一个
**bundle**：它自带的 `cordis.patch.yml` 负责往 profile 里插入插件行。

### 从 GitHub 安装

```sh
git clone https://github.com/secondlgn/dsh-mail
```

然后在你的 profile 目录（`$DSH_HOME/profiles/<name>/`）里做两处改动：

```jsonc
// <profile>/package.json
{
  "dependencies": {
    // 二选一：指向本地克隆，或用 GitHub 源
    "dsh-mail": "file:C:/path/to/dsh-mail",
    // "dsh-mail": "github:secondlgn/dsh-mail"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-mail"]
    }
  }
}
```

```yaml
# <profile>/cordis.patch.yml
# 注意：这里【不能】写 name: 字段。带 name 的条目是「插入新行」的写法，而新行必须由
# bundle 提供；在 profile 补丁里带 name 会被当作未匹配条目静默忽略，插件永远不会加载。
# 这里只能按 id 覆盖配置。
- id: dsh-mail
  config:
    enabled: true
    imap:
      host: imap.example.com
      port: 993
      user: agent@example.com
      passwordEnv: DSH_MAIL_PASSWORD
    smtp:
      host: smtp.example.com
      port: 465
      user: agent@example.com
    allowFrom:
      - you@example.com
    workspaceDir: C:/work
```

`bundles` 里必须加上 `dsh-mail`，它自带的 `cordis.patch.yml` 才会被插入；那里面只有中性默认值
（`enabled: false`），真正的账号与白名单写在上面的 profile 补丁里。补丁会**整体替换**该行的
`config`，所以上面这份配置要写全，不能只写增量。

密码**不要写进配置**：用 `passwordEnv`（默认 `DSH_MAIL_PASSWORD`）指向环境变量。

`allowFrom` 为空时**任何人都无法驱动这台机器**——这是安全的默认值，不是 bug。

### 关于 workspaceDir

`workspaceDir` 决定邮箱会话的工作目录，**每台机器不同，不要照抄**。留空则用当前工作目录。
它必须是该机器上真实存在的绝对路径。

### 验证安装

重启 DSH 后，插件行应以 `include:dsh-mail` 出现且状态为 `active`。若没出现，按顺序检查：

1. `bundles` 里是否真的加了 `dsh-mail`；
2. profile 补丁里是否误写了 `name:`（见上面的警告）；
3. `package.json` 是否为合法 JSON。

### 网易邮箱（163/126/yeah）必读

网易对第三方客户端有额外要求，插件已经内置处理，但值得知道原因：

- **登录后必须先发 `ID` 命令**（RFC 2971）声明客户端身份，否则 `SELECT INBOX` 会直接返回
  `NO [Unsafe Login]`。插件在 `CAPABILITY` 里看到 `ID` 就自动发送。
- **Sent 文件夹名为 modified UTF-7**（163 上是 `&XfJT0ZAB-`，即「已发送」）。插件靠 RFC 6154 的
  `\Sent` 属性识别它，不依赖名字，所以不需要手工配置 `sentMailbox`。
- 首次接入建议先在邮箱设置里开启 **IMAP/SMTP 服务**，并使用**授权码**而不是登录密码。

参考配置（同样是**不带 `name:`** 的 id 覆盖）：

```yaml
- id: dsh-mail
  config:
    enabled: true
    imap:
      host: imap.163.com
      port: 993
      user: you@163.com
      passwordEnv: DSH_MAIL_PASSWORD
    smtp:
      host: smtp.163.com
      port: 465
      user: you@163.com
      passwordEnv: DSH_MAIL_PASSWORD
    allowFrom: [you@163.com]
```

### 上线前自检

仓库 `tools/` 里有两个只读检查脚本，在仓库根目录运行（都需要 `DSH_MAIL_PASSWORD` 可见）：

```sh
node tools/mail-probe.mjs     you@163.com   # 登录 + 能力 + Sent 文件夹识别
node tools/mail-rehearsal.mjs you@163.com   # 抓最新几封真实邮件跑一遍判定与解析
```

两者都**不发信、不写状态、不标记已读**，可以在启用插件前对着真实邮箱放心跑。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后插件不建立任何连接 |
| `imap.host` / `imap.user` | 必填 | IMAP 服务器与账号 |
| `imap.port` / `imap.secure` | `993` / `true` | 隐式 TLS |
| `imap.password` / `imap.passwordEnv` | `''` / `DSH_MAIL_PASSWORD` | 密码内联或环境变量名 |
| `imap.mailbox` | `INBOX` | 轮询的文件夹 |
| `imap.sentMailbox` | `''` | 留空则自动识别 `\Sent`，再按常见名称兜底 |
| `imap.pollIntervalMs` | `20000` | 轮询间隔；`IDLE` 可用时作为最长空闲时长 |
| `imap.idle` | `true` | 首选 `IDLE`，不可用时自动退回轮询 |
| `smtp.host` | 同 `imap.host` | 留空即复用 IMAP 主机 |
| `smtp.port` / `smtp.secure` | `465` / `true` | 提交端口 |
| `smtp.saveToSent` | `true` | 发信后回写 Sent 文件夹 |
| `allowFrom` | `[]` | 允许驱动 agent 的发件人地址（精确匹配） |
| `selfAddresses` | `[]` | 额外视为「自己」的地址，用于自环检测 |
| `fromName` | `DSH Agent` | 发信显示名 |
| `tagPrefix` | `[dsh-` | 主题标签前缀 |
| `workspaceDir` | `process.cwd()` | 新建会话的工作目录 |
| `stateDir` | `<DSH_HOME>/mail` | 插件状态目录 |
| `sendReceipt` | `true` | 受理后立即回执 |
| `sendResult` | `true` | 轮次结束后回结果 |
| `includeModePreamble` | `true` | 在提示里注入邮件排版要求 |
| `interruptSameThread` | `true` | 同线程回复打断正在跑的轮次 |
| `maxMessageBytes` | 32 MiB | 超过则丢弃 |
| `maxResultChars` | `60000` | 回信正文上限，超出截断并标注 |
| `attachments.enabled` | `true` | 是否落盘附件 |
| `attachments.maxBytes` / `maxCount` | 10 MiB / 10 | 单附件与数量上限 |
| `attachments.dir` | `<workspace>/.dsh-mail/attachments` | 附件根目录 |
| `recovery` | `rerun` | 崩溃恢复：`rerun` 重跑未完成的信，其他值标记失败 |

## 工作方式

### 会话判定

```
1. From 在白名单？              否 → 丢弃（不记录、不回信）
2. 自动回复 / 群发 / 邮件列表？ 是 → 丢弃
3. Message-ID 已处理完？        是 → 丢弃
4. In-Reply-To/References → 我方 Message-ID → 命中线程标签
   主题里的 [dsh-xxxx] → 命中线程标签
   都没有 → 新建会话（旧线程若断了，就是新会话）
```

### 打断语义（关键行为）

**只有回复属于「正在运行的那个会话」时才打断。** 别的会话的来信只排队，不打扰当前轮次。

打断的实现是「先投递、再取消」：把新内容以 `queue` 投进会话，然后 `cancel` 掉当前轮次，让队列里的新提示立刻接管。`steer` 可用时优先用它。

### 投递保证

**至少一次**。进程在「已投递」与「记为完成」之间崩溃时会重放——重复回答比漏信便宜。为控制代价，重放前先读 `state.json` 里记录的原会话与收件人，不会因为线程映射变化而走错会话；同一线程的同一段文本也不会重复发送。

### 回执与回信

| 邮件 | 时机 | 内容 |
|---|---|---|
| 受理回执 | 通过准入后立即 | `已收到（回执 xxxxxx），会话 [dsh-xxxx]，开始处理` |
| 结果回信 | 轮次结束 | 该轮的助手文本；未完成/被取消的轮次不发 |

回执的意义是让你**在第一封信里就拿到会话号**：之后就算客户端丢了 `References`，只要主题里的 `[dsh-xxxx]` 还在，就能续接。

`turn/end` 原因为 `interrupted` 或 `forked` 时不发结果，避免把被打断的半成品当成答复。

### 邮件模式提示

入站内容会包一层元信息送进模型，说明这是邮件而非对话框、只输出纯文本、控制行宽、不要提实现细节、不要复述提示本身，并附上发件人、主题、会话号、回执号。

## 状态文件

```
<stateDir>/
  messages.json   Message-ID → { 发件人, 主题, 正文, 会话, 线程标签, 回执号, 阶段, 时间 }
  threads.json    线程标签 ↔ 会话，以及我方发出的 Message-ID
  cursor.json     轮询水位（UID + UIDVALIDITY）
```

写入是原子的（临时文件 + fsync + rename），并按文件串行化。`UIDVALIDITY` 变化会重置 UID 水位，但消息身份始终由 Message-ID 决定，所以重置不会重放已完成的信。

## 开发

```sh
npm test                    # node --test，自动发现 test/*.test.mjs
npm run test:single-process # 沙箱下的退路：不用按文件子进程隔离
```

零依赖，`npm install` 不是必需的。用 DSH 自带的 Node 跑也一样（自带 TLS 与 `node:test`）：

```sh
"C:/Users/<you>/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" --test
```

默认的按文件子进程隔离在某些文件沙箱下会以 `EPERM` 失败，这时改用 `npm run test:single-process`
（把全部用例放进一个进程）。

测试全部离线：真实 TLS 连接（自签证书在进程内生成）对接脚本化的 IMAP/SMTP 服务器，加一个 Host 会话控制器桩。`DSH_MAIL_TEST_TRACE=1` 会打印插件自身的日志。

| 文件 | 覆盖 |
|---|---|
| `test/mime.test.mjs` | RFC 2047、GBK/UTF-8、引文剥离、HTML 转文本、附件识别 |
| `test/inbound.test.mjs` | 白名单、循环抑制、新会话/续接、重复与重放判定 |
| `test/store.test.mjs` | 原子写入、并发修改、水位语义、保留策略 |
| `test/imap.test.mjs` | 协议解析、literal（含多次写入与多 literal）、互斥、IDLE、APPEND |
| `test/smtp.test.mjs` | 多行应答、AUTH 三机制、DATA 点填充、MIME 组装 |
| `test/channel.test.mjs` | 端到端：准入 → 建会话 → 回执 → 结果、打断、附件、重放、Sent 回写 |

## 已知限制

- **不在 `IDLE` 时靠轮询**：`pollIntervalMs` 同时是 IDLE 的最长等待，最短 1 秒。
- **`IDLE` 期间无法发信**：`APPEND` 需要空闲连接，若正卡在 IDLE 会等一个 IDLE 周期。当前实现里发信前会复用空闲连接，最坏情况下 Sent 回写延迟一个周期。
- **配置 schema 无法离线校验**：DSH 用的 schemastery 是定制版，公共包解析不了它的 schema。因此 `Config` 的导入是容错的（Peer 不可解析时降级为空 schema），默认值另由 `withDefaults` 兜底，并由 `test/channel.test.mjs` 覆盖。
- **引文剥离是启发式**：识别 `>` 引用、`On ... wrote:`、`-----Original Message-----`、Outlook/中文头部块与签名分隔符。剥离后正文为空时会退回原文并标注。
- **附件不自动解压**：zip 原样落盘。
- **阶段汇报未实现**：原本约定的「plan 的 todo 即阶段」需要订阅 `todo_write` 结果，尚未做。
- **权限询问未实现**：超范围权限的邮件询问与超时默认拒绝尚未做；当前依赖 DSH 自身的审批通道。

## 安全边界

- 全部连接是**出站**的，不监听任何端口，没有回调地址。
- 准入只认 `From` 精确地址；`allowFrom` 为空时谁都不能驱动这台机器。
- 密码只从环境变量读（`passwordEnv`），配置与仓库里都不落明文。
- 状态目录（`<DSH_HOME>/mail`）保存的是**已剥离引文的正文**、Message-ID、线程映射和水位，用来
  排查「这封信为什么没回」；原始 MIME 报文不落盘，附件按配置落到工作区而不是状态目录。
- 崩溃恢复是「至少一次」，代价是可能重跑一封信；同一线程的同一段文本不会被重复发送。

## 许可

MIT，见 [LICENSE](LICENSE)。

