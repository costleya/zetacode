import { DiagnosticSeverity } from "vscode";

type SeverityLabel = "error" | "warning" | "info" | "hint";

const SEVERITY_LABELS: Record<DiagnosticSeverity, SeverityLabel> = {
  [DiagnosticSeverity.Error]: "error",
  [DiagnosticSeverity.Warning]: "warning",
  [DiagnosticSeverity.Information]: "info",
  [DiagnosticSeverity.Hint]: "hint",
};

export function diagnosticSeverityLabel(severity: DiagnosticSeverity | undefined): SeverityLabel {
  return SEVERITY_LABELS[severity ?? DiagnosticSeverity.Information] ?? "info";
}
