/**
 * MCQ Component — Interactive multiple-choice questions in Discord (ADR-0122)
 *
 * Renders questions with embed cards and buttons. Clicking a button:
 * 1. Updates the message in place (shows selected answer)
 * 2. Resolves the settle callback so the caller gets the answer
 *
 * Supports recommended options (★ badge), sequential question flow,
 * and "Other" for free-text responses.
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  Embed,
  Button,
  ActionRow,
} from "@answeroverflow/discordjs-react";
import type { ButtonInteraction } from "discord.js";

// ── Types ──────────────────────────────────────────────────────────

export type McqQuestionData = {
  id: string;
  question: string;
  options: string[];
  mode?: "quiz" | "decision";
  context?: string;
  recommended?: number;
  recommendedReason?: string;
  weight?: "critical" | "normal" | "minor";
  conviction?: "strong" | "slight";
};

export type McqFlowProps = {
  title?: string;
  questions: McqQuestionData[];
  mode?: "quiz" | "decision";
  correctAnswers?: Record<string, number>;
  autoSelectTimeoutMs?: number;
  onComplete: (answers: Record<string, string>) => void;
};

// ── Colors ─────────────────────────────────────────────────────────

const COLORS = {
  active: 0x5865f2,     // Discord blurple
  answered: 0x2ecc71,   // Green
  title: 0x9b59b6,      // Purple
  critical: 0xe74c3c,   // Red for critical weight
  skipped: 0xf39c12,    // Orange
} as const;

type McqMode = "quiz" | "decision";

function normalizeMode(mode: McqFlowProps["mode"]): McqMode {
  return mode === "quiz" ? "quiz" : "decision";
}

// ── Single Question ────────────────────────────────────────────────

type QuestionProps = {
  question: McqQuestionData;
  mode: McqMode;
  onAnswer: (questionId: string, answer?: string) => void;
  autoSelectTimeoutMs?: number;
};

function Question({ question, mode, onAnswer, autoSelectTimeoutMs }: QuestionProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [autoSelected, setAutoSelected] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const settledRef = useRef(false);

  const handleSelect = useCallback(
    (answer: string, isAuto = false) => {
      if (settledRef.current) return;
      settledRef.current = true;
      setSelected(answer);
      setAutoSelected(isAuto);
      onAnswer(question.id, answer);
    },
    [question.id, onAnswer],
  );

  const handleSkip = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    setSkipped(true);
    onAnswer(question.id);
  }, [question.id, onAnswer]);

  // Auto-select recommended option after timeout (decision mode)
  useEffect(() => {
    if (mode !== "decision") return;
    if (!autoSelectTimeoutMs || autoSelectTimeoutMs <= 0) return;
    if (!question.recommended || question.recommended < 1) return;

    const rec = question.options[question.recommended - 1];
    if (!rec) return;

    const timer = setTimeout(() => {
      handleSelect(rec, true);
    }, autoSelectTimeoutMs);

    return () => clearTimeout(timer);
  }, [mode, autoSelectTimeoutMs, question.recommended, question.options, handleSelect]);

  // Quiz timeout skips the question without recording an answer
  useEffect(() => {
    if (mode !== "quiz") return;
    if (!autoSelectTimeoutMs || autoSelectTimeoutMs <= 0) return;

    const timer = setTimeout(() => {
      handleSkip();
    }, autoSelectTimeoutMs);

    return () => clearTimeout(timer);
  }, [mode, autoSelectTimeoutMs, handleSkip]);

  // ── Answered state ──────────────────────────────────────────
  if (skipped) {
    return (
      <Embed color={COLORS.skipped}>
        {`**${question.question}**\n\n⏱ Time's up — skipped`}
      </Embed>
    );
  }

  if (selected) {
    const prefix = autoSelected ? "⏱ Auto-selected" : "✅";
    return (
      <Embed color={COLORS.answered}>
        {`**${question.question}**\n\n${prefix} \`${selected}\``}
      </Embed>
    );
  }

  // ── Active question with buttons ────────────────────────────
  const color = question.weight === "critical" ? COLORS.critical : COLORS.active;
  const description = formatQuestion(question, mode);
  const showRecommendation = mode === "decision";

  return (
    <>
      <Embed color={color}>
        {description}
      </Embed>
      <ActionRow>
        {question.options.map((opt, i) => {
          const isRec = showRecommendation && question.recommended === i + 1;
          return (
            <Button
              key={i}
              label={`${i + 1}${isRec ? " ★" : ""}`}
              style={isRec ? "Success" : "Secondary"}
              onClick={async (_interaction: ButtonInteraction) => {
                handleSelect(opt);
              }}
            />
          );
        })}
        <Button
          label="Other"
          style="Secondary"
          onClick={async (interaction: ButtonInteraction) => {
            try {
              await interaction.followUp({
                content: "Reply in this thread with your custom answer.",
                ephemeral: true,
              });
            } catch { /* non-critical */ }
            handleSelect("(custom — see thread)");
          }}
        />
      </ActionRow>
    </>
  );
}

