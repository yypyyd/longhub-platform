import { SkillInputError, type CloudSkill } from "../server.js";

interface SalaryBandInput {
  readonly level: number;
}

function parseSalaryBandInput(input: unknown): SalaryBandInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SkillInputError();
  }
  if (Object.getPrototypeOf(input) !== Object.prototype) {
    throw new SkillInputError();
  }
  const fields = Object.keys(input);
  if (fields.length !== 1 || fields[0] !== "level") {
    throw new SkillInputError();
  }
  const level = (input as Record<string, unknown>).level;
  if (!Number.isSafeInteger(level) || (level as number) < 1 || (level as number) > 10) {
    throw new SkillInputError();
  }
  return { level: level as number };
}

/** First private implementation; this module is compiled only into Executor. */
export const executeSalaryBand: CloudSkill = async (input) => {
  const { level } = parseSalaryBandInput(input);
  const minimum = 8_000 + level * 4_000;
  return {
    level,
    min: minimum,
    max: Math.round(minimum * 1.6),
    currency: "CNY",
  };
};
