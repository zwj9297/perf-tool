# perf-tool 技术方案

## 0. 文档目的

记录已确定的设计决策及其**理由（含被否方案）**、由决策派生的关键设计、以及尚未定稿的待定项。

被否方案一并记录，是为了避免日后有人重新提议时缺少当时的上下文——尤其是那些"看起来更简单"的方案，它们被否掉的原因往往不显然。

本文档与 `CLAUDE.md` 的分工：`CLAUDE.md` 是给开发者的操作指引（命令、模块划分、硬性约束），本文档是设计推理过程。两者冲突时以本文档为准，并回改 `CLAUDE.md`。

---

## 1. 已确定的决策

### D1：`Plan` 只表达意图，改动在执行前统一预览

**决策**：`Plan` 描述"优化什么、为什么、涉及哪些文件"，不包含具体改动。`perf run` 开始时先生成全部 step 的改动，统一预览给用户确认，再逐个应用并逐 step 提交。

**理由**：

- 前一步的改动会改变后一步该改什么。一次生成全部改动，等于要求模型在没看到自己尚未产生的中间结果的前提下预测后续改动——它做不到。
- 审阅者是人的时候，审"这一步把线性查找换成 Map 是否合理"是有判断力的动作；审 50 行 diff 里的括号是否配对不是。
- 每个 step 独立生成，失败可以隔离在单个 step 内，不需要丢弃整个计划。

**被否方案**：

- **完整改动型 Plan**（Plan 直接含全部 patch，Execute 只做机械应用）：执行确定性和可重放性最好，但模型要在看不到中间结果的前提下产出所有后续改动，step 之间容易互相踩；且 plan 文件会长到人读不动，审阅价值反而下降。
- **纯逐步生成不预览**（`run` 直接逐 step 生成并应用）：最省事，但用户在第一次改动落盘前看不到全貌，"先看看它想干什么"这个核心卖点没了。

### D2：改动用 unified diff 表达，**按上下文定位而非按行号**

**决策**：模型输出 unified diff。应用时忽略 `@@ -a,b +c,d @@` 里的行号，按 hunk 正文中的「上下文行 + 删除行」序列在目标内容中定位。

**理由**：

- 改动是在**预测态**下生成、之后才应用的，所以位置无关性是**必需**而非优化。针对预测态算出的行号在延迟应用时必然错位，而且无法独立验证。
- 按上下文定位后，**一个 hunk 与一段 search-replace 同构**——"找到这段上下文+删除行，换成这段上下文+新增行"。因此唯一性校验、生成/落盘跑两遍同一函数等设计全部适用，只是表示形式更标准、人更熟悉。
- 相比 search-replace，diff 是标准格式，预览可读性更好，也便于导出成用户能自己 `git apply` 的 patch。

**被否方案**：

- **整文件重写**：overlay 实现最直接，模型最不容易写错格式。但大文件 token 消耗高，且模型可能静默丢掉与本次优化无关的代码——这是最难发现的一类损坏。同一文件被多个 step 触及时，后者会整体覆盖前者的成果。
- **search-replace + 唯一锚点**：技术与本方案等价，失败模式也相同。仅因表示形式不如 diff 通用而未选。

**实现要求**（不是建议，均已由 §2.6 的实验证实必要性）：

1. **必须自己实现 recount，在 `parsePatch()` 之前跑。** jsdiff **不做** `git apply --recount` 的事——`@@` 计数与正文不符时它直接抛异常（计数写大报 "contained invalid line"，写小报 "has more lines than expected"）。而模型写错计数是常态，所以这一层规范化必须我们自己做。
2. **必须自己实现唯一性预检。** jsdiff 没有任何严格模式：hunk 能匹配多处时**静默作用于第一个匹配**，不报错、无信号，且 `fuzzFactor` / `compareLine` 都改变不了这个行为。重复代码里这是静默改错行的直接路径，0 上下文 hunk 时尤其危险。
3. **容忍缺失的尾部上下文**（配合第 1 条的 recount），**但拒绝定位不唯一的 hunk**。定位歧义与 schema 校验失败是同一类问题，**共用 `plan/` 的同一个重试机制**：带着更多上下文重新生成那个 hunk。
4. **失败处理必须同时覆盖两种形态**：语法/计数错误**抛异常**，上下文不匹配**返回 `false`**。二者不是同一条路径，调用方都要接住。
5. **必须断言应用结果 `!==` 输入。** 0 个 hunk 的 patch 会让 `applyPatch` 原样返回源文本而不报错，"什么都没改"因此与"应用成功"无法区分。少了这条断言，一个 step 会被记为成功、产出一个空 commit，而计划声称优化已落地。
6. **多文件段的 patch 不能用 `applyPatch` 直接应用（会抛异常），必须按文件拆开。** 一个 step 触及多个文件时会产生这种 patch。

### D3：`Plan` 阶段给模型只读工具，循环有界

**决策**：`plan` 阶段不是一次性组装上下文，而是给模型 `read_file` / `grep` / `glob` / `list_dir` 等**只读**工具，允许它自主探索，但有轮数上限。

**理由**：性能定位大量依赖**反向查询**——"谁在调用这个热点函数"、"这个数组的数据量级从哪来"。这在一次性组装的静态文件集里答不出来，而它恰恰是静态分析最大的失效来源（会优化"看起来慢"的而非"确实慢"的）。

**代价**（明确接受）：

- 同一仓库跑两次会得到不同的探索路径和不同计划。落盘 plan 与 trace 可事后追溯，但**生成过程本身不可复现**。
- plan 从"一次调用"变成"一个循环"，成本上限需要显式管理。
- 模型可能瞎逛，浪费轮数（见 §4.2 的重复调用检测）。

**被否方案**：

- **一次性组装上下文，无工具**：成本确定、极易测试与复现。代价是选错文件就彻底没救，模型只能基于看到的片段猜。
- **预取为主 + 少量工具兜底**：常见情况不耗轮数。但预取策略与工具循环的交互容易出微妙 bug，两条路径都要实现和测试。

