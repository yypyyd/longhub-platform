import { bootstrapExecutorServer, type CloudSkill } from "./server.js";

export { createExecutorServer } from "./server.js";
export {
  bootstrapExecutorServer,
  computeExecutorInputDigest,
  getDevelopmentExecutorCredentialKey,
  issueExecutorCredential,
  parseExecutorCredentialKey,
  parseExecutorCredentialTrustedKeys,
  parseExecutorBindHost,
  parseExecutorPort,
  verifyExecutorCredential,
  EXECUTOR_CREDENTIAL_HEADER,
  EXECUTOR_CREDENTIAL_MAX_TTL_MS,
  EXECUTOR_REQUEST_SCHEMA,
  SkillInputError,
  type CloudSkill,
  type CloudSkillContext,
  type ExecutorServerOptions,
  type ExecutorCredentialClaims,
  type ExecutorCredentialKey,
} from "./server.js";

export function bootstrap(
  port?: number,
  skills?: ReadonlyMap<string, CloudSkill>,
): void {
  bootstrapExecutorServer(port, undefined, undefined, skills);
}
