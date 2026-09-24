# ainovel-cli

面向人工创作、外部模型和脚本的**无模型小说基础工具 CLI**。它负责保存设定与章节、组织上下文、维护进度与事实台账、执行确定性校验；不内置创作模型，不会根据一句话需求自动生成小说。

日常项目命令不需要 API Key、Provider、模型配置或网络连接。创作内容与文学判断由你或外部调用者提供，CLI 只执行显式请求的操作。

## 架构与职责边界

旧架构由 Host / Engine 按状态路由，调度 Architect、Writer、Editor 创作代理，并按需调用 Arbiter 做语义裁定；这些角色经由工具读写文件系统 Store。确定性的存储与状态操作本来就位于工具层，自动规划、写作和审阅则依赖上层模型运行时。

现在默认执行路径是：

```text
人工 / 外部模型 / 脚本
        │ 提供 JSON 参数、正文、摘要与审阅结论
        ▼
CLI → 确定性工具 → 文件系统 Store
        │
        └─ 返回原始工具 JSON，由调用者决定下一步
```

默认入口不启动 bootstrap、Host、Agents 或 LLM，也不自动续写、重试创作或派发下一位作者。旧运行时包和相关源码仍保留在仓库中，但不在默认可执行程序路径上；这不表示相关源码或模块依赖已被删除。工具描述及历史设计文档中出现的 Agent、Writer、Editor 等角色，在此接口下由外部调用者承担。

## 安装与构建

构建当前源码需要 Go 1.25.5 或更高版本。在仓库根目录运行：

```bash
go build -o ainovel-cli ./cmd/ainovel-cli
./ainovel-cli --help
```

也可以安装已发布版本：

```bash
# Go 安装
go install github.com/voocel/ainovel-cli/cmd/ainovel-cli@latest

# macOS / Linux 安装脚本，无需本地 Go
curl -fsSL https://raw.githubusercontent.com/voocel/ainovel-cli/main/scripts/install.sh | sh

# 查看版本 / 更新发布版本
ainovel-cli --version
ainovel-cli update
```