---

## 2. 由决策派生的设计

### 2.1 改动应用是一个纯函数

```ts
applyEdit(content: string, edit: Edit): Result<string, ApplyError>
```

生成阶段（对内存快照）和应用阶段（对磁盘真实内容）跑的是**同一个函数、同一套校验**。因此：

- 锚点校验自动跑了两遍。
- 落盘时定位失败，即意味着 overlay 与磁盘发生了偏离——这正是我们想要的硬失败信号。
- 附带成本比看上去小：不需要维护两套逻辑。

### 2.2 生成期用 overlay 预测态

生成 step N 的改动时，step 1..N-1 的改动尚未落盘。若每次生成都读磁盘原始内容，触及同一文件的多个 step 会基于互相矛盾的状态生成。

解法：`plan`/`run` 的生成阶段维护一个内存快照（overlay：`Map<path, content>`），顺序生成、逐层叠加。生成 step N 时模型看到的是叠加了前 N-1 步的快照。

应用阶段按同样顺序落盘，所以 overlay 的预测会成真。**但前提是磁盘未被外部改动**——因此生成前后必须校验工作区状态未变。

### 2.3 预览展示「原始 → 最终」的合并 diff

预览**不展示 N 个顺序 diff**，而是展示 `diff(原始状态, 最终 overlay 状态)` 的**按文件合并 diff**。

理由：

- 审阅者关心的是终态（"这个文件最后变成什么样"），不是中间过程。
- 合并 diff 是对**真实基线**算的，所以可以导出成一份用户自己能 `git apply` 的 patch——这给了不想让工具碰代码的人一条退路。
- 顺序 diff 不能拼接成 patch：后面的 hunk 是针对前面已应用的中间态算的。

想看每步增量用 `--by-step`。

### 2.4 不做 cherry-pick

`run` 只有「全部接受」和「中止」两个出口，不支持跳过某几步。

**原因是一个真实的陷阱**：假设用户保留 step 1 和 3、跳过 step 2。但 step 3 的改动是在"包含 step 2"的快照上生成的。跳掉 step 2 后，step 3 的定位可能失效（硬失败，尚可接受）；而若它**恰好**仍能应用（改动区域不重叠），用户得到的是一份谁都没审过的组合状态——**这比失败更糟**。

想少改哪一步，去编辑 `.perf/plan.json` 再跑。这个能力本来就有，因为 plan 从一开始就设计成人工可编辑的契约。用编辑 plan 实现选择性，比在 `run` 里加选择逻辑更干净。

真正的 cherry-pick（选中后对下游重新生成）留作后续增强。

### 2.5 工具循环属于 `plan/`，`providers/` 只是适配层

循环写在 `plan/`，`providers/` 只负责"一个回合"。这条分层的实际价值是：**循环可以只靠脚本化的假 provider 测完**，不需要连任何真实 SDK。

**注意**：`providers/` 是**适配层，不是抽象层**。底层（pi-ai）已经提供了跨 provider 的抽象，我们不再自建第二层抽象——自建第二层的结果是同一份契约被定义两遍，两份定义迟早漂移。`providers/` 的职责仅有三项：配置 → Models 集合的构造、认证预检、把 pi-ai 的 API 收敛到一个文件里。

### 2.6 diff 引擎选型（已实验验证）

用 `diff`（jsdiff，实测 v9.0.0）做解析与应用：`parsePatch()` / `applyPatch()`，另可用 `reversePatch()` 做反向应用。**但它的默认行为不足以保证 D2 的正确性，缺口必须由我们补上。**

下表每条结论都固化成了测试：`tests/diff/jsdiff-behavior.test.ts`。**`diff` 升级后若任何一条行为变了，那里会直接失败**——而不是等到线上静默改错行。

| 问题                                                                                                                 | 实测行为                                  | 对我们意味着什么                    |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------- |
| `@@` 起始行号被改成乱数（计数正确）                                                                                  | **按上下文定位，正常应用**                | ✅ D2 的核心假设成立                |
| `@@` 计数写大 / 写小                                                                                                 | **抛异常**                                | ❌ 必须自己 recount                 |
| 先自己做 recount 再应用                                                                                              | **正常应用**                              | ✅ 缺口可补                         |
| hunk 能匹配多处                                                                                                      | **静默作用于第一个匹配**                  | ❌ 必须自己做唯一性预检             |
| `fuzzFactor` / `compareLine` 能否改变歧义行为                                                                        | **不能，全部静默改第一处**                | ❌ 没有严格模式可用                 |
| 上下文有空白差异 + `fuzzFactor: 2`                                                                                   | **仍然失败**                              | ❌ 不能指望 fuzz 容忍不精确的上下文 |
| 上下文完全不存在                                                                                                     | **返回 `false`**（不抛异常）              | 失败是布尔值，须显式检查            |
| 0 上下文 hunk 在唯一位置                                                                                             | 成功                                      | —                                   |
| 0 上下文 hunk 在重复位置                                                                                             | **静默改第一处**                          | ⚠️ 低上下文 hunk 最危险             |
| `parsePatch` 遇 `@@ 1,1 1,1 @@`（缺 +/- 段）                                                                         | 宽容，正常解析                            | header 层面可以放心                 |
| 遇无 `---`/`+++` 头、计数非数字                                                                                      | 宽容，正常解析                            | 同上                                |
| 遇行首缺 `+`/`-`/空格 前缀                                                                                           | **抛异常**                                | body 层面严格，只能重试             |
| 遇 `@@` 后无正文                                                                                                     | **抛异常**                                | 同上                                |
| patch 里 0 个 hunk（如 `@@` 前有前导空格）                                                                           | **解析成功，`applyPatch` 原样返回源文本** | ❌❌ 最危险：无操作伪装成成功       |
| 多文件段的 patch 直接 apply                                                                                          | **抛异常**                                | 必须先按文件拆开再应用              |
| markdown 围栏 / 前后散文 / CRLF / `\ No newline` / 省略 `,1` / `@@ ... @@ f()` 后缀 / `diff --git` / 裸路径 / `-0,0` | **全部宽容，正常应用**                    | ✅ 不必为它们写代码                 |

