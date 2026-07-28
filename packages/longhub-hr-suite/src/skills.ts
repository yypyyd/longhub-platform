/**
 * HR 套装本地技能（L1，Skill Worker 进程内执行）。
 */
import { defineSkill, type SkillDefinition } from "@longhub/sdk";

export interface ResumeScreenInput {
  /** 岗位必备关键词（技能/资质），小写匹配 */
  requiredKeywords: string[];
  resumeText: string;
}

export interface ResumeScreenOutput {
  /** 命中率 0-100 */
  score: number;
  matched: string[];
  missing: string[];
  recommendation: "pass" | "review" | "reject";
}

/** 简历初筛：按岗位关键词命中率打分并给出建议 */
export const resumeScreen = defineSkill<ResumeScreenInput, ResumeScreenOutput>({
  id: "longhub.skill.resume-screen",
  level: "L1",
  permissions: ["connector:hr-api:read"],
  async run(input) {
    const keywords = input.requiredKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (keywords.length === 0) throw new Error("requiredKeywords 不能为空");
    const resume = input.resumeText.toLowerCase();
    const matched = keywords.filter((k) => resume.includes(k));
    const missing = keywords.filter((k) => !resume.includes(k));
    const score = Math.round((matched.length / keywords.length) * 100);
    return {
      score,
      matched,
      missing,
      recommendation: score >= 80 ? "pass" : score >= 50 ? "review" : "reject",
    };
  },
});

export interface OfferLetterInput {
  candidateName: string;
  position: string;
  /** 月薪（人民币元） */
  monthlySalaryCny: number;
  /** 入职日期，ISO 格式如 2026-08-01 */
  startDate: string;
}

export interface OfferLetterOutput {
  letter: string;
}

/** 录用通知书生成：写类操作，需用户确认（permission-policy） */
export const offerLetter = defineSkill<OfferLetterInput, OfferLetterOutput>({
  id: "longhub.skill.offer-letter",
  level: "L1",
  permissions: ["connector:hr-api:write"],
  async run(input) {
    if (!input.candidateName.trim()) throw new Error("candidateName 不能为空");
    if (!Number.isFinite(input.monthlySalaryCny) || input.monthlySalaryCny <= 0) {
      throw new Error(`非法月薪: ${String(input.monthlySalaryCny)}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) {
      throw new Error(`入职日期须为 YYYY-MM-DD: ${input.startDate}`);
    }
    const letter = [
      `${input.candidateName} 您好：`,
      ``,
      `我们很高兴地通知您，您已通过「${input.position}」岗位的选拔。`,
      `您的月薪为人民币 ${input.monthlySalaryCny} 元，入职日期为 ${input.startDate}。`,
      `请在入职日期前回复本邮件确认接受本录用通知。`,
      ``,
      `龙枢人力资源部`,
    ].join("\n");
    return { letter };
  },
});

/** HR 套装的本地技能清单 */
export const hrLocalSkills: readonly SkillDefinition<unknown, unknown>[] = [
  resumeScreen as SkillDefinition<unknown, unknown>,
  offerLetter as SkillDefinition<unknown, unknown>,
];
