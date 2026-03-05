import * as restate from "@restatedev/restate-sdk";

export const workerService = restate.service({
  name: "workerService",
  handlers: {
    runTask: async (
      ctx: restate.Context,
      input: { taskId: string; payload: string },
    ) => {
      return await ctx.run("execute-task", async () => {
        return {
          taskId: input.taskId,
          payload: input.payload,
          completedAt: new Date().toISOString(),
        };
      });
    },
  },
});

export const orchestratorService = restate.service({
  name: "orchestratorService",
  handlers: {
    runBatch: async (ctx: restate.Context, tasks: string[]) => {
      const results = await Promise.all(
        tasks.map((task, index) =>
          ctx.serviceClient(workerService).runTask({
            taskId: `task-${index + 1}`,
            payload: task,
          }),
        ),
      );

      return await ctx.run("summarize-results", () => ({
        taskCount: tasks.length,
        completedCount: results.length,
        results,
      }));
    },
  },
});

export const approvalWorkflow = restate.workflow({
  name: "approvalWorkflow",
  handlers: {
    run: async (ctx: restate.WorkflowContext, request: string) => {
      await ctx.run("capture-request", () => ({
        request,
        createdAt: new Date().toISOString(),
      }));

      const decision = await ctx.promise<string>("approval-decision");

      return await ctx.run("finalize", () => ({
        request,
        decision,
      }));
    },

    approve: async (ctx: restate.WorkflowSharedContext, decision: string) => {
      await ctx.promise<string>("approval-decision").resolve(`approved:${decision}`);
    },

    reject: async (ctx: restate.WorkflowSharedContext, reason: string) => {
      await ctx.promise<string>("approval-decision").resolve(`rejected:${reason}`);
    },
  },
});

export const services = [workerService, orchestratorService, approvalWorkflow];
