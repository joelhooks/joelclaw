/**
 * Behavior Loop — ADR-0077 Increment 3
 * 
 * When the user corrects the agent, extract the pattern and write it
 * to MEMORY.md's Lessons section. Loaded on every session start.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const MEMORY_PATH = process.env.MEMORY_PATH ?? `${process.env.HOME}/.joelclaw/workspace/MEMORY.md`;

export interface Lesson {
  trigger: string;    // What caused the bad behavior
  correction: string; // What the user said to fix it  
  lesson: string;     // The extracted rule
  date: string;       // ISO date
}

/**
 * Append a lesson to MEMORY.md's Lessons section.
 * Creates the section if it doesn't exist.
 */
export function appendLesson(lesson: Lesson): void {
  if (!existsSync(MEMORY_PATH)) {
    throw new Error(`MEMORY.md not found at ${MEMORY_PATH}`);
  }
  
  let content = readFileSync(MEMORY_PATH, "utf-8");
  
  const lessonEntry = [
    `- **${lesson.lesson}**`,
    `  - Trigger: ${lesson.trigger}`,
    `  - Correction: ${lesson.correction}`,
    `  - Date: ${lesson.date}`,
    "",
  ].join("\n");
  
  const sectionHeader = "## Lessons";
  const sectionIndex = content.indexOf(sectionHeader);
  
  if (sectionIndex === -1) {
    // Add section at end
    content = content.trimEnd() + "\n\n" + sectionHeader + "\n\n" + lessonEntry;
  } else {
    // Find the end of the Lessons section (next ## or end of file)
    const afterHeader = sectionIndex + sectionHeader.length;
    const nextSection = content.indexOf("\n## ", afterHeader);
    const insertAt = nextSection === -1 ? content.length : nextSection;
    content = content.slice(0, insertAt).trimEnd() + "\n" + lessonEntry + "\n" + content.slice(insertAt);
  }
  
  writeFileSync(MEMORY_PATH, content, "utf-8");
}

/**
 * Parse a user correction into a structured lesson.
 * This is a simple extraction — the caller (an LLM-powered step) provides
 * the structured fields after analyzing the correction.
 */
export function createLesson(
  trigger: string,
  correction: string,
  lesson: string,
): Lesson {
  return {
    trigger,
    correction,
    lesson,
    date: new Date().toISOString().slice(0, 10),
  };
}
