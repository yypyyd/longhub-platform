import { describe, expect, it } from "vitest";
import { validatePackContent, validatePackManifest } from "@longhub/pack-schema";
import { createMockAdapter } from "@longhub/xiaolongxia-adapter";
import { createJdDraftSkill } from "../src/agent-skill.js";
import { buildHrPackSource } from "../src/pack.js";
import { offerLetter, resumeScreen } from "../src/skills.js";

const ctx = { taskId: "t-1", grantedPermissions: [] as string[] };

describe("简历初筛", () => {
  it("全命中 → pass", async () => {
    const result = await resumeScreen.run(
      {
        requiredKeywords: ["TypeScript", "React", "招聘"],
        resumeText: "精通 typescript 与 react，五年招聘经验",
      },
      ctx,
    );
    expect(result).toEqual({
      score: 100,
      matched: ["typescript", "react", "招聘"],
      missing: [],
      recommendation: "pass",
    });
  });

  it("部分命中 → review，未命中 → reject", async () => {
    const half = await resumeScreen.run(
      { requiredKeywords: ["java", "python"], resumeText: "熟悉 java" },
      ctx,
    );
    expect(half.recommendation).toBe("review");
    expect(half.missing).toEqual(["python"]);

    const none = await resumeScreen.run(
      { requiredKeywords: ["golang"], resumeText: "熟悉 java" },
      ctx,
    );
    expect(none).toMatchObject({ score: 0, recommendation: "reject" });
  });

  it("空关键词报错", async () => {
    await expect(
      resumeScreen.run({ requiredKeywords: ["  "], resumeText: "x" }, ctx),
    ).rejects.toThrow("requiredKeywords 不能为空");
  });
});

describe("录用通知书", () => {
  it("生成包含关键信息的通知书", async () => {
    const { letter } = await offerLetter.run(
      { candidateName: "张三", position: "招聘专员", monthlySalaryCny: 15000, startDate: "2026-08-01" },
      ctx,
    );
    expect(letter).toContain("张三");
    expect(letter).toContain("招聘专员");
    expect(letter).toContain("15000");
    expect(letter).toContain("2026-08-01");
  });

  it("非法输入报错", async () => {
    await expect(
      offerLetter.run(
        { candidateName: "张三", position: "x", monthlySalaryCny: -1, startDate: "2026-08-01" },
        ctx,
      ),
    ).rejects.toThrow("非法月薪");
    await expect(
      offerLetter.run(
        { candidateName: "张三", position: "x", monthlySalaryCny: 1, startDate: "8月1日" },
        ctx,
      ),
    ).rejects.toThrow("YYYY-MM-DD");
  });

  it("写类权限需要人工确认（声明为 write）", () => {
    expect(offerLetter.permissions).toContain("connector:hr-api:write");
  });
});

describe("JD 起草（底座智能体技能）", () => {
  it("经适配层流式生成完整 JD", async () => {
    const adapter = createMockAdapter();
    await adapter.init();
    const skill = createJdDraftSkill(async () => adapter);
    const { jd } = await skill.run(
      { position: "资深前端工程师", mustHaves: ["TypeScript", "React"] },
      ctx,
    );
    expect(jd).toContain("资深前端工程师");
    expect(jd).toContain("TypeScript、React");
    expect(skill.level).toBe("L2");
  });

  it("空岗位名报错", async () => {
    const skill = createJdDraftSkill(async () => createMockAdapter());
    await expect(skill.run({ position: " ", mustHaves: [] }, ctx)).rejects.toThrow("position 不能为空");
  });
});

describe("套装制品源", () => {
  it("manifest 通过冻结契约校验", () => {
    const source = buildHrPackSource("1.0.0");
    const validated = validatePackManifest(source.manifest);
    expect(validated.ok).toBe(true);
    const content = validatePackContent(source.manifest, source.files);
    expect(content.ok).toBe(true);
    if (content.ok) {
      expect(content.profile.capabilities[0]?.skillIds).toContain("longhub.skill.resume-screen");
      expect(content.profile.capabilities[0]?.skillIds).toContain("longhub.skill.jd-draft");
      expect(content.profile.modelPolicyId).toBe("longhub.model.default");
    }
  });
});
