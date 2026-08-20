# dsh-instruction-queue 设计定稿 (2026-08-20)

**核心原则（最重要的一句）**：
> **Instruction Queue is persistent; execution runs are snapshots of it.**

**更大 thesis（2026-08-20 第五轮确认）**：
> **长期运行的 AI agent 需要一个独立于 conversation 和 model context 的
> collaborative planning state。**

用户意图会变化、模型不断发现新事实、世界状态会变化、执行可能失败或部分
成功、旧 evidence 失效、新 constraint 出现——conversation 不足以成为这些
的可靠表示，model-generated plan 也不足以。需要第三种东西：
**shared external work state**（人和 AI 一边做、一边一起维护"接下来到底
该做什么"）。这统一了本设计全部动机：ledger / provenance / approval /
reconciliation / evidence / residual 一开始看似对 prompt queue 过重，
实际是在设计**人和 agent 之间的共享工作状态**。

**认知同步 thesis（2026-08-20 第六轮确认）**：
> **AI 的执行速度正在超过人的理解、判断和重新形成意图的速度——
> collaborative planning layer 同时是"人类认知节流器"。**

```
Execution can run at machine speed.
Intent evolves at human speed.
The collaborative planning layer keeps them synchronized.
```

不是"故意把 AI 做慢"，而是**让 AI 高速执行，但建立一个低带宽、高语义密度、
用户始终拥有最终 authority 的 planning/control layer**，让人能随时重新同步、
纠偏、改变主意。关键设计推论：

- **Human Attention Boundary**：不是每个 task boundary 需要人介入；只有
  **semantic decision boundary**（新发现推翻假设 / architecture 变化 /
  constraint 冲突 / scope 扩大 / API 行为变化 / irreversible action /
  用户 decision 失效）需要同步人类。agent 可继续做与该 decision 无关的
  工作。这是"scope-expanding → PROPOSED"原则的推广。
- **渐进披露（progressive disclosure）**：planning plane 必须**按人的认知
  带宽输出，不是按执行速度输出**。顶层只显示 "Since you last checked:
  ✓3 completed ↻1 assumption changed !2 decisions need you"，点击才展开
  细节（Before/New evidence/Effect/Suggested change）。**绝不让 planning UI
  变成第二个日志窗口**。
- **human-on-the-loop 而非 human-in-the-loop**：agent 有自治范围；外部
  planning state 始终告诉人"现在目标 / 什么已改变 / 哪些是用户自己的决定 /
  哪些是模型建议 / 哪些是新发现 / 哪里超过授权 / 哪些问题必须用户重新判断"。
- **Resynchronization cost** 是设计目标：用户离开 40 分钟回来，十几秒内
  重新掌握状态并恢复控制（而非读长 summary + diff + chat history）。
  例：用户"处理 auth 模块，我去开会"→ 40 分钟回 → planning UI 显示
  Original goal / Completed / Your constraints held / Plan changes while away /
  Decisions waiting / Not executed pending decision——十几秒重新进入工作。

（attention debt / decision debt 量化指标、machine/planning/human 三速
抽象为 V3+ 概念，V1 不实现但 schema 留槽。）

**关键原则**：**Conversation becomes an input interface, not the database
of intent.** 现在多数 agent 把 conversation 同时当 UI/context/state/history/
plan 混在一起；本设计主动拆开——planning state 不等同于 chat history，
用户可直接维护计划（非永远通过 chat）。

不是"外置指令队列"（buffered multi-prompt execution），而是 **persistent
user-owned work queue for an active agent session**——一个由用户持续维护、
独立于 agent 内部 reasoning/plan 的外部工作队列。LLM 的 plan 是
agent-owned；Instruction Queue 是 **user-owned external intent state**。
当 agent 持续行动、用户持续思考、workspace 持续变化时，由它保存
"现在到底还需要做什么"。

**命名**：正式名 **Instruction Queue（指令队列）**，不使用 "plan mode"——
官方 `@deepseek-ai/dsh-plan-mode` 已占用 "plan mode"（模型出计划、用户批准，
Claude Code 同款）。本功能是用户侧持续意图状态，术语上用：
"7 instructions queued" / "Compile queue" / "5 tasks generated" /
"Approve queue" / "Executing task 2 of 5"，与官方 "Agent Plan awaiting
approval" 清晰区分。

