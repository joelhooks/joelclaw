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
  "transcript/web.fetched": {
    data: {
      url: string;
      title: string;
      channel?: string;
      sourceUrl?: string;
      type: "video" | "meeting";
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
      query?: string;
      md5?: string;
      format?: string;
      title?: string;
      reason?: string;
      outputDir?: string;
      tags?: string[];
      storageCategory?: string;
      idempotencyKey?: string;
    };
  };
  "pipeline/book.downloaded": {
    data: {
      title: string;
      author?: string;
      nasPath: string;
      md5?: string;
      query?: string;
      reason?: string;
      format?: string;
      outputDir?: string;
      selectedBy?: "provided" | "inference" | "fallback";
      tags?: string[];
    };
  };

  // --- Manifest archive pipeline ---
  "manifest/archive.requested": {
    data: {
      reason?: string;
      dryRun?: boolean;
      maxEntries?: number;
      manifestPath?: string;
      queueDocsIngest?: boolean;
      queueSkipped?: boolean;
    };
  };
  "manifest/archive.completed": {
    data: {
      dryRun: boolean;
      scanned: number;
      copied: number;
      wouldCopy: number;
      skipped: number;
      wouldSkip: number;
      failed: number;
      totalBytes: number;
      routing: {
        podcasts: number;
        books: {
          programming: number;
          business: number;
          education: number;
          design: number;
          other: number;
          uncategorized: number;
        };
      };
      maxEntries: number | null;
      manifestPath: string;
      docsQueue: {
        enabled: boolean;
        includeSkipped: boolean;
        considered: number;
        queueable: number;
        queued: number;
        batches: number;
        skippedUnsupported: number;
      };
      errorDetails: Array<{
        id: string;
        error?: string;
      }>;
    };
  };

  // --- Docs pipeline ---
  "docs/ingest.requested": {
    data: {
      nasPath: string;
      title?: string;
      tags?: string[];
      storageCategory?: string;
      sourceHost?: string;
      idempotencyKey?: string;
    };
  };
  "docs/ingest.completed": {
    data: {
      docId: string;
      title: string;
      nasPath: string;
      storageCategory: string;
      primaryConceptId: string;
      conceptIds: string[];
      taxonomyVersion: string;
      chunksIndexed: number;
      sectionChunks: number;
      snippetChunks: number;
    };
  };
  "docs/enrich.requested": {
    data: {
      docId: string;
    };
  };
  "docs/reindex.requested": {
    data: {
      docId?: string;
    };
  };
  "docs/backlog.requested": {
    data: {
      manifestPath?: string;
      maxEntries?: number;
      booksOnly?: boolean;
      onlyMissing?: boolean;
      includePodcasts?: boolean;
      idempotencyPrefix?: string;
    };
  };
  "docs/backlog.drive.requested": {
    data: {
      force?: boolean;
      reason?: string;
      maxEntries?: number;
      maxRunning?: number;
      maxQueued?: number;
      lookbackHours?: number;
      booksOnly?: boolean;
      onlyMissing?: boolean;
      includePodcasts?: boolean;
      idempotencyPrefix?: string;
    };
  };
  "docs/ingest.janitor.requested": {
    data: {
      reason?: string;
      lookbackHours?: number;
      scanLimit?: number;
      staleMinutes?: number;
      maxRecoveries?: number;
    };
  };
  "docs/search.requested": {
    data: {
      query: string;
      filters?: string;
      limit?: number;
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

  // --- Story Pipeline (ADR-0155) ---
  "agent/story.start": {
    data: {
      prdPath: string;
      storyId: string;
      cwd?: string;
      attempt?: number;
      judgment?: string;
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
  "session/observation.noted": {
    data: {
      observations: Array<{
        category: string;
        summary: string;
        metadata?: Record<string, unknown>;
      }>;
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
  "memory/proposal.created": {
    data: {
      proposalId: string;
      id: string;
      section: string;
      change: string;
      source?: string;
      timestamp?: string;
    };
  };
  "memory/proposal.triaged": {
    data: {
      proposalId: string;
      action: "auto-promote" | "auto-reject" | "auto-merge" | "needs-review" | "llm-pending";
      reason: string;
      mergeWith?: string;
      triagedAt: string;
    };
  };
  "memory/batch-review.requested": {
    data: {
      reason?: string;
    };
  };
  "memory/proposal.approved": {
    data: {
      proposalId: string;
      approvedBy: string;
      proposalContext?: Record<string, unknown>;
    };
  };
  "memory/proposal.rejected": {
    data: {
      proposalId: string;
      reason: string;
      rejectedBy: string;
      proposalContext?: Record<string, unknown>;
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
      url?: string;
      title?: string;
      tags?: string[];
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
      mode?: "core" | "signals" | "full";
      source?: string;
    };
  };
  "system/network.update": {
    data: {
      source?: string;
      checkedAt?: number;
    };
  };
  "system/self.healing.requested": {
    data: {
      sourceFunction?: string;
      targetComponent?: string;
      routeToFunction?: "system/backup.typesense" | "system/backup.redis" | string;
      targetEventName?: string;
      problemSummary?: string;
      attempt?: number;
      retryPolicy?: {
        maxRetries?: number;
        sleepMinMs?: number;
        sleepMaxMs?: number;
        sleepStepMs?: number;
      };
      evidence?: Array<{
        type: string;
        detail: string;
      }> | string[];
      context?: Record<string, unknown>;
      playbook?: {
        actions?: Array<string>;
        restart?: Array<string>;
        kill?: Array<string>;
        defer?: Array<string>;
        notify?: Array<string>;
        links?: Array<string>;
      };
      owner?: string;
      deadlineAt?: string;
      fallbackAction?: "escalate" | "manual";
      domain?: "sdk-reachability" | "backup" | "gateway-bridge" | "gateway-provider" | "otel-pipeline" | "all" | string;
      reason?: string;
      requestedBy?: string;
      lookbackMinutes?: number;
      maxRuns?: number;
      dryRun?: boolean;
    };
  };
  "system/self.healing.retry.requested": {
    data: {
      sourceFunction: string;
      targetComponent: string;
      problemSummary: string;
      attempt: number;
      nextAttempt: number;
      targetEventName: string;
      domain?: "sdk-reachability" | "backup" | "gateway-bridge" | "gateway-provider" | "otel-pipeline" | "all" | string;
      routeToFunction?: "system/backup.typesense" | "system/backup.redis" | string;
      targetFunctionId?: "system/backup.typesense" | "system/backup.redis";
      target?: "typesense" | "redis" | string;
      retryPolicy?: {
        maxRetries?: number;
        sleepMinMs?: number;
        sleepMaxMs?: number;
        sleepStepMs?: number;
      };
      evidence?: Array<{
        type: string;
        detail: string;
      }> | string[];
      context?: Record<string, unknown>;
      playbook?: {
        actions?: Array<string>;
        restart?: Array<string>;
        kill?: Array<string>;
        defer?: Array<string>;
        notify?: Array<string>;
        links?: Array<string>;
      };
      owner?: string;
      deadlineAt?: string;
      decision: {
        action: "retry" | "pause" | "escalate";
        delayMs: number;
        reason: string;
        confidence: number;
        model: string;
        routeToEventName?: string;
        routeToFunction?: string;
      };
      retryWindowMinutes?: number;
    };
  };
  "system/self.healing.completed": {
    data: {
      domain: string;
      status:
        | "noop"
        | "detected"
        | "remediated"
        | "invalid"
        | "scheduled"
        | "exhausted"
        | "escalated"
        | "blocked";
      sourceFunction?: string;
      targetComponent?: string;
      attempt?: number;
      nextAttempt?: number;
      action?: "retry" | "pause" | "escalate";
      reason?: string;
      delayMs?: number;
      routeToEventName?: string;
      routeToFunction?: "system/backup.typesense" | "system/backup.redis" | string;
      confidence?: number;
      model?: string;
      evidence?: Array<{
        type: string;
        detail: string;
      }> | string[];
      playbook?: {
        actions?: Array<string>;
        restart?: Array<string>;
        kill?: Array<string>;
        defer?: Array<string>;
        notify?: Array<string>;
        links?: Array<string>;
      };
      owner?: string;
      context?: Record<string, unknown>;
      eventId?: string;
      detected: number;
      inspected: number;
      dryRun?: boolean;
      remediationDetail?: string;
      sampleRunIds?: string[];
    };
  };
  "system/gateway.bridge.health.requested": {
    data: {
      sourceFunction?: string;
      targetComponent?: string;
      targetEventName?: string;
      routeToFunction?: string;
      attempt?: number;
      nextAttempt?: number;
      domain?: "gateway-bridge" | string;
      problemSummary?: string;
      retryPolicy?: {
        maxRetries?: number;
        sleepMinMs?: number;
        sleepMaxMs?: number;
        sleepStepMs?: number;
      };
      evidence?: Array<{
        type: string;
        detail: string;
      }> | string[];
      context?: Record<string, unknown>;
      playbook?: {
        actions?: Array<string>;
        restart?: Array<string>;
        kill?: Array<string>;
        defer?: Array<string>;
        notify?: Array<string>;
        links?: Array<string>;
      };
      owner?: string;
      deadlineAt?: string;
      requestedBy?: string;
      fallbackAction?: "escalate" | "manual";
      dryRun?: boolean;
    };
  };
  "system/backup.failure.detected": {
    data: {
      sourceFunction?: string;
      targetFunctionId?: "system/backup.typesense" | "system/backup.redis";
      target: "typesense" | "redis";
      error: string;
      backupFailureDetectedAt: string;
      attempt: number;
      transportMode?: "local" | "remote";
      transportAttempts?: number;
      transportDestination?: string;
      retryWindowHours?: number;
      context?: Record<string, unknown>;
      selfHealingPayload?: {
        sourceComponent?: string;
        problemSummary?: string;
      };
    };
  };
  "system/backup.retry.requested": {
    data: {
      targetFunctionId: "system/backup.typesense" | "system/backup.redis";
      target: "typesense" | "redis";
      error?: string;
      backupFailureDetectedAt?: string;
      attempt: number;
      nextAttempt?: number;
      transportMode?: "local" | "remote";
      transportAttempts?: number;
      transportDestination?: string;
      retryWindowHours?: number;
      decision?: {
        action: "retry" | "pause" | "escalate";
        delayMs: number;
        reason: string;
        confidence: number;
        model: string;
        routeTo: "system/backup.typesense" | "system/backup.redis";
      };
    };
  };
  "system/adr.sync.requested": {
    data: {
      reason?: string;
      requestedBy?: string;
    };
  };
  "system/sleep.requested": {
    data: {
      duration?: string;
      reason?: string;
    };
  };
  "system/wake.requested": {
    data: Record<string, never>;
  };
  "adr/review.submitted": {
    data: {
      adrSlug: string;
      source: string;
    };
  };
  "content/review.submitted": {
    data: {
      contentSlug: string;
      contentType: "adr" | "post" | "discovery" | "video-note";
      source: string;
    };
  };
  "system/heartbeat.wake": {
    data: Record<string, never>;
  };
  "content/updated": {
    data: {
      source?: string; // "fswatch" | "agent" | "manual"
      path?: string;
      paths?: string[];
    };
  };
  "content/published": {
    data: {
      type: "post" | "adr";
      title: string;
      slug: string;
      url?: string;
      adrNumber?: string | number;
      status?: string;
    };
  };
  "x/post.requested": {
    data: {
      text: string;
      url?: string;
      category?: "post" | "adr" | "discovery" | "digest";
    };
  };
  "x/post.completed": {
    data: {
      tweetId: string;
      tweetUrl?: string;
      text: string;
      url?: string;
      category?: "post" | "adr" | "discovery" | "digest";
    };
  };
  "typesense/vault-sync.requested": {
    data: {
      source: string;
      triggerEvent?: string;
      paths?: string[];
    };
  };
  "channel/slack.backfill.requested": {
    data: {
      channelId: string;
      channelName: string;
      oldestTs?: string;
      latestTs?: string;
      reason?: string;
    };
  };
  "channel/slack.backfill.batch.requested": {
    data: {
      channels: Array<{
        id: string;
        name: string;
      }>;
      oldestTs?: string;
      reason?: string;
    };
  };
  "channel/message.received": {
    data: {
      channelType: "slack" | "discord" | "telegram";
      channelId: string;
      channelName: string;
      threadId?: string;
      userId: string;
      userName: string;
      text: string;
      timestamp: number;
      sourceUrl?: string;
      metadata?: Record<string, unknown>;
    };
  };
  "channel/message.classify.requested": {
    data: {
      messageId: string;
    };
  };
  "channel/message.signal": {
    data: {
      messageId: string;
      channelType: "slack" | "discord" | "telegram";
      channelId: string;
      channelName: string;
      threadId?: string;
      userId: string;
      userName: string;
      text: string;
      timestamp: number;
      sourceUrl?: string;
      classification: "signal";
      topics: string[];
      urgency: "high" | "normal" | "low";
      actionable: boolean;
      summary?: string;
    };
  };
  "contact/enrich.requested": {
    data: {
      name: string;
      vault_path?: string;
      hints?: {
        slack_user_id?: string;
        github?: string;
        twitter?: string;
        email?: string;
        website?: string;
      };
      depth?: "quick" | "full";
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

  "voice/call.completed": {
    data: {
      transcript: string;
      room?: string;
      timestamp?: string;
      turns?: number;
      duration?: number;
      sessionId?: string;
    };
  };
  "notification/call.requested": {
    data: {
      message: string;
      to?: string;
    };
  };

  // --- Telegram callbacks (inline keyboard actions) ---
  "telegram/callback.received": {
    data: {
      action: string;
      context: string;
      rawData: string;
      chatId?: number;
      messageId?: number;
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

  // --- Vercel ---
  "vercel/deploy.succeeded": {
    data: {
      deploymentId: string;
      deploymentUrl?: string;
      projectName?: string;
      target?: string;
      gitCommitMessage?: string;
      gitCommitAuthor?: string;
      gitBranch?: string;
      dashboardUrl?: string;
    };
  };
  "vercel/deploy.error": {
    data: {
      deploymentId: string;
      deploymentUrl?: string;
      projectName?: string;
      target?: string;
      gitCommitMessage?: string;
      gitCommitAuthor?: string;
      gitBranch?: string;
      dashboardUrl?: string;
    };
  };
  "vercel/deploy.created": {
    data: {
      deploymentId: string;
      deploymentUrl?: string;
      projectName?: string;
      target?: string;
      gitCommitMessage?: string;
      gitCommitAuthor?: string;
      gitBranch?: string;
      dashboardUrl?: string;
    };
  };
  "vercel/deploy.canceled": {
    data: {
      deploymentId: string;
      deploymentUrl?: string;
      projectName?: string;
      target?: string;
      gitCommitMessage?: string;
      gitCommitAuthor?: string;
      gitBranch?: string;
      dashboardUrl?: string;
    };
  };

  // --- GitHub ---
  "github/workflow_run.completed": {
    data: {
      action: string;
      runId: number;
      runNumber: number | null;
      runAttempt: number | null;
      workflowId: number;
      workflowName: string;
      event: string;
      status: string;
      conclusion: string;
      htmlUrl: string;
      jobsUrl: string;
      logsUrl: string;
      branch: string;
      headSha: string;
      actorLogin: string;
      repository: string;
      repositoryUrl: string;
      headRepository: string;
      createdAt: string;
      updatedAt: string;
      completedAt: string;
    };
  };
  "github/package.published": {
    data: {
      action: string;
      ecosystem: string;
      packageName: string;
      packageType: string;
      packageHtmlUrl: string;
      versionName: string;
      versionHtmlUrl: string;
      repository: string;
      repositoryUrl: string;
      sender: string;
    };
  };

  // --- VIP Email ---
  "vip/email.received": {
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
      source: "front-webhook" | "manual";
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
  "meeting/transcript.fetched": {
    data: {
      meetingId: string;
      title: string;
      date?: string;
      participants?: string[];
      source?: "heartbeat" | "backfill" | "manual";
      sourceUrl?: string;
      /**
       * Optional raw transcript payload.
       * Usually omitted to keep event payloads small; fetch from cache via meetingId.
       */
      transcript?: string;
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
      mode?: "core" | "signals" | "full";
      source?: string;
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
  "memory/echo-fizzle.requested": {
    data: {
      recalledMemories: Array<{
        id: string;
        observation: string;
      }>;
      agentResponse: string;
    };
  };
  "memory/maintenance.weekly.requested": {
    data: {
      reason?: string;
      requestedBy?: string;
    };
  };
  "memory/category-summary.weekly.created": {
    data: {
      generatedAt: string;
      windowHours: number;
      memoryCount: number;
      categoryCoverageRatio: number;
      categories: Array<{ id: string; count: number; ratio: number }>;
      confidence: {
        supported: boolean;
        reason?: string;
        knownCount: number;
        highCount: number;
        mediumCount: number;
        lowCount: number;
        highRatio: number;
      };
      writeGate: {
        supported: boolean;
        reason?: string;
        allowCount: number;
        holdCount: number;
        discardCount: number;
        fallbackCount: number;
        totalWithVerdict: number;
        holdRatio: number;
        discardRatio: number;
        fallbackRate: number;
      };
    };
  };
  "memory/adr-evidence.capture.requested": {
    data: {
      reason?: string;
      requestedBy?: string;
      windowHours?: number;
    };
  };
  "memory/adr-evidence.daily.captured": {
    data: {
      generatedAt: string;
      date: string;
      windowHours: number;
      adr0095: {
        observeRuns: number;
        categoryEvidenceRuns: number;
        totalStoredCount: number;
        totalCategorizedCount: number;
        categoryCoverageRatio: number;
        taxonomyVersions: string[];
        weeklyCategorySummaryEvents: number;
      };
      adr0096: {
        recallEvents: number;
        prefetchEvents: number;
        recallWithBudgetDiagnostics: number;
        prefetchWithBudgetDiagnostics: number;
        recallBudgetBreakdown: Array<{ profile: string; count: number; avgDurationMs: number }>;
        prefetchBudgetBreakdown: Array<{ profile: string; count: number; avgDurationMs: number }>;
        deepVsLeanLatencyDeltaMs: number | null;
      };
      rollingWindow: {
        windowDays: number;
        daysCaptured: number;
        missingDates: string[];
        ready: boolean;
      };
      gates: {
        adr0095SignalReady: boolean;
        adr0096SignalReady: boolean;
      };
    };
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
  "email/inbox.cleanup": {
    data: {
      query?: string;
      maxPages?: number;
      dryRun?: boolean;
    };
  };
  "calendar/daily.check": {
    data: Record<string, never>;
  };
  "loops/stale.check": {
    data: Record<string, never>;
  };
  "subscription/check-feeds.requested": {
    data: {
      forceAll?: boolean;
      source?: string;
    };
  };
  "subscription/check.requested": {
    data: {
      subscriptionId: string;
      forced?: boolean;
      source?: string;
    };
  };
  "check/o11y-triage.requested": {
    data: {
      reason?: string;
      requestedBy?: string;
    };
  };
  "nas/soak.review.requested": {
    data: {
      reason?: string;
      requestedBy?: string;
    };
  };

  "skill-garden/check": {
    data: {
      deep?: boolean;
    };
  };

  // --- Legacy ---
};

export const inngest = new Inngest({
  // Ensure host and cluster workers register independently and cannot
  // overwrite each other's function graph in Inngest.
  id: (() => {
    const explicit = process.env.INNGEST_APP_ID?.trim()
    if (explicit) return explicit
    const role = process.env.WORKER_ROLE === "cluster" ? "cluster" : "host"
    return `system-bus-${role}`
  })(),
  schemas: new EventSchemas().fromRecord<Events>(),
  middleware: [gatewayMiddleware],
});
