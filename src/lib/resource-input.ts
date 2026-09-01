export type ResourceSourceType = "LOCAL_PATH" | "GIT_URL";

export function inferResourceSourceType(location: string): ResourceSourceType {
  const value = location.trim();
  return /^https?:\/\//i.test(value) || /^git@/i.test(value) || /\.git$/i.test(value)
    ? "GIT_URL"
    : "LOCAL_PATH";
}

export function inferResourceName(location: string): string {
  const value = location.trim().replace(/[\\/]+$/, "");
  return (value.split(/[\\/]/).pop() ?? value).replace(/\.git$/i, "") || "resource";
}