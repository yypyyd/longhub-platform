/** 云台服务进程入口：读取 PORT、EXECUTOR_URL、EXECUTOR_CREDENTIAL_SECRET、DATABASE_URL、ADMIN_TOKEN 环境变量启动。 */
import { bootstrap } from "./index.js";

void bootstrap();