**三点直接影响了设计**：

- **最危险的不是抛错，是"成功地什么都没做"。** 当 patch 里一个 hunk 都没有时，`applyPatch` 返回的是**源文本本身**，不是 `false`。于是"应用成功"与"一个字符都没改"在返回值上无法区分。对应到本工具就是一个 step 被记为成功、产出一个空 commit、而计划声称优化已落地。**因此应用层必须断言 `result !== input`**，把它当作失败处理（见 D2 实现要求第 5 条）。

- **`fuzzFactor` 不能依赖。** 这意味着模型的上下文行必须精确匹配，而 LLM 生成的上下文经常有细微空白差异。所以"定位失败 → 带更多上下文重试"这条路径会被**频繁**触发，它不是异常分支而是常规路径。重试机制要按常规路径的标准做，不能当兜底。
- **解析器是两层严格度**：header 宽容（可以放心把 LLM 的 `@@` 头交给它），body 严格（缺前缀字符就抛错）。所以我们自己的规范化只该修 header 的计数，不该试图修复 body——body 有问题就重试。

**一个容易踩的陷阱**：`parsePatch()` 返回的 hunk 上，`oldLines` / `newLines` 是**计数（数字）**，不是行数组；行内容在 `lines` 里（带 `+`/`-`/空格 前缀）。做唯一性预检时要从 `lines` 里筛出前缀为 ` ` 或 `-` 的项拼出「旧侧序列」，别去读 `oldLines`。

**唯一性预检的做法**：取 hunk 的旧侧序列（`lines` 中前缀为 ` ` 或 `-` 的项），在目标内容的行数组里滑窗统计完全匹配的次数。命中恰好 1 次才允许应用；0 次是定位失败，≥2 次是歧义——两者都走重试，不应用。

### 2.7 规范化只修结构，且是两轮而非一轮

实现于 `src/diff/normalize.ts`，样本测试在 `tests/diff/normalize.test.ts`（39 个用例）。

**两轮策略**，不是一个"全能修复器"：

1. **先直接交给 jsdiff。** 它的 header 层宽容度很高——实测 markdown 围栏、前后散文、CRLF、`\ No newline at end of file`、省略 `,1`、`@@ ... @@ function foo()` 后缀、`diff --git` 风格头、裸路径、`-0,0` 全部能正常解析并应用。为这些写修复代码是白写，还会与 jsdiff 自身行为产生冲突。测试里有一组用例专门断言这些输入**原样透传**——若哪天有人"顺手"给它们加了修复，断言会失败。
2. **只在第 1 轮抛错时才修复**，且只修 `@@` 头、计数、空 hunk 这三类**写法唯一**的结构问题。内容层面（行前缀缺失、正文与声明不符）一律拒绝，交给重试。

**判定原则：拿不准时宁可少一条上下文行，绝不多一条。** 少上下文只会降低命中率（响亮失败），多一条幽灵行则凭空改变旧侧序列、可能匹配到错误位置。

**一个已经踩过的坑**（写在这里因为它极易重犯）：`text.split(/\r?\n/)` 对以换行结尾的文本会产生一个末尾空串。若在收集 hunk 正文时**无条件**把空行补成"丢了前缀的空上下文行"，就会给每个 hunk 的旧侧序列尾部加上一条幽灵行，导致定位**必然**失败。所以空行转换必须以「后面还有本 hunk 的正文」为前提。修复前的症状是所有修复过的 hunk 都定位失败，而报错信息（`false`）完全不指向真正原因。

**`normalizePatch` 的成功结果连解析结果一起返回**（`files`，成功契约是 `hunkCount >= 1` 且至少有一个非空 hunk）。这样 `apply.ts` 不必重复解析，也不必写"规范化成功了但重新解析失败"的防御分支——那种分支在本契约下不可达，既无法测试、又会误导后来的人以为它们有用。

### 2.8 失败原因的分类决定了调用方该怎么处置

`applyPatchToContent` 返回 `ApplyResult`，失败时带一个 `reason`。分类的唯一目的是让调用方知道该怎么办——**其中两类是常规路径，其余重试同一个输入不会有不同结果**：

| reason                | 含义                                 | 处置                                                 |
| --------------------- | ------------------------------------ | ---------------------------------------------------- |
| `not-found`           | 旧侧序列在目标中找不到               | **带更多上下文重新生成**（常规路径）                 |
| `ambiguous`           | 命中 ≥2 处，无法确定改哪一处         | **带更多上下文重新生成**（常规路径）                 |
| `normalize-failed`    | 结构坏了且修不好（含行首缺前缀字符） | 重新生成整个 hunk                                    |
| `parse-failed`        | jsdiff 抛错                          | 重新生成整个 hunk                                    |
| `multi-file`          | 一个 patch 含多个文件段              | 调用方先用 `splitByFile` 拆开——不是重试能解决的      |
| `unsupported-file-op` | 表达新建 / 删除文件                  | 当前不支持，**不该重试**；跳过该 step 或明确报给用户 |
| `unchanged`           | 应用了但内容没变                     | 视为失败，不得产生 commit                            |
| `no-hunks`            | 成功契约被破坏                       | 契约出问题的信号，不该发生                           |

**`not-found` / `ambiguous` 是常规路径，不是异常分支。** 因为 `fuzzFactor` 不可依赖（§2.6），模型的上下文行必须逐字匹配，而 LLM 输出常有细微空白差异。重试机制要按常规路径的标准做：能匿名重试、记录重试次数、想清楚重试也失败时如何降级。

