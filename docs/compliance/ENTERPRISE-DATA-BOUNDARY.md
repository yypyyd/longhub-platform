# 企业数据边界

> 历史/废弃：本文仍描述旧 Desktop/Pack/知识文档架构，仅作边界草案存档，不作为 clean-launch 首发
> 上线流程或权限依据。

信任边界依次为 Desktop 本机、LongHub Cloud、管理员选择的模型供应商和企业连接器。设备只能访问自身
租户策略和知识文档；Pack 工具权限取 Profile、签名 Pack、租户/设备策略、entitlement、用户确认和预算
的交集。UI 隐藏不构成授权，服务端逐请求复验激活、设备状态、客户端最低版本、模型额度和 entitlement。

密钥分类：设备 Token 进入 Windows Credential Manager；Gateway/Bridge Token 只在本机进程环境与内存；
模型 API Key 以独立 32 字节主密钥 AES-256-GCM 加密；Pack、Update 和 Authenticode 使用不同用途密钥。
生产私钥、证书密码、数据库凭据和知识数据密钥不得进入仓库、日志、诊断或遥测。

知识正文、模型请求和会话属于企业内容；审计、计量和匿名健康指标不是内容存储。备份恢复必须保持租户
隔离和密钥可用性，删除必须覆盖活动库、索引、缓存并按已公告周期处理备份。会话云同步在 1.0 默认关闭。
