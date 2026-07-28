/** 日志、指标、追踪公共组件占位入口。日志必须结构化并脱敏。 */
export interface StructuredLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createConsoleLogger(component: string): StructuredLogger {
  const log = (level: string, event: string, fields?: Record<string, unknown>) => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, component, event, ...fields }));
  };
  return {
    info: (e, f) => log("info", e, f),
    warn: (e, f) => log("warn", e, f),
    error: (e, f) => log("error", e, f),
  };
}
