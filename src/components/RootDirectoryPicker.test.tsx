import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RootDirectoryPicker, { type RootDirectoryOption } from "./RootDirectoryPicker";

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void | (() => void))[],
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: <T,>(initial: T) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (next: T | ((current: T) => T)) => {
      hooks.states[index] = typeof next === "function"
        ? (next as (current: T) => T)(hooks.states[index] as T) : next;
    }];
  },
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
  useRef: (current: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = { current };
    return hooks.states[index];
  },
}));

interface ElementProps {
  children?: ReactNode;
  value?: string;
  disabled?: boolean;
  role?: string;
  "aria-label"?: string;
  onChange?: (event: { target: { value: string } }) => void;
  onClick?: () => void | Promise<void>;
}

function find(node: ReactNode, predicate: (element: ReactElement<ElementProps>) => boolean): ReactElement<ElementProps> | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<ElementProps>(child)) continue;
    if (predicate(child)) return child;
    const nested = find(child.props.children, predicate);
    if (nested) return nested;
  }
  return null;
}

function text(node: ReactNode): string {
  return Children.toArray(node).map((child) =>
    typeof child === "string" ? child : isValidElement<ElementProps>(child) ? text(child.props.children) : "",
  ).join("");
}

const roots: RootDirectoryOption[] = [
  { id: "demo", label: "Demo", path: "C:\\demo", builtIn: false },
  { id: "cases", label: "Cases", path: "C:\\cases", builtIn: false },
  { id: "home", label: "Home", path: "C:\\home", builtIn: true },
];
const key = (userId = "user-a") => `workboard:last-root:${userId}`;
const stored = new Map<string, string>();
const storage = {
  getItem: vi.fn((name: string) => stored.get(name) ?? null),
  setItem: vi.fn((name: string, value: string) => { stored.set(name, value); }),
  removeItem: vi.fn((name: string) => { stored.delete(name); }),
};
const onSelect = vi.fn();
const fetchMock = vi.fn<typeof fetch>();
let tree: ReactNode;
let cleanups: (() => void)[] = [];

function render(userId = "user-a", initialRoots = roots, selectedPath = "") {
  hooks.cursor = 0;
  hooks.effects = [];
  tree = RootDirectoryPicker({ userId, initialRoots, selectedPath, canOpenExplorer: false, onSelect });
}

function dropdown() {
  const element = find(tree, (child) => child.props["aria-label"] === "Common root directory");
  if (!element) throw new Error("Missing root dropdown");
  return element.props;
}

