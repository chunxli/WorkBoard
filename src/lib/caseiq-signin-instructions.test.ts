import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CASEIQ_AUTHENTICATION_COMMAND } from "./caseiq-options";

const executeFile = promisify(execFile);
const lineSchema = z.object({
  text: z.string(), foreground: z.string().nullable(), background: z.string().nullable(),
});

describe.runIf(process.platform === "win32")("native SupportIQ sign-in instruction highlighting", () => {
  it("uses explicit high-contrast heading/command/warning colors and explains every manual step", async () => {
    const script = `
$ErrorActionPreference = 'Stop'
$tree = [Management.Automation.Language.Parser]::ParseFile($env:WORKBOARD_INSTRUCTIONS_SCRIPT, [ref]$null, [ref]$null)
$definition = $tree.Find({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Show-CaseIQAuthenticationInstructions'
}, $true)
if (-not $definition) { throw 'Sign-in instruction function is missing.' }
. ([scriptblock]::Create($definition.Extent.Text))
function Write-Host {
    param([Parameter(Position = 0)][AllowEmptyString()][string]$Object,
        [ConsoleColor]$ForegroundColor, [ConsoleColor]$BackgroundColor)
    [pscustomobject]@{
        text = $Object
        foreground = if ($PSBoundParameters.ContainsKey('ForegroundColor')) { [string]$ForegroundColor } else { $null }
        background = if ($PSBoundParameters.ContainsKey('BackgroundColor')) { [string]$BackgroundColor } else { $null }
    } | ConvertTo-Json -Compress
}
Show-CaseIQAuthenticationInstructions
`;
    const result = await executeFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, timeout: 15_000,
      env: { ...process.env, WORKBOARD_INSTRUCTIONS_SCRIPT: path.join(process.cwd(), "scripts", "workboard-caseiq.ps1") },
    });
    const lines = result.stdout.trim().split(/\r?\n/).map((line) => lineSchema.parse(JSON.parse(line)));
    expect(lines.find((line) => line.text.includes("ACTION REQUIRED"))).toMatchObject({
      foreground: "Black", background: "Yellow",
    });
    expect(lines.find((line) => line.text.trim() === CASEIQ_AUTHENTICATION_COMMAND)).toMatchObject({
      foreground: "Black", background: "Cyan",
    });
    expect(lines.find((line) => line.text.includes("DO NOT SEND TASK PROMPTS"))).toMatchObject({
      foreground: "Black", background: "Yellow",
    });
    const text = lines.map((line) => line.text).join("\n");
    expect(text).toContain("Wait for the Copilot prompt");
    expect(text).toContain("in this Terminal, not in Work Board");
    expect(text).toContain("TSE account on the official sign-in page");
    expect(text).toContain("After OAuth is checked in Work Board, exit Copilot");
    expect(text).toContain("return to Work Board");
  });
});
