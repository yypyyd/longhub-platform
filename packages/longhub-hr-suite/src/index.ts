/** HR 套装能力包入口。 */
export {
  hrLocalSkills,
  offerLetter,
  resumeScreen,
  type OfferLetterInput,
  type OfferLetterOutput,
  type ResumeScreenInput,
  type ResumeScreenOutput,
} from "./skills.js";
export {
  createJdDraftSkill,
  HR_AGENT_ID,
  type JdDraftInput,
  type JdDraftOutput,
} from "./agent-skill.js";
export { buildHrPackSource, HR_PACK_ID, type HrPackSource } from "./pack.js";