**两平面抽象**：

```text
User-maintained Work Queue   ← 持续可写（Intent Plane）
          │
          │ compile / reconcile
          ▼
Approved Execution Graph     ← 当前正在执行的已批准快照（Execution Plane）
          │
          ▼
Main Agent
```

- **Intent Plane**：用户随时可以继续加、改、撤销、取代自己的意图
- **Execution Plane**：agent 当前真正获准执行的 obligation graph

**Collection 永远没有真正关闭**："开始"只是"从当前 Work Queue 创建一个
approved execution snapshot 并开始消费"；之后用户仍可继续往 Work Queue 写。

**架构**：`Queue → Compile → Approve → Execute → Reconcile → Complete`
（不是简单的 Buffer → Plan → Execute）。核心是 **append-only run ledger**：
计划可修订，但用户原始请求和已批准内容的历史永不销毁。

**Work Queue ≠ Run**：

```text
Workspace-level Intent Ledger
    ├── Run 17
    ├── Run 18
    └── future work (Inbox)
```

用户可选择 `Execute selected`，不必一次清空 Inbox——像一个轻量级 AI-native
issue tracker，输入成本低得多。

**产品差异化（2026-08-20 市场调研确认）**：prompt queue 已 commoditized
（Cursor/Zed/Windsurf/Codex/Claude 插件都有）；本功能不可重复的三差异：
1. **Compile before execute**——多段原始输入先形成 atomic obligations，非 FIFO 原样执行
2. **Approval preserves user intent**——dedupe/supersession/constraints/AC 在副作用前可见
3. **Reconcile after execute**——前一任务的真实结果改变后续 obligations
若这三条被削掉只剩"收几个 prompt 顺序发送"，则**不做**（已拥挤）。

**市场验证**：Codex issue #33835（queued messages 因果顺序丢失）、#24443
（usage limit 后 drain queue）、#9096（排队而非打断）证明本设计的
ledger/recovery/reconcile 不是过度工程——主流工具正在撞这些坑。

## 状态机

```
IDLE ── 无活动队列
  │ 用户启用 /iq on
  ▼
COLLECTING ── 输入进缓冲，不执行；dock 显示"已缓存 N 条"
  │ 用户断续、重复地输入，全缓存
  │ 用户发送"开始" / 点执行按钮
  ▼
COMPILING ── LLM 读缓冲 → 原子意图提取 → 去重/冲突分析
  → 依赖图 → 分组 → 排序 → 任务队列 JSON
  ▼
AWAITING_APPROVAL ── 用户审阅队列（approve / 只跑部分 / 调整 /
  处理冲突提示如"输入 7 取代输入 2"）
  ▼
READY ── 已批准队列存在
  ▼
EXECUTING ── 一个任务独占执行（主会话 agent）
  │ 每段执行完 → 捕获该段结果 → RECONCILING
  ▼
RECONCILING ── 判定结果 + 修订剩余任务图
  （覆盖判定：对照验收标准，非相似度）
  │ 所有 approved obligations 均进入 resolved resolution state → COMPLETING
  ▼
COMPLETING ── 最终校验（覆盖审计）+ 报告
  ▼
COMPLETED ── 所有已批准义务已解决；复位到 IDLE 或 COLLECTING
```

**COMPLETING 入口条件**（统一于 approved obligations，非"队列空"）：
- resolved：`satisfied | covered | skipped`
- unresolved：`open | partial | blocked` —— 存在任一即阻止完成
- `execution_status = failed / uncertain` 通常也阻止完成，除非对应义务后来
  通过别的 evidence 得到满足，或用户显式 skip（吻合 invariant #8）
- `proposed_expansion` 不进 completion denominator——它未批准，不构成义务

**其它状态**：
- `PAUSED`：显式停在段间/段内（用户插话等待确认）
- `BLOCKED`：需要用户/模型计划/工具解决（如队列任务触发官方 plan mode）
- `ABORTED`：用户终止运行
- `RECOVERY_REQUIRED`：进程死亡、执行状态不确定——最重要

## 数据模型（任务）

