import type { HomeItem } from "@/lib/domain";

export const THEME_STORAGE_KEY = "orbit:theme:v1";
export const PREFERENCE_EVENT = "orbit:preference-change";

export function storePreference(key: string, value: unknown) {
  window.localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent(PREFERENCE_EVENT, { detail: key }));
}

export function calendarDateInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function formatLongDate(value: string, timeZone = "UTC") {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone }).format(new Date(`${value}T00:00:00Z`));
}

export function formatHeadingDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

export function formatCost(item: HomeItem) {
  if (item.costMinor == null) return "No cost recorded";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: item.currency }).format(item.costMinor / 100);
}

export function dueCopy(item: HomeItem, today: string, daysUntil: (date: string, now: string) => number) {
  if (!item.dueDate) return "No due date";
  const days = daysUntil(item.dueDate, today);
  if (days < 0) return `${Math.abs(days)} days overdue`;
  if (days === 0) return "Due today";
  return `Due in ${days} days`;
}

export function householdInitials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}
