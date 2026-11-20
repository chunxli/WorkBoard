"use client";

import { createContext, useCallback, useState } from "react";
import { pairedWorkLanes } from "@/lib/work-session-pair";

export const workFileLocations = ["shared", ...pairedWorkLanes] as const;
export type WorkFileLocation = (typeof workFileLocations)[number];

export function useWorkFileLocations() {
  const [selection, setSelection] = useState<{ location: WorkFileLocation; visited: ReadonlySet<WorkFileLocation> }>(
    () => ({ location: "shared", visited: new Set(["shared"]) }),
  );
  const selectLocation = useCallback((location: WorkFileLocation) => {
    setSelection((current) => location === current.location ? current : {
      location, visited: current.visited.has(location) ? current.visited : new Set([...current.visited, location]),
    });
  }, []);
  return { ...selection, selectLocation };
}

export const WorkFileNavigationContext = createContext<(ReturnType<typeof useWorkFileLocations> & {
  returnToConversation?(): void;
}) | null>(null);
