import { Inngest, EventSchemas } from "inngest";
import { gatewayMiddleware } from "./middleware/gateway";

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
      /** Key moment screenshots extracted during download */
      screenshots?: { vaultDir: string; files: string[] };
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
      originSession?: string; // gateway session ID of the session that started this loop (ADR-0035)
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
      originSession?: string; // carried from loop.started (ADR-0035)
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

  // --- Agent approvals (ADR-0067) ---
  "agent/approval.requested": {
    data: {
      agent: string;
      category: string;
      operation: string;
      reasoning: string;
    };
  };
  "agent/approval.resolved": {
    data: {
      requestId: string;
      status: "approved" | "denied";
      reviewer: string;
      learn?: boolean;
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
      trigger: "shutdown" | "backfill";
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
  "memory/proposal.approved": {
    data: {
      proposalId: string;
      approvedBy: string;
    };
  };
  "memory/proposal.rejected": {
    data: {
      proposalId: string;
      reason: string;
      rejectedBy: string;
    };
  };
  // ADR-0067: Daily digest lifecycle events.
  "memory/digest.requested": {
    data: Record<string, never>;
  };
  "memory/digest.created": {
    data: {
      date: string;
      sourcePath: string;
      digestPath: string;
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
  "system/heartbeat.wake": {
    data: Record<string, never>;
  };
  "content/updated": {
    data: {
      source?: string; // "fswatch" | "agent" | "manual"
    };
  };

  // --- Background Agents (ADR-0026) ---
  "system/agent.requested": {
    data: {
      requestId: string;
      sessionId?: string;
      task: string;
      tool: "codex" | "claude" | "pi";
      cwd?: string;
      timeout?: number; // seconds, default 600 (10min)
      model?: string;
      sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    };
  };
  "system/agent.cancelled": {
    data: {
      requestId: string;
      reason?: string;
    };
  };
  "system/agent.completed": {
    data: {
      requestId: string;
      sessionId?: string;
      status: "completed" | "failed";
      task: string;
      tool: string;
      durationMs: number;
    };
  };

  // --- Backfill ---
  "memory/backfill.requested": {
    data: {
      minMessages?: number;
      sleepSeconds?: number;
      maxSessions?: number;
    };
  };
  "memory/backfill.cancelled": {
    data: {
      reason?: string;
    };
  };

  // --- Embedding ---
  "embedding/text.requested": {
    data: {
      texts: Array<{ id: string; text: string }>;
    };
  };

  // --- Media pipeline (ADR-0041) ---
  "media/received": {
    data: {
      source: "telegram" | "imessage" | "slack" | "cli";
      type: "image" | "audio" | "video" | "document";
      localPath: string;
      mimeType: string;
      fileName?: string;
      fileSize: number;
      caption?: string;
      originSession?: string;
      metadata?: {
        telegramFileId?: string;
        width?: number;
        height?: number;
        duration?: number;
      };
    };
  };
  "media/processed": {
    data: {
      source: string;
      type: string;
      localPath: string;
      description?: string;
      transcript?: string;
      archivePath?: string;
      originSession?: string;
    };
  };

  // --- Todoist (ADR-0047, ADR-0048) ---
  "todoist/comment.added": {
    data: {
      taskId: string;
      commentId: string;
      commentContent: string;
      taskContent: string;
      projectId: string;
      initiatorId: string;
    };
  };
  "todoist/task.completed": {
    data: {
      taskId: string;
      taskContent: string;
      taskDescription?: string;
      projectId: string;
      labels: string[];
    };
  };
  "todoist/task.created": {
    data: {
      taskId: string;
      taskContent: string;
      projectId: string;
      labels: string[];
    };
  };

  "todoist/task.deleted": {
    data: {
      taskId: string;
      taskContent: string;
      projectId: string;
      labels: string[];
    };
  };

  // --- Front ---
  "front/message.received": {
    data: {
      conversationId: string;
      messageId: string;
      from: string;
      fromName: string;
      to: string[];
      subject: string;
      body: string;
      bodyPlain: string;
      preview: string;
      isInbound: boolean;
      attachmentCount: number;
    };
  };
  "front/message.sent": {
    data: {
      conversationId: string;
      to: string[];
      subject: string;
    };
  };
  "front/assignee.changed": {
    data: {
      conversationId: string;
      assigneeEmail: string;
      assigneeName: string;
    };
  };

  // --- Granola / Meetings (ADR-0055, ADR-0056) ---
  "meeting/noted": {
    data: {
      meetingId: string;
      title: string;
      date?: string;
      participants?: string[];
      source?: "heartbeat" | "backfill" | "manual";
    };
  };
  "granola/backfill.requested": {
    data: {
      dryRun?: boolean;
      customRanges?: Array<{
        range: string;
        start?: string;
        end?: string;
        label: string;
      }>;
    };
  };

  // --- Heartbeat Fan-Out Checks (ADR-0062) ---
  "tasks/triage.requested": {
    data: {
      taskCount?: number;
    };
  };
  "sessions/prune.requested": {
    data: Record<string, never>;
  };
  "triggers/audit.requested": {
    data: Record<string, never>;
  };
  "system/health.requested": {
    data: {
      component?: string;
    };
  };
  "memory/friction.requested": {
    data: Record<string, never>;
  };
  "memory/friction.fix.requested": {
    data: {
      patternId: string;
      title: string;
      summary: string;
      suggestion: string;
      evidence: string[];
      todoistTaskId?: string;
    };
  };
  "memory/friction.fix.completed": {
    data: {
      patternId: string;
      status: "fixed" | "documented" | "skipped";
      commitSha?: string;
      filesChanged?: string[];
      message: string;
    };
  };
  "memory/review.check": {
    data: Record<string, never>;
  };
  "vault/sync.check": {
    data: Record<string, never>;
  };
  "granola/check.requested": {
    data: Record<string, never>;
  };
  "email/triage.requested": {
    data: Record<string, never>;
  };
  "calendar/daily.check": {
    data: Record<string, never>;
  };
  "loops/stale.check": {
    data: Record<string, never>;
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
  middleware: [gatewayMiddleware],
});
