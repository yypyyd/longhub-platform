import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createCloudApiServer } from "../src/server.js";
import { MemoryStore } from "../src/memory-store.js";
import type { CloudTask, CloudTaskStatus } from "../src/store.js";

class DelayedClaimStore extends MemoryStore {
  readonly claimStarted: Promise<void>;
  private readonly releaseClaimWait: Promise<void>;
  private resolveClaimStarted!: () => void;
  private resolveClaimWait!: () => void;

  constructor() {
    super();
    this.claimStarted = new Promise<void>((resolve) => {
      this.resolveClaimStarted = resolve;
    });
    this.releaseClaimWait = new Promise<void>((resolve) => {
      this.resolveClaimWait = resolve;
    });
  }

  releaseClaim(): void {
    this.resolveClaimWait();
  }

  override async claimPendingTask(taskId: string) {
    this.resolveClaimStarted();
    await this.releaseClaimWait;
    return super.claimPendingTask(taskId);
  }
}

class DelayedCompletionStore extends MemoryStore {
  readonly completionStarted: Promise<void>;
  private readonly releaseCompletionWait: Promise<void>;
  private resolveCompletionStarted!: () => void;
  private resolveCompletionWait!: () => void;

  constructor() {
    super();
    this.completionStarted = new Promise<void>((resolve) => {
      this.resolveCompletionStarted = resolve;
    });
    this.releaseCompletionWait = new Promise<void>((resolve) => {
      this.resolveCompletionWait = resolve;
    });
  }

  releaseCompletion(): void {
    this.resolveCompletionWait();
  }

  override async transitionIfStatus(
    taskId: string,
    expectedStatuses: readonly CloudTaskStatus[],
    status: CloudTaskStatus,
    patch?: Partial<CloudTask>,
  ): Promise<CloudTask | undefined> {
    if (status === "succeeded") {
      this.resolveCompletionStarted();
      await this.releaseCompletionWait;
    }
    return super.transitionIfStatus(taskId, expectedStatuses, status, patch);
  }
}

class PreflightPausedStore extends MemoryStore {
  readonly preflightStarted: Promise<void>;
  private readonly releasePreflightWait: Promise<void>;
  private resolvePreflightStarted!: () => void;
  private resolvePreflightWait!: () => void;
  private claimed = false;
  private paused = false;

  constructor() {
    super();
    this.preflightStarted = new Promise<void>((resolve) => {
      this.resolvePreflightStarted = resolve;
    });
    this.releasePreflightWait = new Promise<void>((resolve) => {
      this.resolvePreflightWait = resolve;
    });
  }

  releasePreflight(): void {
    this.resolvePreflightWait();
  }

  override async claimPendingTask(taskId: string): Promise<CloudTask | undefined> {
    const task = await super.claimPendingTask(taskId);
    if (task) this.claimed = true;
    return task;
  }

  override async listFeaturePolicies() {
    const policies = await super.listFeaturePolicies();
    if (this.claimed && !this.paused) {
      this.paused = true;
      this.resolvePreflightStarted();
      await this.releasePreflightWait;
    }
    return policies;
  }
}

class FailingTaskStateReadStore extends MemoryStore {
  readonly stateReadFailed: Promise<void>;
  private resolveStateReadFailed!: () => void;
  private failNextRead = false;

  constructor() {
    super();
    this.stateReadFailed = new Promise<void>((resolve) => {
      this.resolveStateReadFailed = resolve;
    });
  }

  override async claimPendingTask(taskId: string): Promise<CloudTask | undefined> {
    const task = await super.claimPendingTask(taskId);
    if (task) this.failNextRead = true;
    return task;
  }

  override async getTask(taskId: string): Promise<CloudTask | undefined> {
    if (this.failNextRead) {
      this.failNextRead = false;
      this.resolveStateReadFailed();
      throw new Error("simulated task state read failure");
    }
    return super.getTask(taskId);
  }
}

class ThrowAfterCancelCommitStore extends MemoryStore {
  override async transitionIfStatus(
    taskId: string,
    expectedStatuses: readonly CloudTaskStatus[],
    status: CloudTaskStatus,
    patch?: Partial<CloudTask>,
  ): Promise<CloudTask | undefined> {
    const task = await super.transitionIfStatus(taskId, expectedStatuses, status, patch);
    if (task && status === "cancelled") {
      throw new Error("simulated event persistence failure after cancellation commit");
    }
    return task;
  }
}

