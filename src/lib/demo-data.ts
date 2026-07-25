import type { HomeItem } from "@/lib/domain";

export const demoItems: HomeItem[] = [
  { id: "car-insurance", sectionId: "vehicle", title: "Car insurance", subtype: "Insurance", provider: "Admiral", reference: "CAR-4821", costMinor: 58200, currency: "GBP", dueDate: "2026-07-22", scheduleKind: "renewal", recurrenceMonths: 12, reminderDays: [30, 7, 1], status: "active", version: 1 },
  { id: "boiler-service", sectionId: "home", title: "Boiler service", subtype: "Annual service", provider: "Warm & Co.", costMinor: 10900, currency: "GBP", dueDate: "2026-08-02", scheduleKind: "service", recurrenceMonths: 12, reminderDays: [14, 3], status: "active", version: 1 },
  { id: "broadband", sectionId: "service", title: "Broadband contract", subtype: "Contract", provider: "HyperNet", costMinor: 4200, currency: "GBP", dueDate: "2026-09-14", scheduleKind: "renewal", recurrenceMonths: 18, reminderDays: [30, 7], status: "active", version: 1 },
  { id: "washing-machine", sectionId: "device", title: "Washing machine cover", subtype: "Breakdown cover", provider: "ProtectPlus", costMinor: 8999, currency: "GBP", dueDate: "2026-11-05", scheduleKind: "renewal", recurrenceMonths: 12, reminderDays: [30, 7], status: "active", version: 1 },
  { id: "home-inventory", sectionId: "home", title: "Home inventory review", subtype: "Household task", currency: "GBP", status: "active" },
];