```jsonc
{
  "id": "T4",
  "approval_status": "not_required|proposed|approved|rejected",  // 义务判定依据
  "origin": "approved|residual|proposed_expansion",
  // 义务 = approval_status === "approved" 的任务（origin 不决定义务：
  // residual 虽 origin=residual 但授权来自原 approved obligation，无需再批准）
  "parent_task_id": null,               // residual lineage（T4.R1 的 parent = T4）
  "derived_from_criteria": [],          // residual 从哪些 AC 派生（防覆盖审计双计数）
  "source_input_ids": [2, 5, 8],        // provenance：映射回源消息
  "task": "...",
  "intent_type": "inspect|modify|decide|verify|explain",
  "targets": ["file/module/feature/question"],
  "execution_status": "pending|running|finished|failed|uncertain",
  "resolution_status": "open|satisfied|partial|covered|skipped|blocked",
  // attempt 状态与 task 执行状态分离：
  //   AttemptStatus = dispatched|running|finished|failed|cancelled|uncertain
  //   attempt A1 cancelled ≠ task T1 永久 cancelled → task 可重跑 A2
  "attempts": [{ "attempt_id": "A1", "status": "cancelled", "events": [...] }],
  "acceptance_criteria": [              // 必须，带 scoped ID
    { "id": "T4@rev1/AC1", "text": "..." },   // AC 稳定 identity，revision 后 evidence 不歧义
    { "id": "T4@rev1/AC2", "text": "..." }
  ],
  "side_effect_class": "read|write|external|irreversible",
  "hard_dependencies": ["T1"],          // B 真需要 A 的结果
  "soft_affinities": ["T3"],            // 同文件/同域，合并执行高效
  "evidence": [                         // 结构化：Summary 压缩上下文，Evidence 判定事实
    {
      "id": "E12",
      "type": "file_change",
      "path": "src/auth.ts",
      "observed_at": "2026-08-20T...",
      "authority": "tool|workspace|agent",   // agent 最弱，不可单独作覆盖依据
      "artifact_version": "git-blob-hash"     // freshness：npm test exit 0 只证明那个时刻
    },
    { "type": "command_result", "command": "npm test", "exit_code": 0, "ref": "..." },
    { "type": "agent_conclusion", "ref": "..." }
  ],
  "coverage": {
    "satisfied_by": ["T1", "T3"],       // 允许多源：T1 满足 AC1、T3 满足 AC2
    "criteria_met": [
      { "criterion_id": "T4@rev1/AC1", "evidence_refs": ["E12", "E19"] }
    ]
  },
  "revision": 2,                        // 当前修订
  "approved_task_revision": 1,          // 批准时锁定的修订（不可变边界）
  "approved_acceptance_criteria": [...], // 批准的对象是 task semantics（含 AC），非仅标题
  "status_history": []                  // 可派生，不持久化（见 §Ledger 唯一事实源）
}
```

**义务的稳定 primary key**：`run_id / task_id / approved_revision / criterion_id`
（如 `run17/T4@rev1/AC1`）——这是覆盖系统最稳定的身份。

**RawInput 因果上下文**（Codex #33835 实证：仅保存输入顺序不够）：

```jsonc
{
  "input_id": "IN8",
  "content": "改用 PostgreSQL",
  "queued_at": "2026-08-20T...",
  "queue_sequence": 8,
  "last_visible_event_id": "evt-42",  // 用户写此句时最多看到的 assistant 事件
  "session_id": "..."
}
```

`last_visible_event_id` 对 supersession 判断关键：
- `#2 用 SQLite` → agent 未动作 → `#7 用 Postgres` = supersession
- `#2 用 SQLite` → agent 输出"migration 已部署" → `#7 用 Postgres` = 语义不同（新需求）
IQ 专门收集"形成过程中的意图"，因果 provenance 比普通 message queue 更重要。

**Ledger 是唯一事实源**：`status_history` 不重复持久化——Ledger（events.ndjson）
→ reducer → RunState（projection）→ dock UI。任何插件进程内状态、dock 状态、
当前任务状态都必须能通过 ledger replay 重建（invariant #9）。

## 执行循环

