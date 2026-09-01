export function detectSkillInvocation(transcript: string, skillName: string | null): boolean | null {
  if (!skillName) return null;
  let sawInvocationEvent = false;
  for (const line of transcript.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: unknown; data?: { name?: unknown } };
      if (event.type !== "skill.invoked") continue;
      sawInvocationEvent = true;
      if (event.data?.name === skillName) return true;
    } catch {
      // Ignore non-event output.
    }
  }
  return sawInvocationEvent ? false : null;
}