**不支持新建 / 删除文件。** 本工具的任务是优化已有代码，不是重构文件结构。但模型会产出这类 patch（典型如"把这段逻辑抽成新文件"）。检测**必须放在唯一性预检之前**——新建文件的旧侧是空的，若让预检先跑，会返回一个误导性的 `not-found`，让人以为模型写的上下文不对而白重试，真实原因却是这类改动本就不支持。已确认 jsdiff 会给出 `isCreate` / `isDelete` 标志，`/dev/null` 也要一并认（不依赖 git 风格头）。

### 2.9 execute 阶段的四个设计决定（实现时定的）

**① 「这一步不需要改」必须是显式工具，不能从文本推断。**

提示词允许模型判定某个 step 不成立。早先的实现里，模型回文本而不调工具就被当成"它说不用改"，于是循环把它记成跳过；但同一现象也可能是"模型没按格式输出"。两种情形混在一起，结果是：模型老老实实解释"这里不需要改"，循环却当成失败去**重试**，而重试只会让它把同样的理由再说一遍。

所以加了 `skip_step`（参数带 `reason`）。三种情形从此互不混淆：提交 diff / 明确跳过（不重试）/ 没遵守格式（重试）。

**② 多文件段的 patch 必须先在暂存区全部试成功，再写回 overlay。**

一个 patch 含多个文件段时，若第一段应用成功、第二段失败，快照就被污染了——而后面**每个** step 都基于这个坏状态生成，产出的 diff 全是错的。这类 bug 不会当场报错，只会让结果整体偏掉。

所以 `generate.ts` 先在一个临时 Map 上逐段 `applyPatchToContent`，全部成功才逐段 `overlay.commit`。`Overlay.commit` 因此明确标注"不要拿它绕过校验"。

**③ 计划与项目对不上就拒绝执行。**

`.perf/plan.json` 是文件，可能被复制到另一个项目、或在换了目录之后继续用。基线不同意味着 diff 会指向错误的行——所以比对 `plan.target.root` 与当前项目根，不一致直接拒绝并给出两边路径。

**④ 先加载计划，再做认证预检。**

没有计划是首次使用**最常见**的情形，而它比"缺凭证"更根本、也更便宜（纯本地检查，不发请求）。顺序反了，用户会在该被告知"先跑 `perf plan`"的时候看到一条关于 API key 的报错。因此 `loadRunPlan` / `checkPlanRoot` 与 `runRunCommand` 分开导出，调用方按此顺序调。

**关于 diff 头里的 `a/` `b/` 前缀**：`resolvePatchPath` 会尝试剥掉它，但**先试原样路径**，且会在结果里标出来、由报告提示用户。这与 §6.4 的"严格匹配、不猜"不矛盾——那里是 profile 里的绝对路径，猜错会指向另一个真实文件；这里只有一个明确的 git 约定，且有先后次序。

### 2.10 应用阶段的五个决定（实现时定的，都在写路径上）

**① 判断 git 命令的结果必须看退出码，不能看输出。**

空仓库里 `git rev-parse HEAD` **退出码 128，却把 `HEAD` 原样打到了 stdout**——git 会把无法解析的参数回显。早先的实现用"stdout 为空即无效"判断，于是检查永不触发，`startSha` 变成了字符串 `"HEAD"`，前提条件形同虚设。

这是**系统性**的：git 失败时常仍往 stdout 写东西。所以所有取值都过一层 `gitValue()`——只在退出码为 0 时返回 stdout。`rev-parse HEAD` 还额外验了 SHA 形状。

**② 前置条件在**问确认之前**查完。**

否则用户读了半天 diff、点了 `y`，才被告知工作区是脏的——那次确认完全白问。`applyEdits` 内部仍会再查一遍（写路径不该依赖调用方的检查），外层查是为了别让人白确认。

**③ 基线校验是唯一能发现"生成期间文件被别处改了"的地方。**

overlay 是**预测态**，它假设磁盘还停在生成时的样子。用户在预览与确认之间改了同一个文件，预测就不成立，而写下去是**静默覆盖**他的改动。所以动手前逐个文件比对磁盘与 overlay 记下的原始内容，任何一处不符就拒绝并指出是哪些文件。

**④ "工作区干净"只查已跟踪文件的修改。**

用 `git status --porcelain --untracked-files=no`。未跟踪文件不影响回退能力，而把它们算进来会让 `.perf/` 没被 gitignore 的项目**每次都被拒绝**——那是常态，不是例外。

**⑤ 某一步没产生实际改动时跳过提交，而不是硬提交。**

`git commit` 对"nothing to commit"会失败，而那个失败会**中止后面所有 step**。理论上生成阶段已经挡掉了无改动的 step（`diff/` 的 `unchanged`），但这里是写路径，不值得靠上游的保证。所以提交前用 `git diff --cached --quiet` 判断一下。

**顺带说清"每步一个 commit"为什么需要额外数据**：overlay 只保留最终态，而每个 commit 要的是**该步之后**的中间态。若某文件被后面的 step 又改过，最终态就还原不出这一步的样子。所以 `StepEdit` 带一份 `snapshot`（该步结束时它触及的每个文件的内容）。少了它，`git revert` 第一句会把第二步的改动也带走。

---

## 3. LLM 层：`@earendil-works/pi-ai`

### 3.1 为什么用它

原始设计中，跨 provider 的工具调用归一化被列为 LLM 层的主要工作量：Anthropic 用 `tool_use` / `tool_result` 内容块，OpenAI 用 assistant 消息上的 `tool_calls` 加独立的 `role: "tool"` 消息配 `tool_call_id`。pi-ai 已经做了这件事，而且是**双向**的——工具定义、工具调用、工具结果回填全部统一。

它同时覆盖了我们原本要自己写的三块退化逻辑：跨 provider 认证解析、结构化输出能力差异、以及测试用的假 provider。

