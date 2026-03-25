# 自循环任务系统设计

## 概述

一个状态驱动的自循环任务系统，通过 pi extension + prompt 注入协作，实现从目标输入到任务拆分、实施、验证、完成的全自动闭环。

## 架构

### 两层协作

- **Extension 层** — 读取 `task.json` 状态，在 `agent_end` 时根据当前阶段注入对应 prompt，执行硬编码检查，派发 subagent
- **LLM 层** — 执行头脑风暴、实施任务、反思等需要推理的环节

### 状态驱动

一切行为由 `task.json` 的当前状态决定。中断后重启，extension 读取状态，注入对应 prompt，从断点继续。

## 触发入口

用户在 `agent-loop.txt` 写入目标 → extension 检测到 → 创建 `task.json` → 进入头脑风暴流程。

## task.json 结构

```jsonc
{
  "goal": "用户的原始目标",
  "status": "brainstorming" | "planning" | "executing" | "completed",
  "currentTaskId": "003",
  "tasks": [
    {
      "id": "001",
      "title": "任务简介",
      "status": "done",
      "summary": "完成报告摘要"
    },
    {
      "id": "003",
      "title": "任务简介",
      "status": "preparing",
      "summary": null
    },
    {
      "id": "004",
      "title": "任务简介",
      "status": "pending",
      "summary": null
    }
  ]
}
```

- 顶层 `status`：整体阶段（brainstorming → planning → executing → completed）
- `tasks[].status`：单个任务阶段（pending → preparing → ready → in_progress → verifying → done）
- `pending` 任务只有 title，没有 spec 文件
- `done` 任务有 summary，存关键摘要供后续任务参考

## 任务状态流转

```
pending → preparing → ready → in_progress → verifying → done
                                    ↑            |
                                    └── failed ──┘
```

- **pending** — 只有简介，还没展开
- **preparing** — 正在生成任务 spec（subagent）
- **ready** — spec 已生成，确认可在 15min/200k 完成
- **in_progress** — 主 agent 正在实施
- **verifying** — 硬编码检查 + LLM 反思质量
- **done** — 完成报告已生成

如果 preparing 阶段发现任务太大，不进入 ready，而是拆分后替换为新的 pending 任务。

## 完整流程

```
agent-loop.txt 写入目标
    ↓
Extension 检测到目标，创建 task.json (status: brainstorming)
    ↓
注入 prompt → 主 agent 头脑风暴 → 用户交互 → 生成 .pi/task/spec.md
    ↓
Extension 检测到 spec.md 写入，更新 status: planning
    ↓
注入 prompt → subagent 生成任务计划 → 写入 task.json 的 tasks 数组
    ↓
Extension 更新 status: executing, currentTaskId: "001"

┌─ 任务循环 ─────────────────────────────────────────────┐
│                                                         │
│  tasks[current].status: pending → preparing             │
│  注入 prompt → subagent 生成 .pi/task/001/spec.md       │
│       ↓                                                 │
│  subagent 反思：15min/200k 能完成？                      │
│  → 不能：拆分，替换 tasks 数组，重新 preparing           │
│  → 能：status → ready → in_progress                     │
│       ↓                                                 │
│  注入 prompt → 主 agent 实施任务                         │
│       ↓                                                 │
│  status → verifying                                     │
│  Extension 执行硬编码检查 (lint/typecheck/test 100%)     │
│  → 失败：status → in_progress，注入错误信息              │
│       ↓                                                 │
│  subagent 反思质量                                       │
│  → 不通过：status → in_progress，注入反馈                │
│       ↓                                                 │
│  subagent 生成完成报告 (读 git 工作区)                   │
│  写入 .pi/task/001/report.md                            │
│  status → done, summary 写入 task.json                  │
│       ↓                                                 │
│  subagent 任务间隙分析：需要插入中间任务？                │
│  → 需要：插入新 pending 任务到 tasks 数组                │
│  → 不需要：currentTaskId 前进到下一个                    │
│       ↓                                                 │
│  还有 pending 任务？→ 继续循环                           │
│  没有了 → 主 agent 最终验收 vs spec.md                   │
│  → 不满足：追加任务，继续循环                            │
│  → 满足：status → completed                             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## 执行方式划分

| 环节                             | 执行方式           | 理由                           |
| -------------------------------- | ------------------ | ------------------------------ |
| 头脑风暴/细化需求                | 主 agent           | 需要和用户交互                 |
| 生成 spec doc                    | 主 agent           | 需要用户确认                   |
| 生成任务计划 JSON                | subagent           | 输入是 spec，输出是 JSON       |
| 任务预备：生成任务 spec          | subagent           | 输入是任务简介+总 spec         |
| 反思是否可在 15min/200k 完成     | subagent           | 输入是任务 spec，输出是 yes/no |
| 实施任务                         | 主 agent           | 需要完整工具链和上下文         |
| 硬编码检查 (lint/typecheck/test) | extension 直接执行 | 不需要 LLM                     |
| LLM 反思完成质量                 | subagent           | 输入是任务 spec + git 状态     |
| 生成完成报告                     | subagent           | 读取 git 工作区内容            |
| 任务间隙分析                     | subagent           | 输入是已完成报告+下一任务+spec |
| 最终验收                         | 主 agent           | 可能需要用户参与               |

## Subagent prompt 注入策略

每个 subagent 收到的 prompt 包含：

- 总目标 spec（读 `.pi/task/spec.md`）
- 当前 task.json 状态
- 当前任务的 spec（如果有）
- 已完成任务的 summary（从 task.json 读取，不读完整报告）
- 具体指令（生成 spec / 反思 / 生成报告 / 间隙分析）

## 硬编码质量要求

- `pnpm fmt` — 格式化
- `pnpm lint:fix` — lint 修复
- `pnpm typecheck` — 类型检查
- `pnpm test` — 测试通过，整个项目 100% 覆盖率

## 文件结构

```
.pi/
├── task.json
├── task/
│   ├── spec.md              # 总目标 spec
│   ├── 001/
│   │   ├── spec.md
│   │   └── report.md
│   ├── 002/
│   │   ├── spec.md
│   │   └── report.md
│   └── ...
├── extensions/
│   ├── task-loop.ts         # 核心：状态驱动的任务循环
│   ├── auto-lint.ts         # 硬编码检查
│   └── agent-loop.ts        # 保留，作为初始触发入口
├── prompts/
│   ├── brainstorm.md
│   ├── plan.md
│   ├── prepare-task.md
│   ├── reflect-size.md
│   ├── verify-quality.md
│   ├── generate-report.md
│   └── gap-analysis.md
├── package.json
└── tsconfig.json
```

## 扁平任务列表

任务始终串行执行。拆分任务时，直接替换为平级任务插入到列表中，不保留父子关系。
