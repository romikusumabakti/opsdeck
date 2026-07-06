export type AdvanceUnit = "minutes" | "hours" | "days";
export type AdvanceDirection = "forward" | "backward";

export function buildDuration(
  amount: number,
  unit: AdvanceUnit,
  direction: AdvanceDirection
): string {
  const sign = direction === "backward" ? "-" : "";
  switch (unit) {
    case "days":
      return `${sign}P${amount}D`;
    case "hours":
      return `${sign}PT${amount}H`;
    case "minutes":
      return `${sign}PT${amount}M`;
  }
}