describe("Cloud task pending→running claim", () => {
  it("does not resurrect a task cancelled while the worker is waiting to claim", async () => {
    let executorCalls = 0;
    const executor = createServer((_req, res) => {
      executorCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: { unexpected: true } }));
    }).listen(0);
    await once(executor, "listening");

    const store = new DelayedClaimStore();
    const api = createCloudApiServer({
      executorUrl: `http://127.0.0.1:${(executor.address() as AddressInfo).port}`,
      store,
      allowDevelopmentTasks: true,
    }).listen(0);
    await once(api, "listening");
    const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    try {
      const registered = await fetch(`${baseUrl}/v1/devices/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: "openclaw-plugin-windows",
          app_version: "1.0.0",
          device_fingerprint: `claim-race-${Date.now()}`,
        }),
      });
      expect(registered.status).toBe(201);
      const { device_token: deviceToken } = await registered.json() as { device_token: string };
      const auth = {
        authorization: `Bearer ${deviceToken}`,
        "x-longhub-agent-id": "agent-claim-race",
      };

      const createdResponse = await fetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "idempotency-key": "claim-race-task" },
        body: JSON.stringify({
          schema_version: "longhub/cloud-skill-call/v1",
          request_id: "claim-race-request",
          kind: "skill.execute",
          skill_id: "longhub.skill.claim-race",
          skill_version: "1.0.0",
          agent_id: "agent-claim-race",
          tool_call_id: "call-claim-race",
          session_key_hash: "0".repeat(64),
          idempotency_key: "claim-race-task",
          input: { value: "race" },
        }),
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { task_id: string; status: string };
      expect(created.status).toBe("pending");

      // The worker has entered the storage claim but is paused before its CAS.
      await store.claimStarted;
      const cancelResponse = await fetch(`${baseUrl}/v1/tasks/${created.task_id}/cancel`, {
        method: "POST",
        headers: auth,
      });
      expect(cancelResponse.status).toBe(202);
      expect((await cancelResponse.json() as { status: string }).status).toBe("cancelled");

      store.releaseClaim();
      let final: { status: string } | undefined;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await fetch(`${baseUrl}/v1/tasks/${created.task_id}`, { headers: auth });
        final = await response.json() as { status: string };
        if (final.status === "cancelled") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(final?.status).toBe("cancelled");
      expect(executorCalls).toBe(0);
      expect((await store.eventsAfter(created.task_id)).map((event) => event.type)).toEqual([
        "task.accepted",
        "task.cancelled",
      ]);
    } finally {
      store.releaseClaim();
      api.close();
      executor.close();
    }
  });

  it("returns no claim after a cancellation and emits no started event in memory CAS", async () => {
    const store = new MemoryStore();
    const { task } = await store.createTask(
      "claim-cancelled",
      "skill.execute",
      { value: 1 },
      { tenant_id: "tenant", device_id: "device", agent_id: "agent" },
    );
    await store.transition(task.task_id, "cancelled");
    expect(await store.claimPendingTask(task.task_id)).toBeUndefined();
    expect((await store.getTask(task.task_id))?.status).toBe("cancelled");
    expect((await store.eventsAfter(task.task_id)).map((event) => event.type)).toEqual([
      "task.accepted",
      "task.cancelled",
    ]);
  });

  it("does not let a worker completion overwrite cancellation", async () => {
    let executorCalls = 0;
    const executor = createServer((_req, res) => {
      executorCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: { ok: true } }));
    }).listen(0);
    await once(executor, "listening");

    const store = new DelayedCompletionStore();
    const api = createCloudApiServer({
      executorUrl: `http://127.0.0.1:${(executor.address() as AddressInfo).port}`,
      store,
      allowDevelopmentTasks: true,
    }).listen(0);
    await once(api, "listening");
    const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    try {
      const registered = await fetch(`${baseUrl}/v1/devices/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: "openclaw-plugin-windows",
          app_version: "1.0.0",
          device_fingerprint: `completion-race-${Date.now()}`,
        }),
      });
      expect(registered.status).toBe(201);
      const { device_token: deviceToken } = await registered.json() as { device_token: string };
      const auth = {
        authorization: `Bearer ${deviceToken}`,
        "x-longhub-agent-id": "agent-completion-race",
      };

      const createdResponse = await fetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "idempotency-key": "completion-race-task" },
        body: JSON.stringify({
          schema_version: "longhub/cloud-skill-call/v1",
          request_id: "completion-race-request",
          kind: "skill.execute",
          skill_id: "longhub.skill.completion-race",
          skill_version: "1.0.0",
          agent_id: "agent-completion-race",
          tool_call_id: "call-completion-race",
          session_key_hash: "0".repeat(64),
          idempotency_key: "completion-race-task",
          input: { value: "race" },
        }),
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { task_id: string; status: string };
      expect(created.status).toBe("running");

      // The executor response is complete, but the worker is paused at the
      // running→succeeded CAS. Cancellation must win that storage race.
      await store.completionStarted;
      const cancelResponse = await fetch(`${baseUrl}/v1/tasks/${created.task_id}/cancel`, {
        method: "POST",
        headers: auth,
      });
      expect(cancelResponse.status).toBe(202);
      expect((await cancelResponse.json() as { status: string }).status).toBe("cancelled");

      store.releaseCompletion();
      let final: { status: string } | undefined;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await fetch(`${baseUrl}/v1/tasks/${created.task_id}`, { headers: auth });
        final = await response.json() as { status: string };
        if (final.status === "cancelled") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(final?.status).toBe("cancelled");
      expect(executorCalls).toBe(1);
      expect((await store.eventsAfter(created.task_id)).map((event) => event.type)).toEqual([
        "task.accepted",
        "task.started",
        "task.cancelled",
      ]);
    } finally {
      store.releaseCompletion();
      api.close();
      executor.close();
    }
  });

  it("aborts a worker cancelled during preflight before crossing Executor", async () => {
    let executorCalls = 0;
    const executor = createServer((_req, res) => {
      executorCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: { unexpected: true } }));
    }).listen(0);
    await once(executor, "listening");

    const store = new PreflightPausedStore();
    const api = createCloudApiServer({
      executorUrl: `http://127.0.0.1:${(executor.address() as AddressInfo).port}`,
      store,
      allowDevelopmentTasks: true,
    }).listen(0);
    await once(api, "listening");
    const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    try {
      const registered = await fetch(`${baseUrl}/v1/devices/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: "openclaw-plugin-windows",
          app_version: "1.0.0",
          device_fingerprint: `preflight-race-${Date.now()}`,
        }),
      });
      expect(registered.status).toBe(201);
      const { device_token: deviceToken } = await registered.json() as { device_token: string };
      const auth = {
        authorization: `Bearer ${deviceToken}`,
        "x-longhub-agent-id": "agent-preflight-race",
      };

      const createdResponse = await fetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "idempotency-key": "preflight-race-task" },
        body: JSON.stringify({
          schema_version: "longhub/cloud-skill-call/v1",
          request_id: "preflight-race-request",
          kind: "skill.execute",
          skill_id: "longhub.skill.preflight-race",
          skill_version: "1.0.0",
          agent_id: "agent-preflight-race",
          tool_call_id: "call-preflight-race",
          session_key_hash: "0".repeat(64),
          idempotency_key: "preflight-race-task",
          input: { value: "race" },
        }),
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { task_id: string; status: string };
      expect(created.status).toBe("running");

      // Pause inside the worker's policy preflight after it has claimed the
      // task and registered its AbortController. Cancellation should abort the
      // preflight and prevent any private Executor request.
      await store.preflightStarted;
      const cancelResponse = await fetch(`${baseUrl}/v1/tasks/${created.task_id}/cancel`, {
        method: "POST",
        headers: auth,
      });
      expect(cancelResponse.status).toBe(202);
      expect((await cancelResponse.json() as { status: string }).status).toBe("cancelled");

      store.releasePreflight();
      let final: { status: string } | undefined;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await fetch(`${baseUrl}/v1/tasks/${created.task_id}`, { headers: auth });
        final = await response.json() as { status: string };
        if (final.status === "cancelled") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(final?.status).toBe("cancelled");
      expect(executorCalls).toBe(0);
      expect((await store.eventsAfter(created.task_id)).map((event) => event.type)).toEqual([
        "task.accepted",
        "task.started",
        "task.cancelled",
      ]);
    } finally {
      store.releasePreflight();
      api.close();
      executor.close();
    }
  });

  it("fails a claimed task closed when the state read fails", async () => {
    let executorCalls = 0;
    const executor = createServer((_req, res) => {
      executorCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: { unexpected: true } }));
    }).listen(0);
    await once(executor, "listening");

    const store = new FailingTaskStateReadStore();
    const api = createCloudApiServer({
      executorUrl: `http://127.0.0.1:${(executor.address() as AddressInfo).port}`,
      store,
      allowDevelopmentTasks: true,
    }).listen(0);
    await once(api, "listening");
    const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    try {
      const registered = await fetch(`${baseUrl}/v1/devices/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: "openclaw-plugin-windows",
          app_version: "1.0.0",
          device_fingerprint: `state-read-failure-${Date.now()}`,
        }),
      });
      expect(registered.status).toBe(201);
      const { device_token: deviceToken } = await registered.json() as { device_token: string };
      const auth = {
        authorization: `Bearer ${deviceToken}`,
        "x-longhub-agent-id": "agent-state-read-failure",
      };

      const createdResponse = await fetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "idempotency-key": "state-read-failure-task" },
        body: JSON.stringify({
          schema_version: "longhub/cloud-skill-call/v1",
          request_id: "state-read-failure-request",
          kind: "skill.execute",
          skill_id: "longhub.skill.state-read-failure",
          skill_version: "1.0.0",
          agent_id: "agent-state-read-failure",
          tool_call_id: "call-state-read-failure",
          session_key_hash: "0".repeat(64),
          idempotency_key: "state-read-failure-task",
          input: { value: "state" },
        }),
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { task_id: string };
      await store.stateReadFailed;

      let final: { status: string; error?: { code: string; retryable: boolean } } | undefined;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await fetch(`${baseUrl}/v1/tasks/${created.task_id}`, { headers: auth });
        final = await response.json() as typeof final;
        if (final.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(final).toMatchObject({
        status: "failed",
        error: { code: "TASK_STATE_UNAVAILABLE", retryable: true },
      });
      expect(executorCalls).toBe(0);
      expect((await store.eventsAfter(created.task_id)).map((event) => event.type)).toEqual([
        "task.accepted",
        "task.started",
        "task.failed",
      ]);
    } finally {
      api.close();
      executor.close();
    }
  });

  it("aborts the local worker when cancellation committed before event persistence failed", async () => {
    let resolveExecutorStarted!: () => void;
    const executorStarted = new Promise<void>((resolve) => {
      resolveExecutorStarted = resolve;
    });
    let resolveExecutorClosed!: () => void;
    const executorClosed = new Promise<void>((resolve) => {
      resolveExecutorClosed = resolve;
    });
    const executor = createServer((request) => {
      resolveExecutorStarted();
      request.once("close", resolveExecutorClosed);
      // Keep the response open until the Cloud API cancellation signal aborts
      // the request or the test closes the server.
    }).listen(0);
    await once(executor, "listening");

    const store = new ThrowAfterCancelCommitStore();
    const api = createCloudApiServer({
      executorUrl: `http://127.0.0.1:${(executor.address() as AddressInfo).port}`,
      store,
      allowDevelopmentTasks: true,
      executorRequestTimeoutMs: 5_000,
    }).listen(0);
    await once(api, "listening");
    const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    try {
      const registered = await fetch(`${baseUrl}/v1/devices/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: "openclaw-plugin-windows",
          app_version: "1.0.0",
          device_fingerprint: `cancel-event-failure-${Date.now()}`,
        }),
      });
      expect(registered.status).toBe(201);
      const { device_token: deviceToken } = await registered.json() as { device_token: string };
      const auth = {
        authorization: `Bearer ${deviceToken}`,
        "x-longhub-agent-id": "agent-cancel-event-failure",
      };

      const createdResponse = await fetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "idempotency-key": "cancel-event-failure-task" },
        body: JSON.stringify({
          schema_version: "longhub/cloud-skill-call/v1",
          request_id: "cancel-event-failure-request",
          kind: "skill.execute",
          skill_id: "longhub.skill.cancel-event-failure",
          skill_version: "1.0.0",
          agent_id: "agent-cancel-event-failure",
          tool_call_id: "call-cancel-event-failure",
          session_key_hash: "0".repeat(64),
          idempotency_key: "cancel-event-failure-task",
          input: { value: "cancel" },
        }),
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { task_id: string };
      await executorStarted;

      const cancelled = await fetch(`${baseUrl}/v1/tasks/${created.task_id}/cancel`, {
        method: "POST",
        headers: auth,
      });
      expect(cancelled.status).toBe(202);
      expect(await cancelled.json()).toMatchObject({ status: "cancelled" });

      await Promise.race([
        executorClosed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("executor request was not aborted")), 1_000)),
      ]);
      expect(await store.getTask(created.task_id)).toMatchObject({ status: "cancelled" });
      expect((await store.eventsAfter(created.task_id)).map((event) => event.type)).toEqual([
        "task.accepted",
        "task.started",
        "task.cancelled",
      ]);
    } finally {
      api.close();
      executor.close();
    }
  });
});