### 3.2 我们的用法

非流式为主（CLI 场景，`plan` 阶段不需要逐字输出）：

```ts
import { Type, type Context, type Tool } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'

const models = builtinModels()
const model = models.getModel('anthropic', 'claude-sonnet-5')

const response = await models.complete(model, context)
for (const block of response.content) {
  if (block.type === 'toolCall') {
    /* 执行工具，回填 toolResult */
  }
}
```

**终止条件**：`done` 事件的 `reason === 'toolUse'` 表示模型还要调工具，循环继续；否则结束。

**最终 Plan 的产出方式**：把 Plan 本身定义成一个工具（如 `submit_plan`），让模型通过调用它来收尾。好处：

- 拿到 provider 侧 schema 强制（见 3.4）。
- 循环的终止条件变成"模型调用了 `submit_plan`"，与 `stopReason` 判断互为冗余校验。
- **触顶收尾可以用"把工具集收缩为只剩 `submit_plan`"来实现**——这比追加一条自然语言提示更强硬，且不依赖任何 provider 特性。

### 3.3 Schema 用 TypeBox，不是 zod

`CLAUDE.md` 原文写的是 zod，**必须回改**。pi-ai 用 TypeBox（`Type` / `Static` / `TSchema` 从包内再导出），工具参数与校验都走它。混用两套 schema 系统意味着同一份 `Plan` 契约要维护两份定义，是明确的错误。

TypeBox 是 JSON Schema 原生的，这一点在"同一份 schema 既喂给 provider 也用于运行时校验"的用法上比 zod 更顺。

**注意点**：枚举必须用 pi-ai 再导出的 `StringEnum`，**不要用 `Type.Enum`**——后者生成 `anyOf`/`const` 结构，Google 的 API 不支持。`Step.kind` 和 `Step.risk` 都是枚举，这条直接适用。枚举值要写 `as const`，否则 `Static` 只能推出 `string`，枚举约束在类型层面就丢了。

**导入路径与 README 不符（实测 v0.85.1，照抄 README 会编译不过）**：

| 名字                                                                           | 从哪引                                                |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `Type` / `Static` / `TSchema` / `Tool` / `Context` / `ToolCall` / `StopReason` | 根：`@earendil-works/pi-ai`                           |
| `StringEnum`                                                                   | 子路径：`@earendil-works/pi-ai/utils/typebox-helpers` |
| `validateToolCall` / `validateToolArguments`                                   | 子路径：`@earendil-works/pi-ai/utils/validation`      |

包是 **ESM-only**（无 CJS 出口），`require()` 会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。装出来约 27.5 MB（pi-ai 6.2M + AWS SDK 7.3M + Google SDK 14M），见 §3.7。

### 3.4 结构化输出的两层保障

| 层          | 手段                                                             | 作用                                                                  |
| ----------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| provider 侧 | `constrainedSampling: { type: 'json_schema', strict: 'prefer' }` | 支持时由 provider 强制 schema，不支持时自动退化为普通工具调用         |
| 本地        | `validateToolCall(tools, toolCall)`                              | 抛错即把错误作为 `isError` 的 toolResult 回填，让模型带着错误信息重试 |

**默认用 `strict: 'prefer'` 而不是 `'require'`**。`'require'` 在 provider 不支持时会直接让请求失败；而 strict JSON-schema 支持目前限于 OpenAI、Anthropic、Bedrock、Mistral、Gemini 3——本项目的主要用户很可能在用 DeepSeek / Qwen 这类 OpenAI 兼容端点，支持情况不确定。用 `'prefer'` 保证可用性，provider 强制当作加分项。

**但「本地校验是真正的保证」这句话是有条件的：它是强制转换式的，不是严格式的。** 实测 `validateToolArguments` 底层用 TypeBox 的 **Value.Convert**，会把标量**转成**目标类型而不是拒绝：

| 输入                       | 结果                                         |
| -------------------------- | -------------------------------------------- |
| `summary: 123`             | **通过**，变成 `"123"`                       |
| `summary: true`            | **通过**，变成 `"true"`                      |
| `files: [42]`              | **通过**，变成 `["42"]`                      |
| `kind: 'nope'`（非法枚举） | 拒绝 ✓                                       |
| 多余的顶层字段             | 拒绝 ✓（`additionalProperties: false` 生效） |
| 缺 `summary`               | 拒绝 ✓                                       |

对我们而言这个性质是**可接受**的：会被强制转换的只有标量，而它们之后的处置都不依赖类型严格性（`files` 的数字变成字符串后照样过路径校验）。真正危险的是枚举、必填、以及"多余字段"——那三类恰好是硬拦的。

**最后一条尤其关键**：`additionalProperties: false` 让模型**无法注入 `grounded` / `evidence`**。一个把 `grounded: true` 写进没有证据的计划里的模型，会直接摧毁「有数据」与「没数据」的行为分叉，也就是摧毁这整套 evidence 机制的可信度。

**这条性质必须留在文档里**：以后若给模型输出的 schema 加数值字段（比如"预期收益百分比"），字符串会被**静默转成数字**而不是报错——那时就不能再指望这层校验兜底，得自己加检查。

### 3.5 认证与预检

pi-ai 的每个 provider 自己负责认证解析（环境变量、存储的凭证、OAuth、AWS profile、gcloud ADC 等）。我们用 `models.getAuth(model)` 或 `checkAuth()` **在不发请求的前提下预检**，缺 key 时给出明确报错——对应 `CLAUDE.md` 里"硬性前置条件不满足时要明确报错而非静默降级"那条。

**API key 仍然只从环境变量读**，不写进 `.perftoolrc.json`。pi-ai 提供了 `CredentialStore` 持久化凭证的机制，**不使用**——本项目是他人项目里的 devDependency，不应在任何地方落盘用户的密钥。

### 3.6 测试

`fauxProvider()` 提供内存中的脚本化 provider：

