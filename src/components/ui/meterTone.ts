/** Thresholds of SPEC section 9: normal below 70 %, warning from 70 %, critical from 90 %. */
export function meterTone(percent: number): "normal" | "warning" | "critical" {
  if (percent >= 90) return "critical";
  if (percent >= 70) return "warning";
  return "normal";
}