```
EXECUTING（主会话 agent）
  │ 注入执行信封（每段自带，不依赖主会话记忆）：
  │   { task_id, 精确任务, acceptance_criteria,
  │     相关先前结果, 工件引用, 明确"不要推进其他队列任务" }
  ▼
  主 agent 执行 → 产生回复
  ▼
  RECONCILING
  │ 捕获该段结果 → 判定（对照验收标准）→ 修订剩余任务图
  │ （被覆盖？改写？residual？proposed expansion？）
  ▼
  注入下一段（每段前用户可插话 → PAUSED 等待确认）
```

### Reconcile 边界（scope 扩张必须批准）

- **Residual task**（原批准义务的剩余部分）：可自动进入剩余图。
  例：批准"更新 API + docs" → 结果"API 已更新、docs 未更新" →
  residual = "完成原任务中尚未满足的 docs 部分"。
- **Scope-expanding task**（新目标/优化/重构/清理，不属于批准 AC）：
  **必须 `PROPOSED → user approval → 才加入 executable queue`**。
  由字段 `origin: "approved|residual|proposed_expansion"` 区分。
  绝不：批准"修复 parser bug" → 执行后模型自动"顺带重构 AST framework 并新增三任务"。

### 修订不可变边界（批准后）

- **可自动改**：execution order、soft affinities、satisfied criteria、
  coverage evidence、residual obligations、status、dependency edges（有证据时）
- **不可自动改**：原始 task intent、用户批准的 scope、AC 的语义、
  side-effect permission、用户明确 constraint
- 批准修订是 `T4@rev2`；后续任何语义变化 → `T4@rev3 PROPOSED`，不静默覆盖 T4

### 防重复副作用（at-most-once 自动重试）

- `run_id / task_id / attempt_id` 三重复试 ID
- 事件台账：`TASK_DISPATCHED → AGENT_STARTED → SIDE_EFFECT_OBSERVED → TASK_RESULT_CAPTURED → TASK_COMMITTED`
- **exactly-once 做不到**（典型窗口：agent 对外发请求成功 → 进程挂 → SIDE_EFFECT_OBSERVED 未落盘）。
  正确表述：**对无法证明执行结果的非幂等 attempt，禁止自动重试**，
  进入 `uncertain / RECOVERY_REQUIRED`，由对账或用户显式决策解决——
  即 **automatic retry 的 at-most-once policy**，不是 execution 的 exactly-once
- 外部状态变更容忍：段间用户/其他进程手动改了文件 → 对账时假定运行触碰的工件可能过期，编码工作流中仓库实际状态优先于先前总结

### 暂停语义（用户插话）

- **Scheduling pause**（不再派发下一步）：一定能做到
- **Active attempt cancellation**（中止当前 agent/tool action）：不一定能保证
- UI 不应显示"已停止"，而应显示"正在停止；不会开始新的队列任务"；
  当前 attempt 依底层能力成为 `cancelled | finished | uncertain`
- 对 external / irreversible side effect 尤其重要

**上下文不依赖主会话**：会话可能被压缩/截断/分叉/恢复不完美；每段带执行信封即可恢复。

## 覆盖判定（核心修正）

**禁止**："任务 B 看起来像任务 A 的结论，因此 B 完成"（相似度推断）。
**必须**："A 的记录结果是否满足 B 的**每一个验收标准**？"

反例：T1"调查登录测试为何失败" vs T2"修复登录测试"——T1 完全解释问题但零进度修复 T2。

被覆盖的任务**保留不删除**（汇总标注"已覆盖：满足的验收标准清单"），用户可要求重跑。

**完成前覆盖审计**：对照所有已批准任务的验收标准独立审计，与增量修订分开。

## 编译管道（聚类/排序）

```
Raw inputs → atomic intents → dedupe/conflict → dependency graph
  → grouping → ordering
```

- **原子意图提取**：一条消息可能含 3 个任务，5 条消息可能描述 1 个任务——先拆原子意图
- **矛盾 ≠ 重复**："用 SQLite" 后 "改用 Postgres" 是**取代关系**，批准时明示"输入 7 取代输入 2"，不静默选 embedding 强的
- **硬依赖 vs 软亲和分开**：`depends_on` 只放硬依赖；软亲和单独
- **排序优先级**：硬依赖 → 安全/不可逆性 → 信息先于行动 → 用户显式顺序 → 上下文局部性 → 原始输入顺序（稳定 tie-breaker）
- **cycle / ambiguity 检测**：COMPILING 输出额外的
  `{ "conflicts": [], "dependency_cycles": [], "ambiguities": [] }`；
  **存在 unresolved hard-dependency cycle 时不能进入 READY**（执行器才发现无法拓扑排序就太晚了）

