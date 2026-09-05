# DeepSeek Harness IM

本上下文描述 dsh-im 如何把不同即时通信平台中的用户意图和 DeepSeek Harness 的工作过程连接起来。项目的核心价值不是渠道数量，而是让用户在所在渠道中自然、可靠地完成 Harness 任务。

## Language

**语义消息（Semantic Message）**：
不依赖具体 IM 平台、能够完整表达用户输入及其上下文的一条消息，包括内容、引用关系和会话位置。
_Avoid_: 统一文本、通用消息体

**语义交互（Semantic Interaction）**：
Harness 等待用户完成的一次有状态操作，例如审批、单选、多选或补充输入。
_Avoid_: 按钮事件、命令回复

**产物（Artifact）**：
Harness 任务读取或产生、需要在 Harness 与用户所在渠道之间安全传递的文件或媒体。
_Avoid_: 附件路径、下载地址

**产物来源（Artifact Provenance）**：
证明一个现有或新建的出站产物由当前 Harness Session/Turn 通过受信工具结果显式登记的可验证记录；它证明交付意图和路由，不要求文件必须由当前 Turn 创建。
_Avoid_: 回答里的路径、最新文件

**会话路由（Conversation Route）**：
唯一确定消息所属机器人、聊天及话题或线程的会话位置。
_Avoid_: Chat ID、会话 Key

**投递目标（Delivery Target）**：
由 `botId + targetId` 稳定标识、并绑定到可更新会话路由的主动投递位置；它不依赖当前 Harness Session 或最近一条入站消息。
_Avoid_: Session ID、ChatRef、临时 Webhook

**会话同步目标（Session Sync Target）**：
经用户明确开启、随其私聊会话路由当前绑定的 Harness Session 变化的投递目标；它使该 Session 与该私聊之间形成双向文字可见性。
_Avoid_: 双向绑定、Session 投递地址、默认机器人

**延迟交付（Deferred Delivery）**：
前台等待因停滞超时被放弃后，在后台继续监视同一 Harness 回合直至终态，并把最终结果投递回原会话路由的机制；它不改变前台超时的报错语义。
_Avoid_: 后台重试、二次提交、轮询补发

**绑定闸门（Binding Gate）**：
延迟交付在终态投递时刻的投放条件——会话路由当前绑定的 Harness Session 必须仍与产生结果的 Session 一致；不一致时静默放弃投递，结果保留在该 Session 历史中。
_Avoid_: 会话锁定、推送开关、会话镜像

**回合控制权（Turn Control Ownership）**：
一个会话路由对其提交的特定 Harness 回合进行停止或纠偏的权限；它随该回合结束而终止，待交付的结果不赋予对同一 Session 后续回合的控制权。
_Avoid_: 会话运行权、待发送任务、后台会话权限

**渠道能力（Channel Capability）**：
某个机器人实例在当前权限和运行条件下可以可靠提供的原生输入、交互或呈现能力。
_Avoid_: 平台支持、SDK 功能

**原生呈现（Native Presentation）**：
渠道依据自身交互习惯呈现同一语义，例如卡片、按钮、消息编辑、流式回复或输入状态。
_Avoid_: 特殊适配、渠道特例

**呈现意图（Presentation Intent）**：
Harness 输出在进入渠道前必须保留的内容结构和格式含义，例如纯文本、Markdown、进度、交互或产物；它不指定某个平台的控件或语法。
_Avoid_: 回答字符串、Telegram Rich Message、统一富文本

**渠道原生动作（Native Channel Action）**：
渠道为承载一次语义任务而执行的平台专属操作，例如创建 Discord Thread、更新飞书卡片或上传附件；它属于渠道边界，不要求其他渠道提供同名操作。
_Avoid_: 公共命令、通用渠道方法

**选择呈现（Selection Presentation）**：
单选或多选在渠道中的实际实现形态，只能表述为原生控件、组合交互或文字降级；判断能力时必须同时说明呈现形式和已经验证的范围。
_Avoid_: 支持多选、能力允许时、统一选择器

**明确降级（Explicit Fallback）**：
渠道缺少所需能力时，保持业务语义并向用户说明限制的替代体验。
_Avoid_: 兼容模式、静默忽略

**能力切片（Capability Slice）**：
围绕一个完整用户价值，从统一语义、安全策略到各渠道原生呈现和验收的端到端建设单元。
_Avoid_: 渠道任务、接口改造

**标杆渠道（Reference Channel）**：
一项能力切片中最先完成真实客户端闭环、其原生机制最适合验证该语义和体验的渠道。标杆渠道按能力选择，不是永久主渠道。
_Avoid_: 主渠道、默认渠道

**用户价值优先级（User Value Priority）**：
依据核心任务完成度、语义准确性、移动端操作成本以及安全与可靠性，决定能力切片的建设先后顺序。
_Avoid_: 功能数量排序、渠道用户量排序

**渠道适配性（Channel Fit）**：
某项语义能力与渠道原生机制、权限覆盖、接口稳定性和可测试性之间的匹配程度，用于选择标杆渠道并决定原生实现或明确降级。
_Avoid_: 渠道排名、平台先进程度

**渠道行为基线（Channel Behavior Baseline）**：
语义迁移开始前，某个渠道已经向用户提供的任务流程、控制能力、状态语义和原生体验的可验证集合；后续实现可以改善它，但不能使其中任何能力消失或退化。
_Avoid_: 当前代码、旧实现、测试现状

**等价接管（Parity Cutover）**：
新语义路径在覆盖渠道行为基线、通过回归并具备回滚能力后，才取得某项消息或能力的唯一处理权。
_Avoid_: 直接替换、重写完成
