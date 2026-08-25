# LH-V2-009 激活与策略端点跨实例限流验收

> 状态：代码完成  
> 日期：2026-07-30  
> 部署状态：未部署

## 已完成

- `POST /v1/devices/activate` 使用 5 r/m 的来源 IP 区和 120 r/m 的全局区，分别允许 5/20 突发。
- `GET /v1/client/feature-policy` 使用 240 r/m 的来源 IP 区和 10000 r/m 的全局区，分别允许
  120/1000 突发，兼容每设备 30 秒刷新及企业 NAT。
- 四个 zone 均在 `http` include 层定义，计数先于 proxy_pass，由同一公网入口的所有 Nginx worker 与
  Cloud API 后端实例共享；后端扩容或重启不重置边缘计数。
- 来源键固定为 `$binary_remote_addr`，不接受 X-Forwarded-For 作为限流身份。
- Nginx 本地产生的 429 返回端点专用稳定错误码、`request_id`、`retryable=true` 与 `Retry-After`；
  应用自身的按设备十分钟五次限流继续作为第二层。
- OpenAPI 为两个端点显式记录 429 与 Retry-After。

## 自动化证据

| 门禁 | 结果 |
|---|---|
| Nginx 配置契约 | 3 项通过：共享区、双桶前置、稳定 429/重试 |
| Nginx 真解析 | Docker `nginx:stable-alpine` 执行 `nginx -t` 成功 |
| Cloud 全量测试 | 19 文件、103 项通过；PostgreSQL 16 七项另行全部通过 |
| OpenAPI/README/DESIGN | 已同步 |

## 边界

本项关闭的是“同一公网 Nginx 后多个 Cloud API 实例”的计数分裂。Nginx 共享内存不能跨独立边缘主机；
若未来增加多地域/多边缘入口，必须先把全局限流迁移到共享 API Gateway 或 Redis。本地容器真解析不
替代目标 Linux 主机的部署前 `nginx -t`；目标解析失败不得 reload。