```ts
const faux = fauxProvider()
models.setProvider(faux.provider)
faux.setResponses([
  fauxAssistantMessage([fauxToolCall('grep', { pattern: 'foo' })], { stopReason: 'toolUse' }),
])
```

这让工具循环**完全确定性地可测**：脚本化模型要调哪些工具，断言循环行为、轮数上限、重复检测、触顶收尾。这是 D3 选型后最重要的测试基础设施——没有它，agentic 循环基本没法测。

### 3.7 代价与注意点

- **依赖体积**：pi-ai 的 `dependencies` 硬依赖 `@anthropic-ai/sdk`、`openai`、`@google/genai`、`@aws-sdk/client-bedrock-runtime`，解包 4.3 MB。即使我们只用 Anthropic 与 OpenAI 兼容端点，AWS 与 Google 的 SDK 也会被装上。对 devDependency 而言可接受，但要知道这不是免费的。
- 只收录支持 tool calling 的模型（对我们不构成限制，本来就是必需能力）。
- `balancedModels()` / `createModels()` + 按需注册 provider 可减小体积，但我们不打包（Node CLI），收益有限，先不折腾。
- **备选未采用**：同仓库的 `@earendil-works/pi-agent-core` 提供更上层的 agent 运行时（工具执行、事件流、`beforeToolCall`/`afterToolCall` 钩子）。它的钩子机制其实很适合承载 §4.2 里"输出上限 / 符号链接校验 / 重复检测"这类工具调用中间件。未采用的理由：我们的循环控制需求是定制的（轮数随有无证据变化、触顶收缩工具集、轨迹落盘格式），套一层通用运行时的适配成本未必低于自己写一个几十行的循环。**若循环复杂度后来显著上升，应重新评估**。

---

## 4. 只读工具集

### 4.1 工具清单

| 工具        | 参数                     | 说明                                                     |
| ----------- | ------------------------ | -------------------------------------------------------- |
| `read_file` | `path`, `start?`, `end?` | 支持行范围。热点函数可能在一个巨大文件里，整读是浪费     |
| `grep`      | `pattern`, `glob?`       | 正则搜索，返回匹配位置。**反向查询的核心**（谁调用了 X） |
| `glob`      | `pattern`                | 文件发现                                                 |
| `list_dir`  | `path`                   | 目录结构                                                 |

全部限定在目标项目根内，且受配置的 include/exclude 与目标项目 `.gitignore` 约束（用 `ignore` 包做 gitignore 匹配）。

### 4.2 实现要求

前四条不落实就会出事：

1. **每个工具必须有输出上限，并显式告知模型"结果被截断了，请缩小范围"。** grep 一个常见词返回几千行是 agentic 循环最经典的失控方式；而模型不知道自己被截断时，会基于残缺结果下结论，这比报错更危险。
2. **符号链接路径 containment 的真实绕过路径。** 必须先解析真实路径（`fs.realpath`）再校验在项目根内，否则一个指向 `/etc/passwd` 的软链就绕过去了。`.perftoolrc.json` 是目标项目提供的，但目标项目本身也是不可信输入。
3. **重复工具调用检测与提示**：同一 `(工具, 参数)` 重复调用时返回缓存结果并注入提示（"你已经查过这个，结果同上"）。模型绕圈重复查询很常见，不拦就是白烧轮数。
4. **完整工具调用轨迹落盘**（`.perf/trace.json`）。没有它，一个坏计划无法诊断——你只能看到结论，看不到它读了什么。这是选择 D3 必须付的成本。
5. 轮数上限**随有无证据而变**：有证据时每个热点都对应一个明确问题要答，上限可以高些；无证据时是盲探、边际收益衰减快，反而要给低上限。
6. 触顶时**不静默降级**：把工具集收缩为只剩 `submit_plan`，迫使模型基于已收集信息出计划，并在 `Plan.caveats` 里标注哪些判断缺乏依据。
7. **grep 等工具用 JS 实现，不 shell 出去**，避免注入面。

**实现时补上的第四条（原设计漏了）**：**凭证类文件必须四个工具一致地不可见、不可读。** 原设计只写了"读操作前做 containment 校验"，于是实现时只挡住了 `read_file`——`list_dir` / `grep` / `glob` 仍然会把 `.env`、`server.pem` 列出来。结果是文档承诺的"跳过 .env"只兑现了四分之一，而且工具之间自相矛盾：模型看不到内容却看得到它们存在。这是测试发现的，不是设计时想到的。

**另外三条实现时的取舍**：

- **走树时跳过符号链接。** `Dirent.isFile()` 对软链为 `false`，所以软链既不会被当成目录走进去（**因此永远不可能通过目录软链走出项目根**），也不会被枚举出来。代价是软链指向的文件在 `grep` / `glob` / `list_dir` 里看不见；单个软链文件仍可用 `read_file` 直接读——那条路会 realpath 后再判 containment。
- **只读项目根的 `.gitignore`**，嵌套的 `.gitignore` 不生效。另有 `node_modules` 与 `.git` 的**无条件排除**作为安全网——没有它，一个没有 `.gitignore` 的项目会让走树直接进 `node_modules`（几十万文件）而卡死。
- **`truncated` 只在"我们因上限砍掉了本来能返回的内容"时为真。** 模型自己指定了行范围并被满足、或被文件末尾截住，都不算截断——那时循环会追加"结果已被截断，请缩小范围"，而这句话在那个场景是误导。

**忽略规则的单一来源**：`tools/ignore.ts`。`context/` 的文件发现必须复用它，不要另写一套——两套规则迟早漂移，症状是"模型能 grep 到的文件，上下文里却没有"这类极难查的不一致。

---

## 5. 核心数据契约（修订）

