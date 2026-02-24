/**
 * SelectPrompt — Dropdown selection menu (ADR-0122)
 *
 * Renders a Discord select menu for choosing from a list.
 * Supports single and multiple selection, descriptions, and emojis.
 */

import React, { useState, useRef } from "react";
import {
  Embed,
  Select,
  Option,
} from "@answeroverflow/discordjs-react";
import type { StringSelectMenuInteraction } from "discord.js";

export type SelectOption = {
  label: string;
  value: string;
  description?: string;
  emoji?: string;
};

export type SelectPromptProps = {
  prompt: string;
  options: SelectOption[];
  placeholder?: string;
  multiple?: boolean;
  minValues?: number;
  maxValues?: number;
  onSelect: (values: string[], interaction: StringSelectMenuInteraction) => Promise<unknown> | unknown;
};

/**
 * Renders a select menu with a prompt. Updates in place when selection is made.
 */
export function SelectPrompt({
  prompt,
  options,
  placeholder = "Choose an option...",
  multiple = false,
  minValues,
  maxValues,
  onSelect,
}: SelectPromptProps) {
  const [selected, setSelected] = useState<string[] | null>(null);
  const settledRef = useRef(false);

  if (selected) {
    const display = selected
      .map((v) => options.find((o) => o.value === v)?.label ?? v)
      .join(", ");
    return (
      <Embed color={0x2ecc71}>
        {`**${prompt}**\n\n✅ Selected: \`${display}\``}
      </Embed>
    );
  }

  return (
    <>
      <Embed color={0x5865f2}>
        {`**${prompt}**`}
      </Embed>
      <Select
        placeholder={placeholder}
        multiple={multiple}
        minValues={minValues}
        maxValues={maxValues}
        onChangeMultiple={async (values, interaction) => {
          if (settledRef.current) return;
          settledRef.current = true;
          setSelected(values);
          await onSelect(values, interaction);
        }}
      >
        {options.map((opt) => (
          <Option
            key={opt.value}
            label={opt.label}
            value={opt.value}
            description={opt.description}
            emoji={opt.emoji}
          />
        ))}
      </Select>
    </>
  );
}
