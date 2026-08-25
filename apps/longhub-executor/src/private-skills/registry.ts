import type { CloudSkill } from "../server.js";
import { executeSalaryBand } from "./salary-band.js";

/**
 * This tuple is the complete build-time Cloud Skill allowlist. Adding a Skill
 * requires a reviewed source change and a new Executor build/deployment.
 */
const PRIVATE_CLOUD_SKILL_ENTRIES = Object.freeze([
  Object.freeze(["longhub.skill.salary-band", executeSalaryBand] as const),
] as const);

export const PRIVATE_CLOUD_SKILL_IDS = Object.freeze(
  PRIVATE_CLOUD_SKILL_ENTRIES.map(([skillId]) => skillId),
);

class FixedCloudSkillRegistry implements ReadonlyMap<string, CloudSkill> {
  readonly #skills = new Map<string, CloudSkill>(PRIVATE_CLOUD_SKILL_ENTRIES);

  get size(): number {
    return this.#skills.size;
  }

  get(skillId: string): CloudSkill | undefined {
    return this.#skills.get(skillId);
  }

  has(skillId: string): boolean {
    return this.#skills.has(skillId);
  }

  entries(): MapIterator<[string, CloudSkill]> {
    return this.#skills.entries();
  }

  keys(): MapIterator<string> {
    return this.#skills.keys();
  }

  values(): MapIterator<CloudSkill> {
    return this.#skills.values();
  }

  [Symbol.iterator](): MapIterator<[string, CloudSkill]> {
    return this.#skills[Symbol.iterator]();
  }

  forEach(
    callback: (value: CloudSkill, key: string, map: ReadonlyMap<string, CloudSkill>) => void,
    thisArg?: unknown,
  ): void {
    for (const [skillId, skill] of this.#skills) {
      callback.call(thisArg, skill, skillId, this);
    }
  }
}

/** No mutator is exposed and no runtime configuration can add an entry. */
export const PRIVATE_CLOUD_SKILL_REGISTRY: ReadonlyMap<string, CloudSkill> =
  Object.freeze(new FixedCloudSkillRegistry());
