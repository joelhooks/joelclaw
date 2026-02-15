import { Inngest, EventSchemas } from "inngest";

// System event types
type Events = {
  // --- Video pipeline ---
  "pipeline/video.download": {
    data: {
      url: string;
      maxQuality?: string;
    };
  };
  "pipeline/video.downloaded": {
    data: {
      slug: string;
      title: string;
      channel: string;
      duration: string;
      nasPath: string;
      tmpDir: string;
      sourceUrl: string;
      publishedDate: string;
    };
  };

  // --- Transcript pipeline (multi-source) ---
  "pipeline/transcript.process": {
    data: {
      /** "youtube" | "granola" | "fathom" | "podcast" | "manual" */
      source: string;
      /** Path to audio/video file — runs mlx-whisper */
      audioPath?: string;
      /** Raw transcript text — used directly, no whisper */
      text?: string;
      title: string;
      slug: string;
      channel?: string;
      publishedDate?: string;
      duration?: string;
      sourceUrl?: string;
      nasPath?: string;
      /** Tmp dir to clean up after processing */
      tmpDir?: string;
    };
  };
  "pipeline/transcript.processed": {
    data: {
      vaultPath: string;
      title: string;
      slug: string;
      source: string;
    };
  };

  // --- Content enrichment ---
  "content/summarize": {
    data: {
      vaultPath: string;
      prompt?: string;
    };
  };
  "content/summarized": {
    data: {
      vaultPath: string;
      title: string;
    };
  };

  // --- Book pipeline ---
  "pipeline/book.download": {
    data: {
      query: string;
      format?: string;
    };
  };
  "pipeline/book.downloaded": {
    data: {
      title: string;
      author: string;
      nasPath: string;
    };
  };

  // --- Agent Loop pipeline (ADR-0005) ---
  "agent/loop.start": {
    data: {
      loopId: string;
      project: string;
      prdPath: string;
      maxRetries?: number;
      maxIterations?: number;
      retryLadder?: ("codex" | "claude" | "pi")[];
      push?: boolean;
      toolAssignments?: Record<
        string,
        {
          implementor: "codex" | "claude" | "pi";
          reviewer: "claude" | "pi";
        }
      >;
    };
  };
  "agent/loop.plan": {
    data: {
      loopId: string;
      project: string;
      prdPath: string;
      maxIterations?: number;
      maxRetries?: number;
      retryLadder?: ("codex" | "claude" | "pi")[];
    };
  };
  "agent/loop.test": {
    data: {
      loopId: string;
      project: string;
      storyId: string;
      runToken?: string;
      tool: "codex" | "claude" | "pi";
      attempt: number;
      story: {
        id: string;
        title: string;
        description: string;
        acceptance_criteria: string[];
      };
      maxRetries: number;
      maxIterations?: number;
      retryLadder?: ("codex" | "claude" | "pi")[];
      storyStartedAt?: number;
    };
  };
  "agent/loop.implement": {
    data: {
      loopId: string;
      project: string;
      storyId: string;
      runToken?: string;
      tool: "codex" | "claude" | "pi";
      attempt: number;
      feedback?: string;
      story: {
        id: string;
        title: string;
        description: string;
        acceptance_criteria: string[];
      };
      maxRetries: number;
      maxIterations?: number;
      retryLadder?: ("codex" | "claude" | "pi")[];
      freshTests?: boolean;
      storyStartedAt?: number;
      testFiles?: string[];
    };
  };
  "agent/loop.review": {
    data: {
      loopId: string;
      project: string;
      storyId: string;
      runToken?: string;
      commitSha: string;
      attempt: number;
      tool: "claude" | "pi";
      story: {
        id: string;
        title: string;
        description: string;
        acceptance_criteria: string[];
      };
      maxRetries: number;
      maxIterations?: number;
      storyStartedAt?: number;
      retryLadder?: ("codex" | "claude" | "pi")[];
      freshTests?: boolean;
      priorFeedback?: string;
    };
  };
  "agent/loop.judge": {
    data: {
      loopId: string;
      project: string;
      prdPath: string;
      storyId: string;
      runToken?: string;
      testResults: {
        testsPassed: number;
        testsFailed: number;
        typecheckOk: boolean;
        lintOk: boolean;
        details: string;
      };
      feedback: string;
      reviewerNotes?: {
        questions: Array<{
          id: string;
          answer: boolean;
          evidence: string;
        }>;
        testResults: {
          typecheckOk: boolean;
          typecheckOutput: string;
          lintOk: boolean;
          lintOutput: string;
          testsPassed: number;
          testsFailed: number;
          testOutput: string;
        };
      };
      attempt: number;
      maxRetries: number;
      maxIterations?: number;
      storyStartedAt?: number;
      retryLadder?: ("codex" | "claude" | "pi")[];
      priorFeedback?: string;
      story: {
        id: string;
        title: string;
        description: string;
        acceptance_criteria: string[];
      };
      tool: "codex" | "claude" | "pi";
    };
  };
  "agent/loop.cancel": {
    data: {
      loopId: string;
      reason: string;
    };
  };
  "agent/loop.complete": {
    data: {
      loopId: string;
      project: string;
      summary: string;
      storiesCompleted: number;
      storiesFailed: number;
      cancelled: boolean;
      branchName?: string;
      pushResult?: string;
    };
  };
  "agent/loop.story.pass": {
    data: {
      loopId: string;
      storyId: string;
      commitSha: string;
      attempt: number;
      duration: number;
    };
  };
  "agent/loop.story.fail": {
    data: {
      loopId: string;
      storyId: string;
      reason: string;
      attempts: number;
      duration?: number;
    };
  };
  "agent/loop.retro.complete": {
    data: {
      loopId?: string;
      project?: string;
      retrospective?: {
        loopId?: string;
        project?: string;
        summary?: string;
        storiesCompleted?: number;
        storiesFailed?: number;
        storiesSkipped?: number;
        cancelled?: boolean;
        branchName?: string;
        storyDetails?: Array<{
          id?: string;
          title?: string;
          passed?: boolean;
          skipped?: boolean;
          attempts?: number;
          tool?: string;
        }>;
        codebasePatterns?: string;
        totalDurationEstimate?: number;
      };
    };
  };

  // --- System ---
  "system/log": {
    data: {
      action: string;
      tool: string;
      detail: string;
      reason?: string;
    };
  };
  "system/health.check": {
    data: {
      component?: string;
    };
  };

  // --- Legacy (forwards to pipeline/video.download) ---
  "pipeline/video.ingest": {
    data: {
      url: string;
      maxQuality?: string;
    };
  };
  "pipeline/video.ingested": {
    data: {
      slug: string;
      title: string;
      channel: string;
      duration: string;
      vaultPath: string;
      nasPath: string;
    };
  };
};

export const inngest = new Inngest({
  id: "system-bus",
  schemas: new EventSchemas().fromRecord<Events>(),
});
