import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

type ViewWidth = "compact" | "default" | "wide";

interface ViewShellProps {
  viewKey: number;
  direction: 1 | -1;
  title: string;
  description?: string;
  width?: ViewWidth;
  children: ReactNode;
}

const widthClass: Record<ViewWidth, string> = {
  compact: "max-w-2xl",
  default: "max-w-5xl",
  wide: "max-w-6xl",
};

/** Marco común de las secciones: una misma referencia visual y una transición
 * discreta para que la navegación se perciba como un solo espacio de trabajo. */
export function ViewShell({ viewKey, direction, title, description, width = "default", children }: ViewShellProps) {
  const reduceMotion = useReducedMotion();
  const variants = {
    enter: (travelDirection: number) => ({ opacity: 0, y: travelDirection * 34 }),
    center: { opacity: 1, y: 0 },
    exit: (travelDirection: number) => ({ opacity: 0, y: travelDirection * -24 }),
  };

  return (
    <motion.section
      custom={direction}
      variants={variants}
      initial={reduceMotion ? false : "enter"}
      animate="center"
      exit={reduceMotion ? undefined : "exit"}
      transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
      className={`${widthClass[width]} mx-auto w-full space-y-7 pb-8`}
    >
      <header className="mx-auto max-w-2xl text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description && <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>}
      </header>
      {children}
    </motion.section>
  );
}