### "开始" 的触发语义

只有**独立 control utterance**（`开始` / `/iq start`）或明确 UI 操作才结束
collecting。用户输入"开始菜单的按钮文案改成 Start"或"先别开始实现，
继续想 API"**绝不能触发**——compiler input channel 和 queue control channel
在协议层区分，不靠字符串意图分类。

## 交互点（已确认）

1. **触发**：用户显式启用（/iq on 或 UI 开关）；输入进缓冲不执行
2. **结束采集**：用户发送"开始"或点执行按钮（发送即正式开始）
3. **整合结果是否进主上下文**：默认不进（队列存插件状态，逐段带执行信封）；用户可选进
4. **执行中插话**：暂停（PAUSED），先回用户插话，确认后继续。插话分类：control（停/改）/ modify current task / add queue item / out-of-band conversation——不明示的插话不自动并入剩余队列
5. **执行载体**：主会话 agent（同一上下文，总结天然回流）
6. **结束信号**：所有 approved obligations 均 resolved → 汇总 + 显式告知 + 复位 + 用户确认

## 持久化与恢复

- run ledger 持久化到磁盘（不存插件内存）：run ID / session ID / 原始缓冲输入 / 已批准队列版本 / 任务状态 / 活动 attempt / 结果记录 / 修订历史
- **schema 版本化**：插件升级时活跃队列不崩
- 恢复：`RECOVERY_REQUIRED` 时从会话/工具/文件事件对账，无法证明是否运行时**不静默重跑非幂等任务**

## 与官方 plan-mode 共存

- 队列执行中主模型调用官方 plan mode？**允许**，队列进入 `BLOCKED_ON_AGENT_PLAN`——**队列拥有外层循环，官方 plan mode 暂时让位**

## 复用现有机制

- 官方 `plan/mode` 会话事件（状态持久化、resume 恢复）——但本功能的事件独立命名（`iq/*`）
- `userQuestions` 通道（批准队列 / 确认继续）
- `agent/pre-step` + `inbox`（queue-merge 同款，输入缓冲和逐段注入）
- dock 插槽（队列展示、进度、结束信号）

## System Invariants（宪法）

1. **Raw user inputs are immutable.**
2. **Approved task semantics are immutable without user approval.**
3. **No non-idempotent uncertain attempt is automatically retried.**
4. **No scope-expanding task executes without approval.**
5. **A task is covered only when all approved acceptance criteria have evidence.**
6. **Agent summaries are context, not authoritative evidence.**
7. **Only one queue task may own execution at a time.**
8. **Completion is impossible while any approved obligation is open, partial,
   blocked, failed, or uncertain.**
9. **Derived state is reconstructible from the append-only ledger.** ——
   任何插件进程内状态、dock 状态、当前任务状态都必须能通过 durable ledger
   replay 重建。`RECOVERY_REQUIRED` 因此是架构自然结果，不是特殊补丁。

状态机即使重构，只要这些 invariant 不破，行为就不会跑偏。

## 协议层设计（五层文件）

```text
iq/types.ts       domain types（RunId/TaskId/AttemptId/CriterionId/EvidenceId,
                  QueuePhase, Task, Attempt, AcceptanceCriterion, Evidence, RunState）
iq/events.ts      只描述发生过的事实，不描述命令
iq/reducer.ts     reduce(state, event) -> state —— 纯函数，无 LLM/IO/工具
iq/recovery.ts    ledger + external evidence → reconciliation decision → new events
iq/invariants.ts  运行时断言（assertNoConcurrentTaskOwnership 等）
```

### 事件清单（iq/events.ts——事实，非命令）

```text
IQ_ENABLED / INPUT_BUFFERED / COMPILE_REQUESTED / QUEUE_COMPILED /
QUEUE_APPROVED / TASK_DISPATCHED / ATTEMPT_STARTED / SIDE_EFFECT_OBSERVED /
ATTEMPT_RESULT_CAPTURED / ATTEMPT_COMMITTED / TASK_CRITERION_SATISFIED /
TASK_COVERED / QUEUE_PAUSED / RECOVERY_REQUIRED / RUN_COMPLETED / RUN_ABORTED
```

