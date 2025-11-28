"use client";

import { cn } from "@/lib/utils";

interface SpinnerProps {
  label?: string;
  className?: string;
}

export function Spinner({ label = "Loading...", className }: SpinnerProps) {
  return (
    <div className={cn("flex items-center justify-center gap-2 text-sm text-muted-foreground", className)}>
      <svg
        className="h-4 w-4 animate-spin text-muted-foreground"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
        />
      </svg>
      <span>{label}</span>
    </div>
  );
}