```ts
type Plan = {
  summary: string
  target: { root: string; language: string; buildSystem?: string }
  grounded: boolean // 是否基于实测证据
  evidence?: PerformanceEvidence // grounded 为 true 时存在
  caveats?: string[] // 触顶或信息不足时，模型标注的不确定判断
  steps: Step[]
}

type Step = {
  id: string
  title: string
  rationale: string
  files: string[] // 一律相对目标项目根
  kind: 'refactor' | 'algorithmic' | 'config' | 'dependency' | 'other'
  risk: 'low' | 'medium' | 'high'
  expectedImpact?: string // 仅有实测证据时给出
}

type PerformanceEvidence = {
  source: 'profile-file' // 将来扩展 'benchmark'
  runtime?: string // 如 node@20.11
  unit: 'time' | 'samples' | 'bytes'
  totalSampledMs: number // 整个 profile 的采样总时长
  projectShare: number // 本项目代码占的 self time 比例
  dependencyShare: number // 非本项目代码：依赖（含根内 node_modules）、根外路径、无法解析的 url
  engineShare: number // 不属于任何用户代码：合成节点与 node:internal/*
  dependencyTop?: string[] // 非本项目代码里耗时最高的几个，供判断是否该看依赖
  hotSpots: HotSpot[] // 按 selfShare 降序
  hotSpotsOmitted?: { count: number; share: number } // 被上限截断的部分
}

type HotSpot = {
  file: string // 相对目标项目根
  line: number // **1-based**（人读的行号）
  range?: [number, number]
  symbol?: string // 函数名。**只是提示**：函数被内联时它会指向错误的函数，见 §6.2
  selfShare: number // 自身耗时 / 整个 profile 总时长
  precision: 'line' | 'function' // 这条是行级，还是只有函数级（无 positionTicks）
}
```

**Plan 分两层，模型只提交其中一层。**

- **`PlanDraft`**（模型通过 `submit_plan` 提交）：只有 `summary` / `caveats` / `steps`。
- **`Plan`**（完整契约）：额外带 `target` / `grounded` / `evidence`，这三样**由我们补全**。

理由是这三样都属于"我们知道得比模型准"的事实：`target` 来自目标项目探测，`grounded` 与 `evidence` 来自 `evidence/` 的解析结果。让模型提交它们等于让它**编造**自己无从知道的东西。模型的输出 schema 用 `additionalProperties: false` 堵死这条路——**实测这条硬拦是生效的**，模型无法注入 `grounded` / `evidence`。

相对早期版本的改动：

- 新增 `Plan.caveats`（承载 §4.2 第 6 条要求）。
- `PerformanceEvidence` 新增时间分类字段（`totalSampledMs` / `projectShare` / `dependencyShare` / `engineShare` / `dependencyTop`），以及 `hotSpotsOmitted`。
- `HotSpot` 新增 `precision`（区分行级与函数级精度），`line` 明确为 1-based。
- **删除了 `HotSpot.totalShare`**。它原意是"含被调者的累计时间"，但累计时间只能按**节点子树**定义，而同一函数会出现在树的多个位置，按函数聚合累计时间会重复计算——是个静默出错的陷阱。而"按文件的 self time 之和"既不重复又更有用（"这个文件里的代码吃掉了多少时间"）。判断依据：模型要优化的是**时间实际花在哪一行**，self time 才是对的信号；调用结构它可以用 grep 自己查。
- **`outsideProject*` 改名为 `dependency*`**，并且 `engineShare` 的含义扩大到包含 `node:internal/*`。原因是实现时发现的漏洞，见 §6.4。

schema 用 TypeBox 定义一次（见 3.3）。本节的类型是权威版本；`CLAUDE.md` 里那份是摘要，改动时以本节为准并同步过去。

---

## 6. 证据归一化：`.cpuprofile` 解析

`src/evidence/` 的唯一入口。本节所有数字来自一个**已知热点在 `hotLoop`** 的 Node 脚本（`node --cpu-prof`），实测值而非推测。

### 6.1 格式

顶层：`nodes` / `startTime` / `endTime` / `samples` / `timeDeltas`。

```ts
type CpuProfileNode = {
  id: number
  callFrame: {
    functionName: string // 可能是空串
    scriptId: string
    url: string // 'file:///…' | 'node:internal/…' | ''（合成节点）
    lineNumber: number // 0-based；合成节点为 -1
    columnNumber: number
  }
  hitCount: number // 自采样次数
  children?: number[] // 部分节点没有
  positionTicks?: { line: number; ticks: number }[] // 只有部分节点有
}
```

`startTime` / `endTime` 是**单调时钟微秒**，不是 epoch（实测 `endTime - startTime` = 524.5ms，与 `timeDeltas` 之和吻合）。

### 6.2 三条会决定算法对错的发现

**① 内联让"按函数名归因"失真 —— 必须按 (文件, 行) 归因。**

同一份 profile，两种归因指向**不同的代码**：

| 按函数名归因 |        | 按 (文件, 行) 归因 |         |
| ------------ | ------ | ------------------ | ------- |
| `main`       | 416.4m | `hot.js:3`         | 377.5ms |
| `hotLoop`    | 83.2ms | `hot.js:10`        | 79.2ms  |
| `(program)`  | 23.3ms | `hot.js:1`         | 24.0ms  |

`main` 节点的 331 个 tick 里有 **268 个落在 `hotLoop` 的函数体内**——`hotLoop` 被 V8 内联进了 `main`。按函数名归因会把模型指向 `main` 的函数体（真凶只占 63 个 tick），而真正的热循环在 `hotLoop` 里占 268 个。

**这正是 evidence 机制要防的"优化错地方"。** 所以 `positionTicks` 是必需品而非加分项；`HotSpot.symbol`（函数名）只能当提示，绝不能当定位依据。

**② `positionTicks[].line` 是 1-based，`callFrame.lineNumber` 是 0-based。**

实测 `main` 节点的 `positionTicks` 为 `{line: 3, ticks: 268}`：

