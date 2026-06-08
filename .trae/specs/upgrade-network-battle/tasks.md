# Tasks
- [x] Task 1: 创建网络对战功能分支并锁定升级边界
  - [x] SubTask 1.1: 基于当前默认分支创建并切换到 `feature/network-battle-sync`
  - [x] SubTask 1.2: 记录本次升级只覆盖“权威服务器 + JSON 节拍同步”的第一版范围
  - [x] SubTask 1.3: 确认不在本轮实现中引入 P2P、二进制协议或复杂回滚系统
  - 范围说明：本轮仅补齐共享 JSON 协议层与消息结构，不实现 P2P、二进制协议、复杂回滚和联机主循环。

- [x] Task 2: 设计并实现共享网络协议与会话模型
  - [x] SubTask 2.1: 扩展 `INetworkProtocol` 与消息类型，定义房间、准备、输入、快照、事件、心跳、重同步消息
  - [x] SubTask 2.2: 定义可版本化的 JSON 负载结构，补充节拍号、输入序号、玩家标识与错误码
  - [x] SubTask 2.3: 为客户端和服务端抽出共享的协议编解码与校验逻辑

- [x] Task 3: 落地权威服务器节拍循环
  - [x] SubTask 3.1: 新增服务端入口与房间管理，支持玩家加入、离开、准备与开局
  - [x] SubTask 3.2: 以固定逻辑节拍推进模型层，统一处理输入消费、AI、导弹、碰撞与战局判定
  - [x] SubTask 3.3: 广播权威状态快照与关键战斗事件，并保留最近若干节拍用于重同步

- [x] Task 4: 改造客户端控制层与渲染层的联网能力
  - [x] SubTask 4.1: 新增客户端网络会话层，负责连接、心跳、延迟测量与消息分发
  - [x] SubTask 4.2: 将本地输入采集改造为“本地预测 + 上传输入 + 消费权威快照”
  - [x] SubTask 4.3: 调整 HUD/战场视图，显示房间状态、同步状态、对端玩家与断线提示

- [x] Task 5: 实现状态纠偏与弱网恢复
  - [x] SubTask 5.1: 基于节拍号和序列号检测乱序、重复与过期消息
  - [x] SubTask 5.2: 当本地状态与权威快照偏差超阈值时执行平滑纠偏
  - [x] SubTask 5.3: 在连续丢失关键快照时触发全量重同步，并验证恢复结果

- [x] Task 6: 完成联机验证与代码提交
  - [x] SubTask 6.1: 运行类型检查、构建与必要的自动化验证
  - [x] SubTask 6.2: 进行双端联机与弱网模拟验证，确认状态一致性与基本稳定性
  - [x] SubTask 6.3: 汇总变更并按约定提交到当前功能分支

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 2
- Task 5 depends on Task 3
- Task 5 depends on Task 4
- Task 6 depends on Task 5
