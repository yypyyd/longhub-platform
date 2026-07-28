/** LongHub 能力开发 SDK 入口。 */
export const SDK_VERSION = "1.0";

export interface SkillContext {
  taskId: string;
  /** 本次实际权限 = 声明 ∩ 租户策略 ∩ 用户授权 ∩ 任务上下文 */
  grantedPermissions: readonly string[];
}

export interface SkillDefinition<TInput, TOutput> {
  id: string;
  /** L0-L3 执行等级 */
  level: "L0" | "L1" | "L2" | "L3";
  permissions: readonly string[];
  run(input: TInput, ctx: SkillContext): Promise<TOutput>;
}

export function defineSkill<TInput, TOutput>(
  def: SkillDefinition<TInput, TOutput>,
): SkillDefinition<TInput, TOutput> {
  return def;
}
