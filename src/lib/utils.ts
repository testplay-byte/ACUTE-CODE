import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Conditional class composition with Tailwind conflict resolution. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