注意：`START_TASK / RETRY_TASK / PAUSE_QUEUE` 是 command，**不混入 event**。

### Crash recovery matrix（优先于完整 reducer 写）

| 崩溃点 | 恢复判断 | 自动行为 |
|---|---|---|
| dispatch 前 | 未执行 | 可正常 dispatch |
| `TASK_DISPATCHED` 后、agent start 前 | 不确定是否开始 | reconcile |
| agent started、无副作用证据 | uncertain | reconcile |
| 已观察 read-only 结果 | 通常可安全重试/恢复 | policy 决定 |
| 已观察 write side effect | 不静默重试 | reconcile |
| external request 发出但无 receipt | uncertain | 禁止自动重试 |
| result captured、commit 前 | 可从 evidence 恢复 | commit/reconcile |
| committed 后、下一 task 前 | 已完成 | 继续下一任务 |
| completion report 后、COMPLETED event 前 | 重建 completion | 避免重复副作用，仅重发 UI 状态 |

若每一格都能只靠 `ledger + authoritative external state` 得到确定处理策略，
event model 即设计正确。

## 评审记录

- 2026-08-20（第一轮）：网页 ChatGPT 独立评审（7805 字符），全部采纳。
  改名 Instruction Queue、append-only run ledger + RECOVERY_REQUIRED、
  覆盖判定改验收标准满足、原子意图编译管道、矛盾≠重复、执行信封。
- 2026-08-20（第二轮）：GPT 评审（实现规格门槛，架构 9/10、语义 8/10、
  可编码 7.5/10），全部采纳。核心补丁：
  - 双状态枚举（execution_status / resolution_status）
  - 批准对象 = task semantics 含 AC（approved_task_revision /
    approved_acceptance_criteria 锁定）
  - Reconcile 边界：residual 自动进、scope-expanding 必须批准（origin 字段）
  - 修订不可变边界（可改/不可改清单；T4@revN 语义变化 → PROPOSED）
  - 结构化 evidence（Summary 压缩上下文，Evidence 判定事实；
    agent_conclusion 最弱不可单独作依据）
  - at-most-once 自动重试（明确 exactly-once 做不到）
  - 暂停语义分层（scheduling pause 必达 / active attempt cancellation 不保证）
  - cycle/ambiguity 检测（unresolved cycle 不进 READY）
  - "开始"为独立 control utterance（协议层区分，非字符串分类）
  - coverage 多源（satisfied_by 数组）+ AC 带 ID
  - **System Invariants 8 条**
- 2026-08-20（第三轮）：GPT 评审（可编码 9/10，冻结设计文档），全部采纳：
  - attempt/task 状态分层（AttemptStatus 含 cancelled；attempt cancelled ≠
    task 永久 cancelled）
  - COMPLETING 入口统一为 approved obligations 全 resolved
  - residual lineage（parent_task_id / derived_from_criteria，防覆盖审计双计数；
    最终审计永远针对 approved AC，residual 只是执行载体）
  - approval_status 与 origin 分离（义务 = approval_status === "approved"；
    proposed_expansion 不进 completion denominator）
  - AC scoped id（run_id/task_id/approved_revision/criterion_id 为稳定主键）
  - ledger 唯一事实源（status_history 派生不持久化；reducer 为 projection）
  - evidence 加 observed_at / authority / artifact_version（freshness）
  - **System Invariant #9（derived state 可从 ledger 重建）**
  - 五层文件结构 + 事件清单（事实非命令）+ crash recovery matrix

**架构定性**：不是"会调用 LLM 的队列插件"，而是 **event-sourced obligation
orchestrator**——LLM 只负责 compile/reconcile 中的语义判断，不拥有状态真相。

下一层：按五层文件实现 `iq/types.ts` + `iq/events.ts` + `iq/reducer.ts` +
`iq/recovery.ts` + `iq/invariants.ts`，先写 crash recovery matrix 验证事件协议。

## 执行中输入分类（一等能力，非仅 pause 逻辑）

执行中用户新输入进入 **live intake / pending delta**（不直接改当前执行图，
不"消失在聊天里"）。四类：

