import { z } from "zod";
import { sectionAccents, sectionIcons } from "./domain";

export const themeModes = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof themeModes)[number];

export const colourways = [
  { id: "after-dark", name: "After Dark", description: "Orbit ink, electric cyan and hot pink", swatches: ["#15162b", "#22e7d3", "#ff4fa3"] },
  { id: "verdant", name: "Verdant", description: "Forest, coral and warm ivory", swatches: ["#0d4033", "#ff7456", "#f2ca63"] },
  { id: "coast", name: "Coast", description: "Ocean blue, cyan and sand", swatches: ["#123c5a", "#35a7c8", "#f0b75e"] },
  { id: "berry", name: "Berry", description: "Aubergine, rose and lilac", swatches: ["#4b274f", "#ec6687", "#bd9bea"] },
  { id: "ember", name: "Ember", description: "Charcoal, orange and oat", swatches: ["#32322f", "#e97535", "#d7a84d"] },
] as const;

export const themePreferenceSchema = z.object({
  mode: z.enum(themeModes),
  colourway: z.enum(colourways.map((theme) => theme.id) as [string, ...string[]]),
});

export const sectionPreferenceSchema = z.array(z.object({
  id: z.string().min(1).max(80),
  name: z.string().max(30),
  icon: z.enum(sectionIcons),
  accent: z.enum(sectionAccents),
  visible: z.boolean(),
})).max(12).superRefine((sections, context) => {
  if (new Set(sections.map((section) => section.id)).size !== sections.length) {
    context.addIssue({ code: "custom", message: "Section identifiers must be unique" });
  }
});
