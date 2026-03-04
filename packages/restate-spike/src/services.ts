import * as restate from "@restatedev/restate-sdk";

export const greeter = restate.service({
  name: "greeter",
  handlers: {
    greet: async (ctx: restate.Context, name: string) => {
      const id = ctx.rand.uuidv4();
      await ctx.run("step-1", () => {
        console.log(`Hello ${name}, id: ${id}`);
      });
      await ctx.sleep({ seconds: 1 });
      await ctx.run("step-2", () => {
        console.log(`Reminder for ${name}`);
      });
      return `Greeted ${name}`;
    },
  },
});

export const worker = restate.service({
  name: "worker",
  handlers: {
    doWork: async (
      ctx: restate.Context,
      input: { task: string; index: number },
    ) => {
      await ctx.run("execute", () => {
        console.log(`Worker executing: ${input.task}`);
        return `done-${input.index}`;
      });
      return `completed-${input.task}`;
    },
  },
});

export const orchestrator = restate.service({
  name: "orchestrator",
  handlers: {
    fanOut: async (ctx: restate.Context, tasks: string[]) => {
      const results = await Promise.all(
        tasks.map((task, i) => ctx.serviceClient(worker).doWork({ task, index: i })),
      );
      const summary = await ctx.run("synthesize", () =>
        results.map((r) => `Result: ${r}`).join(", "),
      );
      return summary;
    },
  },
});

export const approvalWorkflow = restate.workflow({
  name: "approvalWorkflow",
  handlers: {
    run: async (ctx: restate.WorkflowContext, request: string) => {
      await ctx.run("submit", () => {
        console.log(`Submitted: ${request}`);
      });

      const decision = await ctx.promise<string>("approval-decision");

      await ctx.run("finalize", () => {
        console.log(`Decision for ${request}: ${decision}`);
      });

      return { request, decision };
    },
    approve: async (ctx: restate.WorkflowSharedContext, decision: string) => {
      await ctx.promise<string>("approval-decision").resolve(decision);
    },
    reject: async (ctx: restate.WorkflowSharedContext, reason: string) => {
      await ctx
        .promise<string>("approval-decision")
        .resolve(`rejected: ${reason}`);
    },
  },
});

export const services = [greeter, orchestrator, worker, approvalWorkflow];