| 类别 | 例子 | 处理 |
|---|---|---|
| **A. Control** | "停一下" / "先跑 T4" / "T3 不要做了" | queue control，不经过 semantic compiler |
| **B. Constraint/correction** | "不要改 schema" / "改用 Postgres" / "public API 必须兼容" | **最高优先级**——可能使当前任务失效；`scheduling pause = true`，尝试 cancel attempt；attempt 返回后不得直接 `finished→satisfied`，须 reconcile（可能 `partial / invalidated` + residual = revert + 在新约束下重做） |
| **C. New obligation** | "再把 README 示例更新一下" | 不影响当前 task，进入 staged，下一次 reconcile 加入 graph |
| **D. Out-of-band** | "你刚才为什么选这个方案？" | agent 回答，不污染 Work Queue |

### 输入生命周期

```text
RAW INPUT → STAGED INTENT → PROPOSED DELTA → APPROVED OBLIGATION → EXECUTABLE
```

执行中新增（如"顺便整理日志"）：先 `I17 status=staged` → reconcile 时 compiler
发现 `+ T5 Clean up logging` → dock 显示 "1 new instruction received /
Proposed addition: ..." → 批准后才执行。这仍满足 invariant #4
（scope-expanding 必须批准）——只是来源是用户后续明确输入，非模型脑补。

### 三来源变化统一重算

Reconciliation Barrier（每 task 边界）：

```text
Execution
   ↓
RECONCILIATION BARRIER
   ├─ ingest agent outcome
   ├─ ingest new user instructions
   ├─ inspect workspace state
   ├─ invalidate stale evidence
   ├─ recompute remaining obligations
   ├─ surface required approvals
   └─ choose next task
```

reconcile 回答的不再只是"T1 覆盖 T2？"，而是"自上一个 execution snapshot
以来，世界发生了什么变化？"——变化来源：Agent actions / User intent changes /
External workspace changes，统一重算 remaining obligations。

### Active attempt 不动态改 prompt（immutable execution envelope）

T3 一旦 dispatch = `T3@rev2 / attempt A1`，执行信封固定。用户新输入**不偷偷
注入**正在运行的 context 改 A1 语义（否则无法回答"A1 在执行哪个 spec"）。
正确模式：新输入 → staged → A1 ends/cancels → reconcile A1 + staged inputs →
`T3@rev3` 或 residual。只有真正的用户 STOP/cancellation control 可异步影响
attempt 生命周期。这对 ledger/recovery 至关重要。

### Delta approval（不重审整个 plan）

执行中队列变化（T4 被新约束改 / T6 新增 / T5 不再需要）时，用户**只审批 delta**
——"✓ T3 completed / ↻ T4 changed by new constraint / + T6 added / ⊘ T5 no
longer necessary / [Review delta] [Continue]"——比"计划变了请重看 12 个任务"
好得多。

## Collaborative Planning Plane（人机共同编辑的 living artifact）

**计划是共享工件**：用户和模型都能向它贡献，但权限不同。

```text
USER  + 必须保持 public API compatibility
MODEL ? 建议先增加 characterization tests
USER  ✓ 接受
MODEL ! 发现 refresh-token path 依赖旧实现
SYSTEM ↻ T4 dependency updated
USER  - 不再需要 README migration section
```

模型可以：提议任务、报告发现、提议依赖变化、提议某 obligation 已满足、
提议修改计划。模型**不能**：静默扩大用户目标、静默改变用户 constraint、
把自己的建议直接变成用户 obligation。**最终 authority 属于用户。**

这解决"执行惯性"：规划状态和执行上下文混在同一 conversation 时，agent
会不断把新信息解释成继续方案 A 的理由。外部 planning plane 明确记录
constraint/decision/cancelled task 后，即使执行 agent 上下文被压缩，
下一次 execution envelope 仍会把当前真相重新约束进去——**不仅是 UX 优势，
也提升 agent 实际可靠性**。

### 模型向计划层写东西 = proposal semantics

```text
DISCOVERY: Token cache lacks per-user locking.
PROPOSAL P9: Introduce per-user cache lock.
AFFECTS: T2, T3
```

