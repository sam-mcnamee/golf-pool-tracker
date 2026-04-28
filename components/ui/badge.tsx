import * as React from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: "default" | "secondary" | "destructive" }) {
  const styles =
    variant === "secondary"
      ? "bg-slate-100 text-slate-900"
      : variant === "destructive"
        ? "bg-red-100 text-red-700"
        : "bg-slate-900 text-white";

  return (
    <span
      className={cn("inline-flex items-center rounded-md px-2 py-1 text-xs font-medium", styles, className)}
      {...props}
    />
  );
}

