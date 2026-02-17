import { Inngest, EventSchemas } from "inngest";

/**
 * ADR-0019: Event names describe what happened (past-tense), not commands.
 *
 * Agent Loop chain:
 *   started → story.dispatched → tests.written → code.committed
 *     → checks.completed → story.passed/failed/retried → completed
 *
 * Pipeline chain:
 *   video.requested → video.downloaded → transcript.requested
 *     → transcript.processed → summarize.requested → summarized
 */

// System event types
export type Events = {
  // --- Video pipeline ---
  "pipeline/video.requested": {
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
  "pipeline/transcript.requested": {
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
  "content/summarize.requested": {
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

  // --- Agent Loop pipeline (ADR-0005, ADR-0019) ---

  /** CLI started a loop → triggers planner */
  "agent/loop.started": {
    data: {
      loopId: string;
      project: string;
      workDir?: string;
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

  /** Planner picked next story → triggers test-writer */
  "agent/loop.story.dispatched": {
    data: {
      loopId: string;
      project: string;
      workDir?: string;
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

  /** Test-writer committed tests → triggers implementor */
  "agent/loop.tests.written": {
    data: {
      loopId: string;
      project: string;
      workDir?: string;
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

  /** Implementor committed code → triggers reviewer */
  "agent/loop.code.committed": {
    data: {
      loopId: string;
      project: string;
      workDir?: string;
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

  /** Reviewer ran checks + eval → triggers judge */
  "agent/loop.checks.completed": {
    data: {
      loopId: string;
      project: string;
      workDir?: string;
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

  /** Judge approved story → triggers planner (next story) */
  "agent/loop.story.passed": {
    data: {
      loopId: string;
      project: string;
      workDir?: string;
      prdPath: string;
      storyId: string;
      commitSha: string;
      attempt: number;
      duration: number;
      maxIterations?: number;
      maxRetries?: number;
      retryLadder?: ("codex" | "claude" | "pi")[];
    };
  };

  /** Judge rejected story (max retries) → triggers planner (next story) */
  "agent/loop.story.failed": {
    data: {
      loopId: string;
      project: string;
      workDir?: string;
      prdPath: string;
      storyId: string;
      reason: string;
      attempts: number;
      duration?: number;
      maxIterations?: number;
      maxRetries?: number;
      retryLadder?: ("codex" | "claude" | "pi")[];
    };
  };

  /** Judge wants retry → triggers implementor */
  "agent/loop.story.retried": {
    data: {
      loopId: string;
      project: string;
      workDir?: string;
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

  /** User cancelled loop → all functions check */
  "agent/loop.cancelled": {
    data: {
      loopId: string;
      reason: string;
    };
  };

  /** All stories done → triggers complete + retro */
  "agent/loop.completed": {
    data: {
      loopId: string;
      project: string;
      workDir?: string;
      summary: string;
      storiesCompleted: number;
      storiesFailed: number;
      cancelled: boolean;
      branchName?: string;
      pushResult?: string;
    };
  };

  /** Retro completed */
  "agent/loop.retro.completed": {
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

  // --- Memory ---
  "memory/session.compaction.pending": {
    data: {
      sessionId: string;
      dedupeKey: string;
      trigger: "compaction";
      messages: string;
      messageCount: number;
      tokensBefore: number;
      filesRead: string[];
      filesModified: string[];
      capturedAt: string;
      schemaVersion: 1;
    };
  };
  "memory/session.ended": {
    data: {
      sessionId: string;
      dedupeKey: string;
      trigger: "shutdown";
      messages: string;
      messageCount: number;
      userMessageCount: number;
      duration: number;
      sessionName?: string;
      filesRead: string[];
      filesModified: string[];
      capturedAt: string;
      schemaVersion: 1;
    };
  };
  "memory/observations.accumulated": {
    data: {
      date: string;
      totalTokens: number;
      observationCount: number;
      capturedAt: string;
    };
  };
  "memory/observations.reflected": {
    data: {
      date: string;
      inputTokens: number;
      outputTokens: number;
      compressionRatio: number;
      proposalCount: number;
      capturedAt: string;
    };
  };

  // --- Discovery ---
  "discovery/noted": {
    data: {
      url?: string;
      context?: string;
    };
  };
  "discovery/captured": {
    data: {
      vaultPath: string;
      topic: string;
      slug: string;
    };
  };

  // --- System ---
  "system/log.written": {
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
  "system/adr.sync.requested": {
    data: {
      reason?: string;
      requestedBy?: string;
    };
  };
  "content/updated": {
    data: {
      source?: string; // "fswatch" | "agent" | "manual"
    };
  };

  // --- Embedding ---
  "embedding/text.requested": {
    data: {
      texts: Array<{ id: string; text: string }>;
    };
  };

  // --- Legacy ---
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