async function mount(userId = "user-a", initialRoots = roots) {
  hooks.states = [];
  render(userId, initialRoots);
  const cleanup = hooks.effects[0]();
  if (cleanup) cleanups.push(cleanup);
  await vi.advanceTimersByTimeAsync(0);
  render(userId, initialRoots);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  stored.clear();
  hooks.states = [];
  storage.getItem.mockImplementation((name) => stored.get(name) ?? null);
  storage.setItem.mockImplementation((name, value) => { stored.set(name, value); });
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("remembered common root directory", () => {
  it("uses the first root for a new user without selecting a Work path", async () => {
    render();
    expect(dropdown().disabled).toBe(true);
    expect(storage.getItem).not.toHaveBeenCalled();
    await mount();
    expect(dropdown().value).toBe(roots[0].path);
    expect(dropdown().disabled).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("persists a dropdown change and restores it on fresh mounts without overwriting it", async () => {
    await mount();
    dropdown().onChange?.({ target: { value: roots[1].path } });
    expect(stored.get(key())).toBe(roots[1].path);
    await mount();
    expect(dropdown().value).toBe(roots[1].path);
    await mount();
    expect(dropdown().value).toBe(roots[1].path);
    expect(storage.setItem).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("browses only the restored root, not the first root or the selected Work path", async () => {
    stored.set(key(), roots[1].path);
    await mount();
    render("user-a", roots, "C:\\another-work");
    fetchMock.mockResolvedValue(Response.json({ current: roots[1].path, parent: "C:\\", entries: [] }));
    const cleanup = hooks.effects[1]();
    if (cleanup) cleanups.push(cleanup);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `/api/fs/browse?path=${encodeURIComponent(roots[1].path)}`,
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("isolates preferences between users, including built-in roots", async () => {
    await mount();
    dropdown().onChange?.({ target: { value: roots[2].path } });
    await mount("user-b");
    expect(dropdown().value).toBe(roots[0].path);
    await mount();
    expect(dropdown().value).toBe(roots[2].path);
  });

  it("discards deleted shortcuts and falls back to the first available root", async () => {
    stored.set(key(), "C:\\removed");
    await mount();
    expect(dropdown().value).toBe(roots[0].path);
    expect(stored.has(key())).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("handles an empty root list without browsing an obsolete path", async () => {
    stored.set(key(), roots[1].path);
    await mount("user-a", []);
    expect(dropdown().value).toBe("");
    expect(stored.has(key())).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports blocked storage reads while keeping the default root usable", async () => {
    storage.getItem.mockImplementation(() => { throw new Error("Storage blocked"); });
    await mount();
    expect(dropdown().value).toBe(roots[0].path);
    const alert = find(tree, (child) => child.props.role === "alert");
    expect(alert?.props.children).toBe("Cannot restore the last selected folder: Storage blocked");
  });

  it("reports blocked writes without preventing navigation", async () => {
    await mount();
    storage.setItem.mockImplementation(() => { throw new Error("Quota exceeded"); });
    dropdown().onChange?.({ target: { value: roots[1].path } });
    render();
    expect(dropdown().value).toBe(roots[1].path);
    const alert = find(tree, (child) => child.props.role === "alert");
    expect(alert?.props.children).toBe("Cannot remember the selected folder: Quota exceeded");
  });

  it("remembers a newly saved shortcut as the new default", async () => {
    await mount();
    render("user-a", roots, "C:\\new-root");
    fetchMock.mockResolvedValue(Response.json({ id: "new", label: "new-root", rootPath: "C:\\new-root" }, { status: 201 }));
    const add = find(tree, (child) => child.props["aria-label"] === "Add selected folder as common root");
    expect(add).not.toBeNull();
    await add?.props.onClick?.();
    await vi.advanceTimersByTimeAsync(0);
    render();
    expect(dropdown().value).toBe("C:\\new-root");
    expect(stored.get(key())).toBe("C:\\new-root");
  });

  it("updates the remembered default after removing the selected shortcut", async () => {
    stored.set(key(), roots[1].path);
    await mount();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const remove = find(tree, (child) => child.props["aria-label"] === "Remove common root");
    expect(remove).not.toBeNull();
    await remove?.props.onClick?.();
    await vi.advanceTimersByTimeAsync(0);
    render();
    expect(dropdown().value).toBe(roots[0].path);
    expect(stored.get(key())).toBe(roots[0].path);
  });

  it("keeps loaded folders visible when a server refresh supplies equivalent root props", async () => {
    await mount();
    fetchMock.mockResolvedValue(Response.json({
      current: roots[0].path, parent: "C:\\", entries: [{ name: "child-folder", path: "C:\\demo\\child-folder" }],
    }));
    const cleanup = hooks.effects[1]();
    if (cleanup) cleanups.push(cleanup);
    await vi.advanceTimersByTimeAsync(0);
    render();
    expect(text(tree)).toContain("child-folder");

    const refreshedRoots = roots.map((root) => ({ ...root }));
    render("user-a", refreshedRoots);
    const restoreCleanup = hooks.effects[0]();
    if (restoreCleanup) cleanups.push(restoreCleanup);
    await vi.advanceTimersByTimeAsync(0);
    render("user-a", refreshedRoots);
    expect(text(tree)).not.toContain("Loading folders...");
    expect(text(tree)).toContain("child-folder");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not invalidate an in-flight folder request during a server refresh", async () => {
    await mount();
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValue(pending.promise);
    const cleanup = hooks.effects[1]();
    if (cleanup) cleanups.push(cleanup);
    await vi.advanceTimersByTimeAsync(0);

    const refreshedRoots = roots.map((root) => ({ ...root }));
    render("user-a", refreshedRoots);
    const restoreCleanup = hooks.effects[0]();
    if (restoreCleanup) cleanups.push(restoreCleanup);
    await vi.advanceTimersByTimeAsync(0);
    pending.resolve(Response.json({
      current: roots[0].path, parent: "C:\\", entries: [{ name: "pending-child", path: "C:\\demo\\pending-child" }],
    }));
    await vi.advanceTimersByTimeAsync(0);
    render("user-a", refreshedRoots);
    expect(text(tree)).not.toContain("Loading folders...");
    expect(text(tree)).toContain("pending-child");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
