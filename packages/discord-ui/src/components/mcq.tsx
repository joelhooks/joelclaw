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
  context?: string;
  recommended?: number;
  recommendedReason?: string;
  weight?: "critical" | "normal" | "minor";
  conviction?: "strong" | "slight";
};

export type McqFlowProps = {
  title?: string;
  questions: McqQuestionData[];
  autoSelectTimeoutMs?: number;
  onComplete: (answers: Record<string, string>) => void;
};

// ── Colors ─────────────────────────────────────────────────────────

const COLORS = {
  active: 0x5865f2,     // Discord blurple
  answered: 0x2ecc71,   // Green
  title: 0x9b59b6,      // Purple
  critical: 0xe74c3c,   // Red for critical weight
} as const;

// ── Single Question ────────────────────────────────────────────────

type QuestionProps = {
  question: McqQuestionData;
  onAnswer: (questionId: string, answer: string) => void;
  autoSelectTimeoutMs?: number;
};

function Question({ question, onAnswer, autoSelectTimeoutMs }: QuestionProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [autoSelected, setAutoSelected] = useState(false);
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

  // Auto-select recommended option after timeout
  useEffect(() => {
    if (!autoSelectTimeoutMs || autoSelectTimeoutMs <= 0) return;
    if (!question.recommended || question.recommended < 1) return;

    const rec = question.options[question.recommended - 1];
    if (!rec) return;

    const timer = setTimeout(() => {
      handleSelect(rec, true);
    }, autoSelectTimeoutMs);

    return () => clearTimeout(timer);
  }, [autoSelectTimeoutMs, question.recommended, question.options, handleSelect]);

  // ── Answered state ──────────────────────────────────────────
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
  const description = formatQuestion(question);

  return (
    <>
      <Embed color={color}>
        {description}
      </Embed>
      <ActionRow>
        {question.options.map((opt, i) => {
          const isRec = question.recommended === i + 1;
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

function formatQuestion(q: McqQuestionData): string {
  const lines: string[] = [`**${q.question}**`];

  if (q.context?.trim()) {
    lines.push(`*${q.context.trim()}*`);
  }

  lines.push("");

  for (let i = 0; i < q.options.length; i++) {
    const badge = q.recommended === i + 1 ? " ★" : "";
    lines.push(`**${i + 1}.** ${q.options[i]}${badge}`);
  }
  lines.push(`**${q.options.length + 1}.** Other`);

  if (q.recommendedReason?.trim()) {
    const prefix =
      q.recommended && q.recommended > 0
        ? `Recommended (${q.recommended} ★)`
        : "Recommendation";
    lines.push("");
    lines.push(`*${prefix}: ${q.recommendedReason.trim()}*`);
  }

  return lines.join("\n");
}

// ── MCQ Flow ───────────────────────────────────────────────────────

/**
 * Sequential MCQ flow. Shows one question at a time.
 * Answered questions collapse to a green summary embed.
 * Calls onComplete when all questions are answered.
 */
export function McqFlow({ title, questions, autoSelectTimeoutMs, onComplete }: McqFlowProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const completedRef = useRef(false);
  const answeredCount = Object.keys(answers).length;

  const handleAnswer = useCallback(
    (questionId: string, answer: string) => {
      setAnswers((prev) => {
        const next = { ...prev, [questionId]: answer };
        if (Object.keys(next).length === questions.length && !completedRef.current) {
          completedRef.current = true;
          setTimeout(() => onComplete(next), 0);
        }
        return next;
      });
    },
    [questions.length, onComplete],
  );

  return (
    <>
      {title?.trim() && (
        <Embed color={COLORS.title}>
          {`**${title}**`}
        </Embed>
      )}
      {questions.map((q, i) => {
        const isAnswered = q.id in answers;
        const isActive = i === answeredCount;

        if (isAnswered || isActive) {
          return (
            <Question
              key={q.id}
              question={q}
              onAnswer={handleAnswer}
              autoSelectTimeoutMs={isActive ? autoSelectTimeoutMs : undefined}
            />
          );
        }

        // Future questions not shown yet
        return null;
      })}
    </>
  );
}
