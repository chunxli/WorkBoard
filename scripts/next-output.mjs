/** @param {string | undefined} [value] */
export function resolveNextDistDir(value = process.env.WORKBOARD_NEXT_DIST_DIR) {
  const directory = value?.trim() || ".next";
  if (!/^\.next(?:-[a-zA-Z0-9][a-zA-Z0-9_-]*)?$/.test(directory)) {
    throw new Error("WORKBOARD_NEXT_DIST_DIR must be .next or a generated .next-<name> directory inside the project.");
  }
  return directory;
}
