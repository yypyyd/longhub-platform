# Windows 凭据共享层设计

## 目标

把 Desktop 与 Cloud Plugin 的 Win32 Credential Manager 实现统一到一个小包，同时保证两个产品面无法通过相同 target 互相读取 token。

## 设计

```text
TypeScript vault
    -> normalized HTTPS origin
    -> SHA-256 namespace target
    -> PowerShell stdin JSON
    -> C# CredRead/CredWrite/CredDelete
```

target 使用 namespace 和 origin digest，origin 禁止 userinfo/query/fragment；target 名称不进入 shell 源码。C# 使用 Generic credential、LocalMachine persistence 和固定 blob 上限。

## 写入事务

1. 读取旧值并在内存中校验格式。
2. 写入新值。
3. 回读并比较 device ID/token。
4. 回读失败时写回旧值；没有旧值时才删除新值。

因此一次失败替换不会删除有效旧凭据。错误和 stdout/stderr 限制大小，超时杀死子进程。

## 威胁模型与限制

本包防止 token 落入普通文件、环境变量、命令行、日志和跨产品 namespace；它不替代 Cloud API 的设备撤销和任务授权。真实 Credential Manager 测试只适用于 Windows VM，生产仍需 ACL、签名和发布门禁。

## 变更历史

### 2026-08-17 - 抽取共享层

新增 Cloud Plugin namespace、非 Windows 明确失败、写后回读和旧凭据回滚；Desktop wrapper 改为复用本包。