function formatQuestion(q: McqQuestionData, mode: McqMode): string {
  const lines: string[] = [`**${q.question}**`];
  const showRecommendation = mode === "decision";

  if (q.context?.trim()) {
    lines.push(`*${q.context.trim()}*`);
  }

  lines.push("");

  for (let i = 0; i < q.options.length; i++) {
    const badge = showRecommendation && q.recommended === i + 1 ? " ★" : "";
    lines.push(`**${i + 1}.** ${q.options[i]}${badge}`);
  }
  lines.push(`**${q.options.length + 1}.** Other`);

  if (showRecommendation && q.recommendedReason?.trim()) {
    const prefix =
      q.recommended && q.recommended > 0
        ? `Recommended (${q.recommended} ★)`
        : "Recommendation";
    lines.push("");
    lines.push(`*${prefix}: ${q.recommendedReason.trim()}*`);
  }

  return lines.join("\n");
}

function extractAnswers(responses: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(responses).filter(([, value]) => typeof value === "string"),
  ) as Record<string, string>;
}

function formatQuizSummary(
  questions: McqQuestionData[],
  answers: Record<string, string>,
  correctAnswers: Record<string, number> | undefined,
): { text: string; color: number } {
  let correctCount = 0;

  const lines = questions.map((question, index) => {
    const expectedIndex = correctAnswers?.[question.id];
    if (!Number.isInteger(expectedIndex) || !expectedIndex || expectedIndex < 1 || expectedIndex > question.options.length) {
      return `🟥 Q${index + 1}: no correct answer configured`;
    }

    const expected = question.options[expectedIndex - 1];
    const selected = answers[question.id];
    const isCorrect = selected === expected;
    if (isCorrect) {
      correctCount += 1;
    }

    const marker = isCorrect ? "🟩" : "🟥";
    const selectedLabel = selected ?? "⏱ skipped";
    return `${marker} Q${index + 1}: your \`${selectedLabel}\` · correct \`${expected}\``;
  });

  return {
    text: `**You got ${correctCount}/${questions.length} correct!**\n\n${lines.join("\n")}`,
    color: correctCount === questions.length ? COLORS.answered : COLORS.critical,
  };
}

// ── MCQ Flow ───────────────────────────────────────────────────────

/**
 * Sequential MCQ flow. Shows one question at a time.
 * Answered questions collapse to a green summary embed.
 * Calls onComplete when all questions are answered.
 */
export function McqFlow({ title, questions, mode, correctAnswers, autoSelectTimeoutMs, onComplete }: McqFlowProps) {
  const resolvedMode = normalizeMode(mode);
  const [responses, setResponses] = useState<Record<string, string | null>>({});
  const completedRef = useRef(false);
  const completedCount = Object.keys(responses).length;
  const answers = extractAnswers(responses);

  const handleAnswer = useCallback(
    (questionId: string, answer?: string) => {
      setResponses((prev) => {
        if (questionId in prev) {
          return prev;
        }

        const next = { ...prev, [questionId]: typeof answer === "string" ? answer : null };
        if (Object.keys(next).length === questions.length && !completedRef.current) {
          completedRef.current = true;
          setTimeout(() => onComplete(extractAnswers(next)), 0);
        }
        return next;
      });
    },
    [questions.length, onComplete],
  );

  const quizSummary = resolvedMode === "quiz" && completedCount === questions.length
    ? formatQuizSummary(questions, answers, correctAnswers)
    : null;

  return (
    <>
      {title?.trim() && (
        <Embed color={COLORS.title}>
          {`**${title}**`}
        </Embed>
      )}
      {questions.map((q, i) => {
        const isCompleted = q.id in responses;
        const isActive = i === completedCount;
        const questionMode = q.mode === "quiz" || q.mode === "decision"
          ? q.mode
          : resolvedMode;

        if (isCompleted || isActive) {
          return (
            <Question
              key={q.id}
              question={q}
              mode={questionMode}
              onAnswer={handleAnswer}
              autoSelectTimeoutMs={isActive ? autoSelectTimeoutMs : undefined}
            />
          );
        }

        // Future questions not shown yet
        return null;
      })}
      {quizSummary && (
        <Embed color={quizSummary.color}>
          {quizSummary.text}
        </Embed>
      )}
    </>
  );
}
