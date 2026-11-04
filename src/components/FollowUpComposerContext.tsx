"use client";

import { createContext } from "react";

export const FollowUpComposerContext = createContext<{
  workId: string;
  disabled: boolean;
  insertPath(path: string): void;
} | null>(null);