- 按 0-based 解释 → `return s`（不可能是热点）
- 按 1-based 解释 → `for (let i = 0; i < n; i++) s += i * i`（就是热行）

两个节点的 ticks 分布都只在 1-based 解释下合理（`hotLoop` 节点的 `{line:1, ticks:19}` 按 1-based 是函数入口，按 0-based 是 `let s = 0`）。

我们的 `HotSpot.line` 统一定义为 **1-based**。转换：`positionTicks[].line` 原样用；`callFrame.lineNumber + 1`。

**③ 必须累加 `timeDeltas`，不能用 `hitCount × 名义间隔`。**

实测：`hitCount` 总和 398，名义间隔 1ms → 398ms；而 `timeDeltas` 累加 = **524ms**（与实际运行时长吻合）。实测平均采样间隔 **1314µs**，不是 1000µs。采样间隔不精确，且**低估比例 per-node 不均匀**，取决于调度。

好消息：`positionTicks[].ticks` 之和**精确等于** `hitCount`（三个节点全部相等：331=331、66=66、1=1）。所以按 `ticks / Σticks` 比例摊分该节点的 self time 是精确的，不是近似。

### 6.3 算法

```text
1. 校验 samples.length === timeDeltas.length，否则报错
2. selfByNode[id] = Σ timeDeltas[i]  其中 samples[i] === id
3. 摊分到行：
     有 positionTicks → line time += selfByNode × (ticks / ticks 总和)，precision = 'line'
     无 positionTicks → 记在 callFrame.lineNumber + 1，          precision = 'function'
4. url 归一化与分类（见 6.4）
5. 按 (file, line) 聚合 → HotSpot[]，按 selfShare 降序
6. 文件 roll-up：文件 self time = 该文件所有节点 self time 之和
```

第 6 步有个值得保留的性质：**每个采样恰好属于一个节点，每个节点恰好属于一个文件，所以按文件 roll-up 是总时长的一个划分，不会重复计算。**

### 6.4 路径与分类（严格匹配，不猜）

`url` 存的是 **realpath**：实测传入的是 `/tmp/prof-exp/hot.js`，profile 里写的是 `file:///private/tmp/prof-exp/hot.js`（macOS 上 `/tmp` 是软链）。**必须用 `realpath(项目根)` 去比**，否则在 macOS 上、或任何经软链访问的项目上必然匹配失败。这与 `CLAUDE.md` 的符号链接安全规则同源。

**不做模糊 / 后缀匹配。** 匹配到错的文件比没有热点更糟——模型会去优化一个根本不热的文件。

分类规则：

| 情况                                           | 处置                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `url === ''`                                   | 合成节点（`(root)` / `(program)` / `(idle)`）。**`lineNumber` 为 -1，盲目 +1 会算出第 0 行。** 计入 `engineShare` |
| `node:internal/*`                              | Node 自身代码，计入 `engineShare`                                                                                 |
| 路径含 `node_modules` 段（**无论在不在根内**） | 依赖，计入 `dependencyShare`                                                                                      |
| 落在项目根内且不是依赖                         | 项目代码，计入 `projectShare`                                                                                     |
| 落在项目根外（hoisted 依赖、monorepo 兄弟包）  | 计入 `dependencyShare` 并记入 `dependencyTop`，**不报错**                                                         |
| 转不成文件路径（`webpack://`、`data:` 等）     | 计入 `dependencyShare` 并记入 `dependencyTop` 的原始 url                                                          |
| **没有任何节点落在项目根内**                   | **报错** —— 这才是"拿错 profile / 项目根不对"的信号                                                               |

第四、五行不报错是刻意的：慢依赖是正当的性能发现，静默丢弃会把它藏掉；而"没有任何节点落在根内"才真正说明 profile 与项目对不上。

**`node_modules` 必须单独判，这是实现时发现的漏洞。** 原设计只判"是否落在项目根外"，但最常见的形态是 `./node_modules` **就在根内**——只按 `relative()` 判断会把它算成项目代码，于是依赖里的热点进了 `hotSpots`，模型就会去"优化"一个它改不了的第三方包。这也是 `outsideProject*` 改名 `dependency*` 的原因：那些字段的实际语义是"非本项目代码"，装上根内的 `node_modules` 之后原名就不准了。

**目前只特判 `node_modules` 段。** 其他被忽略的目录（`dist/`、`vendor/`）仍算项目代码——对 `dist/` 而言这甚至是正确的（那确实是你的代码，只是编译过）。将来若要按目标项目的 `.gitignore` 过滤，应放在这里，与 `context/` 的文件发现共用同一套忽略规则。

### 6.5 已知限制

- **不解析 source map。** TypeScript 项目的热点行号指向**编译产物**，需要用户自己对照 source map。v1 明确接受这个限制——代价是 TS 项目体验打折，换来的是避开一串降级问题（构建产物不存在、outDir 布局多样、行号映回到 `.d.ts` 或缺失）。要补的话是独立一块工作。
- **无 `positionTicks` 的节点只有函数级精度**，在数据里以 `precision: 'function'` 标出。**prompt 里也要说明**——不能让模型以为所有条都是行级精度。
- 采样器的固有偏差（内联、去优化、GC 归入 `(program)`）无法从 profile 本身消除，只能靠上面的归因方式减少误判。

---

## 7. 待定项

- **配置系统**：`.perftoolrc.json` 的字段与优先级已定（flag > env > 文件 > 默认），schema 未定。注意 provider 的选择方式因 pi-ai 而简化——不再需要 `provider: anthropic | openai-compatible` + `baseUrl` 的组合，改成模型标识 + pi-ai 的认证解析。
- **git 集成**：分支命名、逐 step 提交的信息格式、失败中断后的报告格式未细化。
- **CLI 交互**：确认提示的具体形态、`--by-step` 的输出格式、`--dry-run` 与预览的关系。
- **命令面**：`init`（写入配置）与 `report`（历史与 diff 查看）是否要实现。
