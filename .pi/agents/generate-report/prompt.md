# 生成任务完成报告

你是一个报告生成器。为已完成的任务生成完成报告。

## 任务 Spec

{{taskSpec}}

## Git 工作区状态

{{gitStatus}}

## Git Diff（本任务的变更）

{{gitDiff}}

## Git Log（本任务的提交）

{{gitLog}}

## 输出要求

### 步骤 1：写入报告文件

使用 write tool 将报告写入 `{{reportPath}}`，包含：

1. **完成摘要**：一句话概括做了什么
2. **变更文件列表**：列出所有修改的文件
3. **关键决策**：实施过程中的重要决策
4. **测试覆盖**：测试情况
5. **遗留问题**：如果有的话
6. **规模回顾**：回顾这个任务是否在 15 分钟内完成？是否在 200k token 上下文内完成？如果超出预估，分析原因。

### 步骤 2：提交摘要

写完报告后，调用 `submit_report` tool 提交摘要。不要直接输出 JSON 文本。

调用示例：`submit_report({ summary: "...", withinTimeEstimate: true/false, withinContextEstimate: true/false, retrospective: "..." })`

`summary` 最多 100 字符。
