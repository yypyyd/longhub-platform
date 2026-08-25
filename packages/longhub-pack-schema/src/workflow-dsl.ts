export type WorkflowLiteral = string | number | boolean | null;

export type WorkflowStep =
  | { readonly id: string; readonly kind: "skill"; readonly skillId: string; readonly input: Readonly<Record<string, WorkflowLiteral>> }
  | { readonly id: string; readonly kind: "confirm"; readonly title: string; readonly summary: string }
  | { readonly id: string; readonly kind: "branch"; readonly inputKey: string; readonly equals: WorkflowLiteral; readonly then: readonly WorkflowStep[]; readonly else: readonly WorkflowStep[] }
  | { readonly id: string; readonly kind: "loop"; readonly iterations: number; readonly steps: readonly WorkflowStep[] };

export interface BoundedWorkflow {
  readonly schemaVersion: "longhub/workflow/v1";
  readonly workflowId: string;
  readonly name: string;
  readonly steps: readonly WorkflowStep[];
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function literal(value: unknown): value is WorkflowLiteral {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

export function parseBoundedWorkflow(input: unknown): BoundedWorkflow {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    !exactKeys(input, ["schemaVersion", "workflowId", "name", "steps"])) throw new Error("Workflow 格式无效");
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== "longhub/workflow/v1" || typeof raw.workflowId !== "string" ||
    !/^user\.workflow\.[0-9a-f-]{36}$/i.test(raw.workflowId) || typeof raw.name !== "string" ||
    !raw.name.trim() || raw.name.length > 80 || !Array.isArray(raw.steps) || raw.steps.length < 1) {
    throw new Error("Workflow 字段无效");
  }
  const ids = new Set<string>();
  let total = 0;
  const visit = (steps: readonly unknown[], depth: number): void => {
    if (depth > 3) throw new Error("Workflow 深度超过 3");
    for (const value of steps) {
      total += 1;
      if (total > 20 || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow 步数或步骤无效");
      const step = value as Record<string, unknown>;
      if (typeof step.id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(step.id) || ids.has(step.id)) {
        throw new Error("Workflow step ID 无效或重复");
      }
      ids.add(step.id);
      if (step.kind === "skill") {
        if (!exactKeys(step, ["id", "kind", "skillId", "input"]) || typeof step.skillId !== "string" ||
          !/^[a-z0-9][a-z0-9._-]{2,159}$/.test(step.skillId) || step.skillId.startsWith("user.workflow.") ||
          !step.input || typeof step.input !== "object" || Array.isArray(step.input) || Object.keys(step.input).length > 32 ||
          Object.values(step.input as object).some((item) => !literal(item))) throw new Error("Workflow Skill 步骤无效");
      } else if (step.kind === "confirm") {
        if (!exactKeys(step, ["id", "kind", "title", "summary"]) || typeof step.title !== "string" ||
          !step.title.trim() || step.title.length > 80 || typeof step.summary !== "string" ||
          !step.summary.trim() || step.summary.length > 500) throw new Error("Workflow 确认步骤无效");
      } else if (step.kind === "branch") {
        if (!exactKeys(step, ["id", "kind", "inputKey", "equals", "then", "else"]) ||
          typeof step.inputKey !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(step.inputKey) || !literal(step.equals) ||
          !Array.isArray(step.then) || !Array.isArray(step.else)) throw new Error("Workflow 分支步骤无效");
        visit(step.then, depth + 1);
        visit(step.else, depth + 1);
      } else if (step.kind === "loop") {
        if (!exactKeys(step, ["id", "kind", "iterations", "steps"]) || !Number.isSafeInteger(step.iterations) ||
          (step.iterations as number) < 1 || (step.iterations as number) > 5 || !Array.isArray(step.steps) || step.steps.length < 1) {
          throw new Error("Workflow 循环步骤无效");
        }
        visit(step.steps, depth + 1);
      } else {
        throw new Error("Workflow 未知步骤类型");
      }
    }
  };
  visit(raw.steps, 1);
  return structuredClone(input) as BoundedWorkflow;
}
