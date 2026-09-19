import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * The class merge every dashboard UI component uses: `clsx` for conditionals, `tailwind-merge`
 * so a caller's `className` actually wins over a variant's default (e.g. passing `rounded-full`
 * to a `Button` that ships `rounded-field`) instead of depending on stylesheet order.
 *
 * This is the one helper shadcn/ui requires; it is imported by every file under
 * `components/dashboard/ui/`. It is NOT used by any customer-facing component — those predate the
 * dashboard design system and compose Tailwind classes directly.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