Windows 或手动安装请前往 [Releases](https://github.com/voocel/ainovel-cli/releases/latest)。安装脚本使用同一 Release 的 SHA256 清单校验安装包。安装和更新需要网络；已发布版本可能早于此接口变更，以该版本的 `--help` 为准，体验当前接口请构建当前源码。

## 命令接口

```text
ainovel-cli --help
ainovel-cli init --dir PATH
ainovel-cli status --dir PATH
ainovel-cli tools
ainovel-cli schema NAME
ainovel-cli call NAME --dir PATH [--input FILE|-]
```

- 无参数或 `--help`：打印帮助，不进入交互界面。
- `init`：显式初始化项目。目标须不存在或为空（锁文件 `.ainovel.lock` 除外），不会覆盖已有作品。
- `status`：输出项目状态 JSON，不推进创作。
- `tools`：输出所有可用工具的 JSON 描述，无需项目目录。
- `schema NAME`：输出该工具的 JSON Schema，无需项目目录。参数名称、必填项和枚举值以它及工具描述为准。
- `call`：执行一个工具。输入为一个 JSON 参数对象；省略 `--input` 或使用 `--input -` 时从 stdin 读取，也可从指定文件读取。

`call` 成功时把工具原始 JSON 结果写入 stdout，不添加模型解说或包装层；错误写入 stderr，并以非零状态退出。结果中的 `remaining`、`foundation_ready`、`review_required` 等是事实，不代表 CLI 已经自动补齐或执行后续步骤。

`--dir` **直接指向 Store 根目录**，其中保存 `chapters/`、`drafts/`、`meta/` 等数据，不会再自动拼接 `output/novel/`。不同目录就是不同作品。`status` 和 `call` 不隐式创建项目，也不执行旧数据迁移；需要已初始化且符合当前 v3 格式的 Store。对 v3 格式的旧作品，应传入实际 Store 目录而非旧启动目录。

项目访问使用 Store 根目录中的 `.ainovel.lock`，与旧 Host 的锁约定一致。不要删除正在使用的锁文件或绕过锁并发修改作品。

## 快速开始：保存作品信息与故事前提

下面的内容由调用者提供，不是 CLI 生成的。示例只完成作品信息和前提保存，尚不足以进入章节写作。

```bash
ainovel-cli init --dir ./my-novel
ainovel-cli status --dir ./my-novel

# 先发现工具并查看参数结构
ainovel-cli tools
ainovel-cli schema save_book
ainovel-cli schema save_foundation

# 默认从 stdin 读取 JSON：title 和 synopsis 均为必填字符串
ainovel-cli call save_book --dir ./my-novel <<'JSON'
{
  "title": "长夜将明",
  "synopsis": "太阳消失后的第七年，守灯人林舟收到一封来自黎明的信。为查明信件的来处，他必须离开最后一座亮着灯的城。"
}
JSON

# premise 的 content 必须是 Markdown 字符串，而不是 JSON 对象
ainovel-cli call save_foundation --dir ./my-novel --input - <<'JSON'
{
  "type": "premise",
  "scale": "short",
  "content": "# 故事前提\n\n永夜中的守灯人林舟踏上寻找黎明的旅程。维系城市的灯火与城外的秘密产生冲突，他必须决定如何保护同行者。"
}
JSON

# 查询当前状态和仍缺少的设定
printf '%s\n' '{}' | ainovel-cli call novel_context --dir ./my-novel
ainovel-cli status --dir ./my-novel
```

文件输入等价。例如将下面的 JSON 保存为 `book.json`：

```json
{
  "title": "长夜将明",
  "synopsis": "太阳消失后的第七年，守灯人林舟收到一封来自黎明的信。为查明信件的来处，他必须离开最后一座亮着灯的城。"
}
```

```bash
ainovel-cli call save_book --dir ./my-novel --input book.json
```

`save_foundation` 的 `scale` 可选 `short`、`mid`、`long`；其他设定类型的 `content` 可为相应 JSON 数组或对象。不要把前提示例当成大纲、角色或世界规则的输入格式，先查 schema 和工具描述，再提供对应内容。

## 基础工具分类

完整清单始终以 `ainovel-cli tools` 为准，每个工具均可通过 `ainovel-cli schema NAME` 查询参数。

| 类别 | 工具 | 调用者提供 / 工具执行 |
| --- | --- | --- |
| 上下文与回读 | `novel_context`、`read_chapter` | 读取进度、设定、分层摘要、角色与伏笔等上下文，以及终稿、草稿或对话片段 |
| 作品与设定 | `save_book`、`save_foundation` | 保存调用者提供的书名、简介、前提、大纲、角色、世界规则与终局方向；支持追加卷和显式完结 |
| 设定审查 | `audit_foundation` | 保存调用者的跨文件语义审查结论，核验基础设定完备性及内容指纹 |
| 章节写作 | `plan_chapter`、`draft_chapter`、`edit_chapter` | 保存章节构思、写入正文，或在允许的返工状态下精确替换草稿片段；不生成文本 |
| 检查与提交 | `check_consistency`、`commit_chapter` | 返回草稿及对照事实、记录检查步骤；提交草稿并更新时间线、伏笔、关系、角色状态及进度 |
| 审阅与摘要 | `save_review`、`save_arc_summary`、`save_volume_summary` | 保存外部提供的审阅结论、弧/卷摘要、角色快照和规则，按既有条件更新状态 |
| 规划修订 | `expand_next_arc`、`revise_outline`、`resolve_outline_feedback` | 保存下一弧的详细规划、修订未发生的大纲，或记录调用者确认无需修改的反馈结论 |
| 完本返工 | `reopen_book` | 把已完结作品中指定的已完成章节加入返工队列；不会自动重写，也不用于扩展篇幅 |

## 人工或外部模型如何推进写作

1. 用 `novel_context` 读取状态，按缺项提供书名、前提、大纲、角色、世界规则等；长篇还需相应分层规划和终局方向。
2. 重新读取已落盘设定并进行语义审查，再用最新的 `foundation_memory.foundation_status.fingerprint` 调用 `audit_foundation` 保存结论。仅有 JSON 结构完整不等于设定已经自洽。
3. 按当前状态逐章调用 `plan_chapter` → `draft_chapter` → `check_consistency` → `commit_chapter`。正文、章摘要、事实变更等均由调用者按 schema 提供。
4. 在弧/卷边界或出现反馈时，由调用者阅读作品、决定接受还是返工，提供审阅和摘要，并按需修订后续规划。CLI 不调度这些步骤。

**确定性检查不是文学判断。** `check_consistency` 主要加载已写草稿与世界规则、伏笔、关系、别名、最近摘要等对照材料，并记录检查 checkpoint；它不会调用模型判断情节是否合理，也不会给出自动文学评分。`audit_foundation`、`save_review` 等接收的是调用者作出的结论，工具只核验可机械判定的条件并落盘。

保留工具及 Store 内的确定性约束：写作阶段准入、章节顺序、大纲范围、草稿存在性、已完成章节保护、返工队列、阶段与流程迁移等不会因改成 CLI 而放宽。旧 Agent 的调度与停止守卫不在新入口运行，外部调用者负责按上述流程完成审查和检查，不能把“提交成功”当成已完成文学审阅的证明。提交中的内容规则检查也不能替代对人物、叙事、节奏和文风的审读。遇到前置条件错误，应读取状态并完成要求的步骤，而不是直接改进度文件。

数据和 checkpoint 会持久化，但重新运行命令不会自动恢复一个创作代理或继续生成。外部调用者需依据已保存状态选择下一次工具调用。

## License

[Apache License 2.0](LICENSE)。