用户同时输入"尽量别加新的 locking dependency" → reconcile：
T2@rev2 PROPOSED（用现有 serialization 机制代替新依赖）→ 用户批准 →
execution plane 才收到新 T2。这才是真正的 human + AI co-evolving plan，
而非"AI 写计划，人点 OK"。

### 多节点类型（计划不全是 task）

```text
[C1] Constraint     Keep public API compatible
[O3] Observation    Legacy mobile client still uses refresh/v1
[D2] Decision       Retain refresh/v1 until mobile migration
[T4] Obligation     Fix refresh-token race
[P7] Proposal       Add compatibility test suite
[Q2] Open question  Can existing mutex abstraction be reused?
```

用户输入不全是"做 X"——"我觉得可能跟 Redis 有关""先记住别影响 mobile"
都应影响后续执行，却不立即成为 executable task。

### 计划 UI（不是 Todo List，是"我们现在共同认为这个工作是什么"）

```text
Goal          Stabilize authentication flow
Constraints   ● Preserve public API ● No new infra deps
Doing         ● T3 Fix refresh race
Next          ○ T4 Add regression tests ○ T5 Update migration docs
New           + User: Mobile still needs legacy refresh API
              + Agent: Existing serializer may solve race
Plan changes  ↻ T3 revision proposed ⊘ T6 no longer needed
Open questions ? Can legacy flow be deprecated next release?
```

用户可直接维护计划（+ Add instruction/constraint/task/note、drag reorder、
cancel、edit constraint、approve model proposal）——chat 是最快输入方式，
但 planning state 不等同于 chat history。

## 分阶段路线

- **V1**：执行前 collect → compile → approve → execute/reconcile（MVP，验证
  "是否愿意第二次开 /iq on"）。Instruction Queue 作为用户输入入口，内部
  数据模型已预留 collaborative plan 字段（节点类型、proposal 通道——V1 只存
  proposal 不执行）
- **V1.5**：执行中继续收集输入，进入 `Pending instructions`，task boundary 处理
- **V2**：constraint/correction classification、delta compile、plan invalidation
- **V3**：真正 persistent user work queue + **Collaborative Planning Plane
  全貌**——跨 run 存在、select-to-execute、长期 backlog、模型 proposal 双向
  流动、多节点类型、用户直接维护计划（drag/constraint/proposal approval）

**数据模型现在就把 Work Queue 和 Run 分开**（Workspace-level Intent Ledger →
Execution Runs → Attempts/Evidence），但 V1 不实现 V3 全功能。

## 评审记录（追加）

- 2026-08-20（第四轮）：GPT 提议将功能升级为 **persistent user-owned work
  queue**（两平面 Intent/Execution、collection 永不关闭、执行中输入四分类、
  Reconciliation Barrier、immutable attempt envelope、delta approval、
  Work Queue ≠ Run、分阶段 V1-V3），全部采纳并写入本文档。核心原则升级为
  "Instruction Queue is persistent; execution runs are snapshots of it"。
- 2026-08-20（第五轮）：GPT 提出更大 thesis——**长期 agent 需要独立于
  conversation 和 model context 的 collaborative planning state**
  （"Conversation becomes an input interface, not the database of intent"）。
  采纳：共享工作状态 thesis（统一全部设计动机）、Collaborative Planning
  Plane（人机共同编辑 living artifact，模型 proposal semantics 权限受限）、
  多节点类型（Obligation/Constraint/Decision/Question/Proposal/Observation/
  Hypothesis）、计划 UI 形态。**保留**：V1 不改名（Instruction Queue 仍描述
  入口；Collaborative Plan 是 V3 形态）——防 MVP 范围蔓延。
- 2026-08-20（第六轮）：GPT 回应"AI 执行太快人跟不上"——**认知同步 thesis**
  （planning layer 同时是"人类认知节流器"；Execution machine speed /
  Intent human speed / planning layer keeps them synchronized）。采纳：
  Human Attention Boundary（仅 semantic decision boundary 同步人类，
  scope-expanding→PROPOSED 的推广）、渐进披露（planning 按人认知带宽输出，
  绝不当第二个日志窗口）、human-on-the-loop（非 human-in-the-loop）、
  Resynchronization cost 设计目标。**推迟**：attention debt 量化、三速抽象
  （V3+，schema 留槽）。
