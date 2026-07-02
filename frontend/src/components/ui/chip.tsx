import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./utils";

const chipVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap [&>svg]:size-3.5 [&>svg]:pointer-events-none disabled:opacity-40 disabled:pointer-events-none",
  {
    variants: {
      active: {
        true: "bg-primary/20 text-primary border-primary/50 font-semibold",
        false:
          "bg-secondary/40 text-muted-foreground border-border hover:text-foreground hover:bg-secondary/70",
      },
    },
    defaultVariants: {
      active: false,
    },
  },
);

interface ChipProps
  extends Omit<React.ComponentProps<"button">, "onClick">,
    VariantProps<typeof chipVariants> {
  onClick?: () => void;
}

function Chip({ className, active, onClick, ...props }: ChipProps) {
  return (
    <button
      type="button"
      data-slot="chip"
      onClick={onClick}
      className={cn(chipVariants({ active }), className)}
      {...props}
    />
  );
}

export { Chip, chipVariants };
